import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createTestOperator, createTestPlayer } from '../setup/factories';
import {
  accountBalance,
  assertOperatorLedgerBalanced,
  buildIntegrationApp,
  expectReconciled,
  fundPlayer,
  hubWallet,
  launchHub,
  ledgerCount,
  playerToken,
  promotionsOf,
  waitFor,
} from './helpers';

// (d) Contribución a un jackpot (HOUSE→JACKPOT_POOL) y pago (JACKPOT_POOL→PLAYER_CASH) con el ledger real.
// mustDropBy = semilla + 1 hace el disparo determinista: el punto de caída es exactamente semilla + 1.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

async function entriesByAccount(txId: string) {
  const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: txId }, include: { account: true } });
  return Object.fromEntries(entries.map((e) => [e.account.type, e.amount]));
}

describe('(d) Jackpot: contribución y pago sobre el ledger real', () => {
  it('semilla y contribución entran a JACKPOT_POOL; el disparo paga del pozo a PLAYER_CASH y se re-siembra', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    await fundPlayer(created, op.id, player.id, 'USD', 10_000n);
    const promo = promotionsOf(created);

    const jp = await promo.jackpots.create({
      operatorId: op.id,
      name: 'Jackpot s6',
      currency: 'USD',
      contributionBps: 1000, // 10 % de cada apuesta
      levels: [{ key: 'mini', seedAmount: 1_000n, shareBps: 10_000, triggerChancePpm: 0, mustDropBy: 1_001n }],
    });

    // Semilla: HOUSE → JACKPOT_POOL.
    expect(await accountBalance(op.id, 'JACKPOT_POOL', 'USD')).toBe(1_000n);
    expect(await ledgerCount(op.id, 'JACKPOT_CONTRIBUTION')).toBe(1);

    const session = await launchHub(created, playerToken(player.id, op.id), 'USD');
    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId: `r-${randomUUID()}`, amount: '1000' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    await created.services.bus.drain();

    const payouts = await waitFor(() => ledgerCount(op.id, 'JACKPOT_PAYOUT'), (n) => n >= 1);
    expect(payouts).toBe(1);

    // Contribución 100 (10 % de 1000) → pozo 1100 → paga 1100 → re-siembra 1000.
    const contributions = await prisma.ledgerTransaction.findMany({ where: { operatorId: op.id, type: 'JACKPOT_CONTRIBUTION' }, orderBy: { createdAt: 'asc' } });
    expect(contributions).toHaveLength(3); // semilla inicial + contribución + re-siembra
    const amounts = await Promise.all(contributions.map((c) => entriesByAccount(c.id)));
    expect(amounts.map((a) => a.JACKPOT_POOL).sort()).toEqual([100n, 1_000n, 1_000n].sort());
    for (const a of amounts) expect(a.HOUSE).toBe(-(a.JACKPOT_POOL as bigint));

    const payout = await prisma.ledgerTransaction.findFirstOrThrow({ where: { operatorId: op.id, type: 'JACKPOT_PAYOUT' } });
    expect(await entriesByAccount(payout.id)).toEqual({ JACKPOT_POOL: -1_100n, PLAYER_CASH: 1_100n });

    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(10_000n - 1_000n + 1_100n);
    expect(await accountBalance(op.id, 'JACKPOT_POOL', 'USD')).toBe(1_000n);
    expect(await accountBalance(op.id, 'HOUSE', 'USD')).toBe(1_000n - 1_000n - 100n - 1_000n);

    // El pozo del ledger coincide con el valor vivo del jackpot y con el informe del módulo.
    const live = await promo.jackpots.getScoped(op.id, jp.id);
    expect(live.levels.reduce((s, l) => s + l.currentAmount, 0n)).toBe(1_000n);
    const report = await promo.jackpots.report(op.id, jp.id);
    expect(report.balanced).toBe(true);
    expect(report.pools).toBe(1_000n);
    expect(report.recentWins[0]).toMatchObject({ status: 'PAID', amount: 1_100n, playerId: player.id });

    const byType = await assertOperatorLedgerBalanced(op.id);
    expect(byType).toMatchObject({ BET: 1, JACKPOT_CONTRIBUTION: 3, JACKPOT_PAYOUT: 1 });
    await expectReconciled(created, op.id);
  });

  it('un jackpot de otro operador no recibe contribuciones de este jugador', async () => {
    const opA = await createTestOperator();
    const opB = await createTestOperator();
    const player = await createTestPlayer(opA.id);
    await fundPlayer(created, opA.id, player.id, 'USD', 5_000n);
    const promo = promotionsOf(created);
    await promo.jackpots.create({
      operatorId: opB.id,
      name: 'Jackpot ajeno',
      currency: 'USD',
      contributionBps: 1000,
      levels: [{ key: 'mini', seedAmount: 1_000n, shareBps: 10_000, triggerChancePpm: 0, mustDropBy: 1_001n }],
    });
    const session = await launchHub(created, playerToken(player.id, opA.id), 'USD');
    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId: `r-${randomUUID()}`, amount: '1000' });
    expect(bet.status).toBe(200);
    await created.services.bus.drain();

    expect(await ledgerCount(opA.id, 'JACKPOT_CONTRIBUTION')).toBe(0);
    expect(await ledgerCount(opB.id, 'JACKPOT_CONTRIBUTION')).toBe(1); // solo la semilla
    expect(await ledgerCount(opB.id, 'JACKPOT_PAYOUT')).toBe(0);
    await assertOperatorLedgerBalanced(opA.id);
    await assertOperatorLedgerBalanced(opB.id);
    await expectReconciled(created, opA.id);
    await expectReconciled(created, opB.id);
  });
});
