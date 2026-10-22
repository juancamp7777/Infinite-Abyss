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
} from './helpers';

// (a) Seamless wallet del Hub (/hub/v1/wallet firmado con HMAC) contra la billetera Prisma real de la Fase 1.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

async function setup(funds = 10_000n) {
  const op = await createTestOperator();
  const player = await createTestPlayer(op.id);
  await fundPlayer(created, op.id, player.id, 'USD', funds);
  const session = await launchHub(created, playerToken(player.id, op.id), 'USD');
  return { op, player, session };
}

describe('(a) Hub /hub/v1/wallet sobre PrismaWalletService', () => {
  it('bet + win firmados mueven PLAYER_CASH y HOUSE con asientos que suman 0', async () => {
    const { op, player, session } = await setup(10_000n);
    const roundId = `r-${randomUUID()}`;

    const bal = await hubWallet(created, 'balance', { sessionToken: session });
    expect(bal.status).toBe(200);
    expect(bal.body).toMatchObject({ status: 'OK', balance: '10000' });

    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId, amount: '2500' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    expect(bet.body).toMatchObject({ status: 'OK', balance: '7500', cash: '7500', bonus: '0' });

    const win = await hubWallet(created, 'win', { sessionToken: session, transactionId: `w-${randomUUID()}`, roundId, amount: '4000' });
    expect(win.status, JSON.stringify(win.body)).toBe(200);
    expect(win.body).toMatchObject({ status: 'OK', balance: '11500' });

    // Saldo derivado del ledger = saldo de la billetera.
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(11_500n);
    // El fondeo sale de MANUAL_ADJUSTMENT; la casa recibe la apuesta y paga el premio.
    expect(await accountBalance(op.id, 'MANUAL_ADJUSTMENT', 'USD')).toBe(-10_000n);
    expect(await accountBalance(op.id, 'HOUSE', 'USD')).toBe(2_500n - 4_000n);
    expect((await created.services.walletService.getBalances({ operatorId: op.id, userId: player.id })).cash).toBe(11_500n);

    const byType = await assertOperatorLedgerBalanced(op.id);
    expect(byType).toMatchObject({ MANUAL_ADJUSTMENT: 1, BET: 1, WIN: 1 });
    await expectReconciled(created, op.id);
  });

  it('reintento idempotente de bet y win: mismo resultado y sin doble asiento', async () => {
    const { op, player, session } = await setup(5_000n);
    const roundId = `r-${randomUUID()}`;
    const betBody = { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId, amount: '1000' };

    const first = await hubWallet(created, 'bet', betBody);
    expect(first.status).toBe(200);
    const before = await ledgerCount(op.id);
    const retry = await hubWallet(created, 'bet', betBody);
    expect(retry.status).toBe(200);
    expect(retry.body.balance).toBe(first.body.balance);
    expect(retry.body.transactionId).toBe(first.body.transactionId);
    expect(await ledgerCount(op.id)).toBe(before);
    expect(await ledgerCount(op.id, 'BET')).toBe(1);

    const winBody = { sessionToken: session, transactionId: `w-${randomUUID()}`, roundId, amount: '300' };
    const w1 = await hubWallet(created, 'win', winBody);
    const w2 = await hubWallet(created, 'win', winBody);
    expect(w1.status).toBe(200);
    expect(w2.status).toBe(200);
    expect(w2.body.balance).toBe(w1.body.balance);
    expect(w2.body.transactionId).toBe(w1.body.transactionId);
    expect(await ledgerCount(op.id, 'WIN')).toBe(1);

    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(5_000n - 1_000n + 300n);
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });

  it('rollback de una apuesta revierte el asiento exacto (ROLLBACK) una sola vez', async () => {
    const { op, player, session } = await setup(3_000n);
    const roundId = `r-${randomUUID()}`;
    const betTx = `b-${randomUUID()}`;
    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: betTx, roundId, amount: '1200' });
    expect(bet.body.balance).toBe('1800');

    const rbBody = { sessionToken: session, transactionId: `rb-${randomUUID()}`, referenceTransactionId: betTx };
    const rb = await hubWallet(created, 'rollback', rbBody);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rb.body).toMatchObject({ status: 'OK', balance: '3000' });
    // Reintento del rollback: sin doble devolución.
    const rb2 = await hubWallet(created, 'rollback', rbBody);
    expect(rb2.status).toBe(200);
    expect(rb2.body.balance).toBe('3000');
    expect(await ledgerCount(op.id, 'ROLLBACK')).toBe(1);

    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(3_000n);
    expect(await accountBalance(op.id, 'HOUSE', 'USD')).toBe(0n);
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });

  it('firma inválida, saldo insuficiente y sesión de otro operador no tocan el ledger', async () => {
    const { op, player, session } = await setup(500n);
    const before = await ledgerCount(op.id);

    const forged = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId: 'r', amount: '100' }, 'otro-secreto-incorrecto-0123456789abcdef');
    expect(forged.status).toBe(401);

    const tooMuch = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId: 'r', amount: '501' });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.body.error?.code).toBe('INSUFFICIENT_FUNDS');

    const unknown = await hubWallet(created, 'bet', { sessionToken: 'sesion-inexistente', transactionId: `b-${randomUUID()}`, roundId: 'r', amount: '1' });
    expect(unknown.status).toBeGreaterThanOrEqual(400);

    expect(await ledgerCount(op.id)).toBe(before);
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(500n);
    // Ningún asiento del jugador fuera de su operador.
    const foreign = await prisma.ledgerEntry.count({ where: { account: { userId: player.id }, NOT: { operatorId: op.id } } });
    expect(foreign).toBe(0);
  });
});
