import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import type { LedgerAccountType } from '@prisma/client';
import { createApp, type CreatedApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { JwtService } from '../../src/infrastructure/auth/JwtService';
import { signHmacSha256 } from '../../src/modules/shared/crypto/hmac';
import type { PromotionsFacade } from '../../src/modules/promotions';
import { createBackofficeUser } from '../setup/factories';

/** Secreto HMAC de PRUEBA del mock-provider del Hub (no es un secreto real). */
export const HUB_TEST_SECRET = 'test-only-hub-mock-provider-secret-s6-0123456789';
export const HUB_PROVIDER = 'mock-provider';
export const HUB_GAME = 'mock-provider-mp-golden-oasis';

export const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET!, accessTtl: '15m' });
export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
export const playerToken = (userId: string, operatorId: string) => jwt.signAccess({ sub: userId, op: operatorId, typ: 'player' });

/** createApp real (Fase 1 + módulos) con temporizadores apagados. */
export async function buildIntegrationApp(overrides: Parameters<typeof createApp>[1] = {}): Promise<CreatedApp> {
  const created = createApp(getConfig(), {
    bcryptCost: 4,
    rateLimit: { disabled: true },
    ...overrides,
    moduleEnv: {
      HUB_PROVIDER_MOCK_PROVIDER_SECRET: HUB_TEST_SECRET,
      MKT_SCHEDULER: 'off',
      STUDIO_CRASH_LIVE: 'false',
      PROMO_TICK_INTERVAL_MS: '0',
      TIDE_TICK_MS: '0',
      PEARL_TICK_MS: '0',
      CREW_TICK_MS: '0',
      LEVIATHAN_TICK_MS: '0',
      ...(overrides.moduleEnv ?? {}),
    },
  });
  await created.ready;
  return created;
}

export function promotionsOf(created: CreatedApp): PromotionsFacade {
  const p = created.services.modules['promotions'] as PromotionsFacade | undefined;
  if (!p) throw new Error('El módulo promotions no está montado');
  return p;
}

/** Fondea al jugador con un ajuste manual del backoffice (asiento real HOUSE → PLAYER_CASH). */
export async function fundPlayer(created: CreatedApp, operatorId: string, userId: string, currency: string, amount: bigint) {
  const admin = await createBackofficeUser('OPERATOR_ADMIN', operatorId);
  await created.services.walletService.manualAdjustment({
    operatorId,
    userId,
    currency,
    amount,
    reason: 'Fondeo de prueba de integración',
    actorBackofficeUserId: admin.id,
    idempotencyKey: `fund:${randomUUID()}`,
  });
}

// ───────────── Hub: llamadas de billetera firmadas ─────────────

export async function launchHub(created: CreatedApp, token: string, currency: string): Promise<string> {
  const res = await request(created.app).post(`/hub/v1/games/${HUB_GAME}/launch`).set(bearer(token)).send({ mode: 'real', currency });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const session = new URL(res.body.url, 'http://x').searchParams.get('session');
  expect(session).toBeTruthy();
  return session!;
}

export function hubWallet(created: CreatedApp, action: 'balance' | 'bet' | 'win' | 'rollback', body: Record<string, unknown>, secret = HUB_TEST_SECRET) {
  const raw = JSON.stringify(body);
  return request(created.app)
    .post(`/hub/v1/wallet/${action}`)
    .set('Content-Type', 'application/json')
    .set('X-Provider-Id', HUB_PROVIDER)
    .set('X-Signature', signHmacSha256(secret, raw))
    .send(raw);
}

// ───────────── Ledger ─────────────

export async function accountBalance(operatorId: string, type: LedgerAccountType, currency: string, userId?: string): Promise<bigint> {
  const accounts = await prisma.ledgerAccount.findMany({
    where: { operatorId, type, currency, ...(userId ? { userId } : {}) },
    select: { id: true },
  });
  if (accounts.length === 0) return 0n;
  const agg = await prisma.ledgerEntry.aggregate({ where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { amount: true } });
  return agg._sum.amount ?? 0n;
}

/** Comprueba que TODAS las LedgerTransaction del operador suman 0 y devuelve cuántas hay por tipo. */
export async function assertOperatorLedgerBalanced(operatorId: string): Promise<Record<string, number>> {
  const txs = await prisma.ledgerTransaction.findMany({ where: { operatorId }, include: { entries: true } });
  const byType: Record<string, number> = {};
  for (const tx of txs) {
    const sum = tx.entries.reduce((s, e) => s + e.amount, 0n);
    expect(sum, `LedgerTransaction ${tx.id} (${tx.type}) no suma 0`).toBe(0n);
    expect(tx.entries.length, `LedgerTransaction ${tx.id} sin asientos`).toBeGreaterThanOrEqual(2);
    for (const e of tx.entries) expect(e.operatorId).toBe(operatorId);
    byType[tx.type] = (byType[tx.type] ?? 0) + 1;
  }
  return byType;
}

export async function ledgerCount(operatorId: string, type?: string): Promise<number> {
  return prisma.ledgerTransaction.count({ where: { operatorId, ...(type ? { type: type as never } : {}) } });
}

/** Espera a que una condición asíncrona se cumpla (los consumidores del bus corren tras el commit). */
export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function expectReconciled(created: CreatedApp, operatorId: string) {
  const report = await created.services.reconciliationService.run({ operatorId });
  expect(report.totalDiscrepancies, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(0);
  return report;
}
