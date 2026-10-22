import { describe, expect, it } from 'vitest';
import type { PlayerAuth } from '../../src/domain/contracts';
import { prisma } from '../../src/infrastructure/database/prisma';
import { ResponsibleGamingPolicy } from '../../src/application/responsible-gaming/ResponsibleGamingPolicy';
import { ResponsibleGamingService } from '../../src/application/responsible-gaming/ResponsibleGamingService';
import { createTestOperator, createTestPlayer } from '../setup/factories';

const policy = new ResponsibleGamingPolicy(prisma);
const service = new ResponsibleGamingService(prisma);

async function setup(playerOverrides: Parameters<typeof createTestPlayer>[1] = {}) {
  const op = await createTestOperator();
  const user = await createTestPlayer(op.id, playerOverrides);
  const ctx: PlayerAuth = { kind: 'player', userId: user.id, operatorId: op.id, currency: 'USD', isDemo: user.isDemo };
  return { op, user, ctx };
}

async function confirmedDeposit(opId: string, userId: string, amount: bigint) {
  await prisma.deposit.create({
    data: {
      operatorId: opId,
      userId,
      provider: 'PASSIMPAY',
      status: 'CONFIRMED',
      amount,
      currency: 'USD',
      providerReference: `ref-${userId}-${Math.random().toString(36).slice(2)}`,
      confirmedAt: new Date(),
    },
  });
}

/** Inserta un asiento BET/WIN directo (INSERT está permitido; el ledger solo es inmutable ante UPDATE/DELETE). */
async function ledgerMove(opId: string, userId: string, type: 'BET' | 'WIN', amountAbs: bigint) {
  const cash = await prisma.ledgerAccount.upsert({
    where: { operatorId_ownerKey_type_currency: { operatorId: opId, ownerKey: userId, type: 'PLAYER_CASH', currency: 'USD' } },
    create: { operatorId: opId, ownerType: 'PLAYER', userId, ownerKey: userId, type: 'PLAYER_CASH', currency: 'USD' },
    update: {},
  });
  const house = await prisma.ledgerAccount.upsert({
    where: { operatorId_ownerKey_type_currency: { operatorId: opId, ownerKey: 'OPERATOR', type: 'HOUSE', currency: 'USD' } },
    create: { operatorId: opId, ownerType: 'OPERATOR', ownerKey: 'OPERATOR', type: 'HOUSE', currency: 'USD' },
    update: {},
  });
  const sign = type === 'BET' ? -1n : 1n;
  await prisma.ledgerTransaction.create({
    data: {
      operatorId: opId,
      type,
      idempotencyKey: `test:${type}:${userId}:${Math.random().toString(36).slice(2)}`,
      currency: 'USD',
      entries: {
        create: [
          { operatorId: opId, accountId: cash.id, amount: sign * amountAbs, currency: 'USD' },
          { operatorId: opId, accountId: house.id, amount: -sign * amountAbs, currency: 'USD' },
        ],
      },
    },
  });
}

describe('autoexclusión y cool-off', () => {
  it('autoexcluido no puede apostar ni depositar, pero sí retirar si cumple KYC', async () => {
    const { ctx } = await setup({ kycStatus: 'VERIFIED' });
    await service.selfExclude(ctx.userId, ctx.operatorId, { days: 30 });
    await expect(policy.assertCanBet(ctx, 100n)).rejects.toMatchObject({ code: 'SELF_EXCLUDED' });
    await expect(policy.assertCanDeposit(ctx, 100n)).rejects.toMatchObject({ code: 'SELF_EXCLUDED' });
    await expect(policy.assertCanWithdraw(ctx)).resolves.toBeUndefined();
  });

  it('no se puede acortar ni revertir; la permanente bloquea siempre', async () => {
    const { ctx } = await setup();
    const a = await service.selfExclude(ctx.userId, ctx.operatorId, { days: 30 });
    const b = await service.selfExclude(ctx.userId, ctx.operatorId, { days: 1 });
    expect(b.selfExcludedUntil).toBe(a.selfExcludedUntil);
    await service.selfExclude(ctx.userId, ctx.operatorId, { permanent: true });
    const later = new ResponsibleGamingPolicy(prisma, { now: () => new Date(Date.now() + 400 * 86_400_000) });
    await expect(later.assertCanBet(ctx, 1n)).rejects.toMatchObject({ code: 'SELF_EXCLUDED' });
  });

  it('cool-off bloquea apuestas y expira', async () => {
    const { ctx } = await setup();
    await service.coolOff(ctx.userId, ctx.operatorId, 24);
    await expect(policy.assertCanBet(ctx, 1n)).rejects.toMatchObject({ code: 'SELF_EXCLUDED' });
    const later = new ResponsibleGamingPolicy(prisma, { now: () => new Date(Date.now() + 25 * 3_600_000) });
    await expect(later.assertCanBet(ctx, 1n)).resolves.toBeUndefined();
  });
});

