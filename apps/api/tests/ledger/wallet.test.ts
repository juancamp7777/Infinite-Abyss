import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { PrismaWalletService } from '../../src/infrastructure/ledger/PrismaWalletService';
import { AppError } from '../../src/domain/errors/AppError';
import { createTestOperator, createTestPlayer } from '../setup/factories';
import { derivedCash, fund, nonZeroTransactions, reconciliation, setup, wallet } from './helpers';

const rejects = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe('Ledger / WalletService', () => {
  it('suma cero tras depósito, apuestas, ganancias, rollback, retiro y ajuste', async () => {
    const { operator, player, currency } = await setup();
    const base = { operatorId: operator.id, userId: player.id, currency };
    await fund(operator.id, player.id, 10_000n);

    await wallet.placeBet({ ...base, amount: 500n, gameType: 'SLOTS', idempotencyKey: 'bet:SLOTS:u:1' });
    await wallet.settleWin({ ...base, amount: 900n, gameType: 'SLOTS', idempotencyKey: 'win:s1' });
    const bs = await wallet.betAndSettle({ ...base, betAmount: 200n, winAmount: 0n, gameType: 'PLINKO', idempotencyKey: 'bet:PLINKO:u:2' });
    expect(bs.winLedgerTransactionId).toBeNull();
    const bs2 = await wallet.betAndSettle({ ...base, betAmount: 100n, winAmount: 300n, gameType: 'PLINKO', idempotencyKey: 'bet:PLINKO:u:3' });
    expect(bs2.winLedgerTransactionId).not.toBeNull();

    // Rollback de una apuesta
    await wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'bet:SLOTS:u:1', idempotencyKey: 'rb:1', reason: 'error de proveedor' });

    // Retiro: reserva → liberación, y reserva → pago
    const w1 = randomUUID();
    await wallet.reserveWithdrawal({ ...base, amount: 1_000n, withdrawalId: w1, idempotencyKey: `wd-reserve:${w1}` });
    await wallet.releaseWithdrawal({ ...base, amount: 1_000n, withdrawalId: w1, idempotencyKey: `wd-release:${w1}` });
    const w2 = randomUUID();
    await wallet.reserveWithdrawal({ ...base, amount: 2_000n, withdrawalId: w2, idempotencyKey: `wd-reserve:${w2}` });
    await wallet.completeWithdrawal({ ...base, amount: 2_000n, withdrawalId: w2, idempotencyKey: `wd-payout:${w2}` });

    const bo = await prisma.backofficeUser.create({
      data: { email: `bo-${randomUUID()}@t.local`, passwordHash: 'x', role: 'OPERATOR_ADMIN', operatorId: operator.id },
    });
    await wallet.manualAdjustment({ ...base, amount: -50n, reason: 'corrección', actorBackofficeUserId: bo.id, idempotencyKey: `adj:${randomUUID()}` });

    expect(await nonZeroTransactions(operator.id)).toEqual([]);
    const report = await reconciliation.run({ operatorId: operator.id });
    expect(report.totalDiscrepancies, JSON.stringify(report.checks)).toBe(0);

    // 10000 -500 +900 -200 -100+300 +500(rollback) -2000 -50 = 8850
    const b = await wallet.getBalances({ operatorId: operator.id, userId: player.id });
    expect(b.cash).toBe(8_850n);
    expect(b.cash).toBe(await derivedCash(operator.id, player.id));
  });

  it('rollback: no se puede anular dos veces ni anular un rollback; replay con la misma clave', async () => {
    const { operator, player, currency } = await setup();
    const base = { operatorId: operator.id, userId: player.id, currency };
    await fund(operator.id, player.id, 1_000n);
    await wallet.placeBet({ ...base, amount: 100n, gameType: 'MINES', idempotencyKey: 'bet:1' });
    const rb = await wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'bet:1', idempotencyKey: 'rb:1', reason: 'x' });
    const again = await wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'bet:1', idempotencyKey: 'rb:1', reason: 'x' });
    expect(again.idempotentReplay).toBe(true);
    expect(again.ledgerTransactionId).toBe(rb.ledgerTransactionId);
    await rejects(wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'bet:1', idempotencyKey: 'rb:2', reason: 'x' }), 'CONFLICT');
    await rejects(wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'rb:1', idempotencyKey: 'rb:3', reason: 'x' }), 'CONFLICT');
    await rejects(wallet.rollback({ operatorId: operator.id, originalIdempotencyKey: 'nope', idempotencyKey: 'rb:4', reason: 'x' }), 'NOT_FOUND');
  });

  describe('idempotencia', () => {
    it('misma clave en serie: una sola transacción y mismo saldo', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency };
      await fund(operator.id, player.id, 1_000n);
      const input = { ...base, amount: 100n, gameType: 'SLOTS', idempotencyKey: 'bet:SLOTS:serial' };
      const a = await wallet.placeBet(input);
      const b = await wallet.placeBet(input);
      expect(a.idempotentReplay).toBe(false);
      expect(b.idempotentReplay).toBe(true);
      expect(b.ledgerTransactionId).toBe(a.ledgerTransactionId);
      expect(b.balance).toBe(900n);
      const count = await prisma.ledgerTransaction.count({ where: { operatorId: operator.id, idempotencyKey: 'bet:SLOTS:serial' } });
      expect(count).toBe(1);
    });

    it('misma clave en paralelo: una sola transacción', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency };
      await fund(operator.id, player.id, 1_000n);
      const input = { ...base, amount: 100n, gameType: 'SLOTS', idempotencyKey: 'bet:SLOTS:par' };
      const results = await Promise.all(Array.from({ length: 10 }, () => wallet.placeBet(input)));
      expect(new Set(results.map((r) => r.ledgerTransactionId)).size).toBe(1);
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      const b = await wallet.getBalances({ operatorId: operator.id, userId: player.id });
      expect(b.cash).toBe(900n);
    });

    it('misma clave con otro monto → CONFLICT (409)', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency };
      await fund(operator.id, player.id, 1_000n);
      await wallet.placeBet({ ...base, amount: 100n, gameType: 'SLOTS', idempotencyKey: 'bet:k' });
      const err = await wallet.placeBet({ ...base, amount: 200n, gameType: 'SLOTS', idempotencyKey: 'bet:k' }).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('CONFLICT');
    });

    it('un depósito reenviado (misma clave) no acredita dos veces', async () => {
      const { operator, player, currency } = await setup();
      const { deposit } = await fund(operator.id, player.id, 700n);
      const again = await wallet.creditDeposit({
        operatorId: operator.id, userId: player.id, currency, amount: 700n,
        depositId: deposit.id, provider: 'WOMPI', idempotencyKey: `deposit:${deposit.id}`,
      });
      expect(again.idempotentReplay).toBe(true);
      expect((await wallet.getBalances({ operatorId: operator.id, userId: player.id })).cash).toBe(700n);
      const dep = await prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
      expect(dep.status).toBe('CONFIRMED');
      expect(dep.ledgerTransactionId).toBe(again.ledgerTransactionId);
    });

    it('betAndSettle es idempotente y detecta payload distinto', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency, gameType: 'SLOTS' };
      await fund(operator.id, player.id, 1_000n);
      const input = { ...base, betAmount: 100n, winAmount: 250n, idempotencyKey: 'bet:SLOTS:bs' };
      const a = await wallet.betAndSettle(input);
      const b = await wallet.betAndSettle(input);
      expect(b.idempotentReplay).toBe(true);
      expect(b.winLedgerTransactionId).toBe(a.winLedgerTransactionId);
      expect(b.balance).toBe(1_150n);
      await rejects(wallet.betAndSettle({ ...input, winAmount: 0n }), 'CONFLICT');
    });
  });

  describe('concurrencia', () => {
    it('50 placeBet de 100 con saldo 1000: 10 aceptadas, 40 INSUFFICIENT_FUNDS, saldo 0', async () => {
      const { operator, player, currency } = await setup();
      await fund(operator.id, player.id, 1_000n);
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          wallet.placeBet({
            operatorId: operator.id, userId: player.id, currency, amount: 100n,
            gameType: 'CRASH', idempotencyKey: `bet:CRASH:${player.id}:${i}`,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(10);
      expect(failed).toHaveLength(40);
      for (const f of failed) expect(f.reason.code).toBe('INSUFFICIENT_FUNDS');

      const acc = await prisma.ledgerAccount.findFirstOrThrow({ where: { operatorId: operator.id, ownerKey: player.id, type: 'PLAYER_CASH' } });
      expect(acc.balance).toBe(0n);
      expect(await derivedCash(operator.id, player.id)).toBe(0n);
      expect((await reconciliation.run({ operatorId: operator.id })).totalDiscrepancies).toBe(0);
    });

    it('apuestas y ganancias mezcladas en paralelo mantienen el cuadre', async () => {
      const { operator, player, currency } = await setup();
      await fund(operator.id, player.id, 5_000n);
      await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          wallet.betAndSettle({
            operatorId: operator.id, userId: player.id, currency, gameType: 'PLINKO',
            betAmount: 300n, winAmount: i % 2 ? 450n : 0n, idempotencyKey: `bet:PLINKO:${i}`,
          }),
        ),
      );
      const b = await wallet.getBalances({ operatorId: operator.id, userId: player.id });
      expect(b.cash).toBeGreaterThanOrEqual(0n);
      expect(b.cash).toBe(await derivedCash(operator.id, player.id));
      expect((await reconciliation.run({ operatorId: operator.id })).totalDiscrepancies).toBe(0);
    });
  });

  describe('aislamiento y reglas', () => {
    it('operar con un userId de otro operador → FORBIDDEN', async () => {
      const a = await setup();
      const b = await setup();
      await fund(b.operator.id, b.player.id, 1_000n);
      const attempt = { operatorId: a.operator.id, userId: b.player.id, currency: 'USD' };
      await rejects(wallet.getBalances(attempt), 'FORBIDDEN');
      await rejects(wallet.placeBet({ ...attempt, amount: 10n, gameType: 'SLOTS', idempotencyKey: 'bet:x' }), 'FORBIDDEN');
      await rejects(wallet.creditDeposit({ ...attempt, amount: 10n, depositId: randomUUID(), provider: 'WOMPI', idempotencyKey: 'dep:x' }), 'FORBIDDEN');
      await rejects(wallet.manualAdjustment({ ...attempt, amount: 10n, reason: 'x', actorBackofficeUserId: randomUUID(), idempotencyKey: 'adj:x' }), 'FORBIDDEN');
      expect((await wallet.getBalances({ operatorId: b.operator.id, userId: b.player.id })).cash).toBe(1_000n);
    });

    it('la misma idempotencyKey en operadores distintos son independientes', async () => {
      const a = await setup();
      const b = await setup();
      await fund(a.operator.id, a.player.id, 1_000n);
      await fund(b.operator.id, b.player.id, 1_000n);
      await wallet.placeBet({ operatorId: a.operator.id, userId: a.player.id, currency: 'USD', amount: 100n, gameType: 'SLOTS', idempotencyKey: 'same' });
      const r = await wallet.placeBet({ operatorId: b.operator.id, userId: b.player.id, currency: 'USD', amount: 100n, gameType: 'SLOTS', idempotencyKey: 'same' });
      expect(r.idempotentReplay).toBe(false);
    });

    it('rechaza jugadores no ACTIVE, monedas distintas y montos inválidos', async () => {
      const { operator, currency } = await setup();
      const suspended = await createTestPlayer(operator.id, { status: 'SUSPENDED' });
      await rejects(wallet.placeBet({ operatorId: operator.id, userId: suspended.id, currency, amount: 1n, gameType: 'SLOTS', idempotencyKey: 'bet:s' }), 'FORBIDDEN');
      const ok = await createTestPlayer(operator.id);
      await rejects(wallet.placeBet({ operatorId: operator.id, userId: ok.id, currency: 'EUR', amount: 1n, gameType: 'SLOTS', idempotencyKey: 'bet:c' }), 'VALIDATION_ERROR');
      await rejects(wallet.placeBet({ operatorId: operator.id, userId: ok.id, currency, amount: 0n, gameType: 'SLOTS', idempotencyKey: 'bet:z' }), 'VALIDATION_ERROR');
      await rejects(wallet.placeBet({ operatorId: operator.id, userId: ok.id, currency, amount: 5n, gameType: 'SLOTS', idempotencyKey: 'bet:f' }), 'INSUFFICIENT_FUNDS');
    });

    it('la política de juego responsable se invoca antes de apostar y puede rechazar', async () => {
      const { operator, player, currency } = await setup();
      await fund(operator.id, player.id, 1_000n);
      const calls: bigint[] = [];
      const strict = new PrismaWalletService(prisma, {
        assertCanDeposit: async () => {},
        assertCanWithdraw: async () => {},
        assertCanBet: async (_ctx, amount) => {
          calls.push(amount);
          throw AppError.limitExceeded();
        },
      });
      await rejects(strict.placeBet({ operatorId: operator.id, userId: player.id, currency, amount: 10n, gameType: 'SLOTS', idempotencyKey: 'bet:p' }), 'LIMIT_EXCEEDED');
      await rejects(strict.betAndSettle({ operatorId: operator.id, userId: player.id, currency, betAmount: 10n, winAmount: 0n, gameType: 'SLOTS', idempotencyKey: 'bet:q' }), 'LIMIT_EXCEEDED');
      expect(calls).toEqual([10n, 10n]);
    });

    it('manualAdjustment exige motivo y actor; escribe AuditLog; no deja saldo negativo', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency };
      const actor = randomUUID();
      await rejects(wallet.manualAdjustment({ ...base, amount: 10n, reason: '   ', actorBackofficeUserId: actor, idempotencyKey: 'adj:1' }), 'VALIDATION_ERROR');
      await rejects(wallet.manualAdjustment({ ...base, amount: 10n, reason: 'ok', actorBackofficeUserId: '', idempotencyKey: 'adj:2' }), 'VALIDATION_ERROR');
      await rejects(wallet.manualAdjustment({ ...base, amount: -10n, reason: 'ok', actorBackofficeUserId: actor, idempotencyKey: 'adj:3' }), 'INSUFFICIENT_FUNDS');
      const r = await wallet.manualAdjustment({ ...base, amount: 500n, reason: 'regalo', actorBackofficeUserId: actor, idempotencyKey: 'adj:4' });
      await wallet.manualAdjustment({ ...base, amount: 500n, reason: 'regalo', actorBackofficeUserId: actor, idempotencyKey: 'adj:4' });
      expect(r.balance).toBe(500n);
      const logs = await prisma.auditLog.findMany({ where: { operatorId: operator.id, targetId: player.id } });
      expect(logs).toHaveLength(1);
      expect(logs[0].reason).toBe('regalo');
      expect(logs[0].actorId).toBe(actor);
    });

    it('creditDemo solo para jugadores demo', async () => {
      const { operator, currency } = await setup();
      const real = await createTestPlayer(operator.id);
      const demo = await createTestPlayer(operator.id, { isDemo: true });
      await rejects(wallet.creditDemo({ operatorId: operator.id, userId: real.id, currency, amount: 100n, idempotencyKey: 'demo:1' }), 'FORBIDDEN');
      const r = await wallet.creditDemo({ operatorId: operator.id, userId: demo.id, currency, amount: 100n, idempotencyKey: 'demo:2' });
      expect(r.balance).toBe(100n);
      expect((await reconciliation.run({ operatorId: operator.id })).totalDiscrepancies).toBe(0);
    });

    it('retiros: liberar/pagar mueve exactamente lo reservado y no se liquida dos veces', async () => {
      const { operator, player, currency } = await setup();
      const base = { operatorId: operator.id, userId: player.id, currency };
      await fund(operator.id, player.id, 1_000n);
      const w = randomUUID();
      const r = await wallet.reserveWithdrawal({ ...base, amount: 400n, withdrawalId: w, idempotencyKey: `wd-reserve:${w}` });
      expect(r.balance).toBe(600n);
      await rejects(wallet.reserveWithdrawal({ ...base, amount: 9_999n, withdrawalId: randomUUID(), idempotencyKey: 'wd-reserve:big' }), 'INSUFFICIENT_FUNDS');
      await rejects(wallet.completeWithdrawal({ ...base, amount: 300n, withdrawalId: w, idempotencyKey: `wd-payout:${w}` }), 'CONFLICT');
      await rejects(wallet.releaseWithdrawal({ ...base, amount: 400n, withdrawalId: randomUUID(), idempotencyKey: 'wd-release:none' }), 'NOT_FOUND');
      await wallet.completeWithdrawal({ ...base, amount: 400n, withdrawalId: w, idempotencyKey: `wd-payout:${w}` });
      await rejects(wallet.releaseWithdrawal({ ...base, amount: 400n, withdrawalId: w, idempotencyKey: `wd-release:${w}` }), 'CONFLICT');
      const pending = await prisma.ledgerAccount.findFirstOrThrow({ where: { operatorId: operator.id, type: 'WITHDRAWAL_PENDING' } });
      expect(pending.balance).toBe(0n);
      expect((await reconciliation.run({ operatorId: operator.id })).totalDiscrepancies).toBe(0);
    });

    it('settleWin con 0 no crea movimiento', async () => {
      const { operator, player, currency } = await setup();
      const r = await wallet.settleWin({ operatorId: operator.id, userId: player.id, currency, amount: 0n, gameType: 'SLOTS', idempotencyKey: 'win:0' });
      expect(r.ledgerTransactionId).toBe('');
      expect(await prisma.ledgerTransaction.count({ where: { operatorId: operator.id } })).toBe(0);
    });
  });

  it('createTestOperator crea operadores independientes (sanity)', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    expect(a.id).not.toBe(b.id);
  });
});