describe('límites de depósito y pérdida', () => {
  it('límite de depósito diario: suma confirmados + monto pedido', async () => {
    const { op, ctx } = await setup();
    await service.updateLimits(ctx.userId, ctx.operatorId, { depositLimitDaily: '1000' });
    await confirmedDeposit(op.id, ctx.userId, 900n);
    await expect(policy.assertCanDeposit(ctx, 200n)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(policy.assertCanDeposit(ctx, 100n)).resolves.toBeUndefined();
  });

  it('límite de pérdida: apuestas − ganancias del periodo', async () => {
    const { op, ctx } = await setup();
    await service.updateLimits(ctx.userId, ctx.operatorId, { lossLimitDaily: '1000' });
    await ledgerMove(op.id, ctx.userId, 'BET', 800n);
    await expect(policy.assertCanBet(ctx, 300n)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(policy.assertCanBet(ctx, 200n)).resolves.toBeUndefined();
    await ledgerMove(op.id, ctx.userId, 'WIN', 500n); // pérdida neta 300
    await expect(policy.assertCanBet(ctx, 700n)).resolves.toBeUndefined();
    await expect(policy.assertCanBet(ctx, 701n)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('límite de tiempo de sesión', async () => {
    const { op, ctx } = await setup();
    await service.updateLimits(ctx.userId, ctx.operatorId, { sessionTimeLimitMinutes: 60 });
    await prisma.playerSession.create({
      data: { userId: ctx.userId, operatorId: op.id, startedAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    await expect(policy.assertCanBet(ctx, 1n)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('cambios de límite', () => {
  it('subida queda pendiente 24 h; bajada es inmediata y cancela la pendiente', async () => {
    const { ctx } = await setup();
    await service.updateLimits(ctx.userId, ctx.operatorId, { depositLimitDaily: '1000' });

    const up = await service.updateLimits(ctx.userId, ctx.operatorId, { depositLimitDaily: '5000' });
    expect(up.limits.depositLimitDaily).toBe('1000');
    expect(up.pendingIncreases.depositLimitDaily?.value).toBe('5000');
    // Aún no efectiva: el límite vigente es 1000.
    await expect(policy.assertCanDeposit(ctx, 2000n)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });

    // Pasadas 24 h se aplica.
    const later = new ResponsibleGamingPolicy(prisma, { now: () => new Date(Date.now() + 25 * 3_600_000) });
    await expect(later.assertCanDeposit(ctx, 2000n)).resolves.toBeUndefined();
    const after = await service.getLimits(ctx.userId, ctx.operatorId);
    expect(after.limits.depositLimitDaily).toBe('5000');
    expect(after.pendingIncreases.depositLimitDaily).toBeUndefined();

    // Otra subida y luego una bajada: la bajada cancela la pendiente.
    await service.updateLimits(ctx.userId, ctx.operatorId, { depositLimitDaily: '9000' });
    const down = await service.updateLimits(ctx.userId, ctx.operatorId, { depositLimitDaily: '100' });
    expect(down.limits.depositLimitDaily).toBe('100');
    expect(down.pendingIncreases.depositLimitDaily).toBeUndefined();
  });

  it('quitar un límite también espera 24 h', async () => {
    const { ctx } = await setup();
    await service.updateLimits(ctx.userId, ctx.operatorId, { lossLimitWeekly: '100' });
    const r = await service.updateLimits(ctx.userId, ctx.operatorId, { lossLimitWeekly: null });
    expect(r.limits.lossLimitWeekly).toBe('100');
    expect(r.pendingIncreases.lossLimitWeekly?.value).toBeNull();
  });
});

describe('retiros y KYC', () => {
  it('sin KYC → KYC_REQUIRED; VERIFIED pasa; demo prohibido', async () => {
    const { ctx } = await setup();
    await expect(policy.assertCanWithdraw(ctx)).rejects.toMatchObject({ code: 'KYC_REQUIRED' });
    expect(await service.submitKyc(ctx.userId, ctx.operatorId)).toEqual({ kycStatus: 'PENDING' });
    await expect(service.submitKyc(ctx.userId, ctx.operatorId)).rejects.toMatchObject({ statusCode: 409 });
    await expect(policy.assertCanWithdraw(ctx)).rejects.toMatchObject({ code: 'KYC_REQUIRED' });

    const v = await setup({ kycStatus: 'VERIFIED' });
    await expect(policy.assertCanWithdraw(v.ctx)).resolves.toBeUndefined();
    const d = await setup({ kycStatus: 'VERIFIED', isDemo: true });
    await expect(policy.assertCanWithdraw(d.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
