import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createTestOperator, createTestPlayer } from '../setup/factories';
import {
  accountBalance,
  assertOperatorLedgerBalanced,
  bearer,
  buildIntegrationApp,
  expectReconciled,
  fundPlayer,
  ledgerCount,
  playerToken,
} from './helpers';

// (b) Rondas de un juego propio de Studios (nymfo-dice) por HTTP con la billetera Prisma real.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

describe('(b) Studios con la billetera real', () => {
  it('cada ronda debita la apuesta y acredita el premio; saldo, casa y ledger cuadran', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    await fundPlayer(created, op.id, player.id, 'USD', 50_000n);
    const token = playerToken(player.id, op.id);

    let totalBet = 0n;
    let totalWin = 0n;
    let winners = 0;
    let lastBalance = '';
    for (let i = 0; i < 6; i++) {
      const res = await request(created.app)
        .post('/studio/v1/play/nymfo-dice')
        .set(bearer(token))
        .send({ amount: '1000', currency: 'USD', params: { target: 50, over: true } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.round.status).toBe('SETTLED');
      totalBet += BigInt(res.body.round.bet);
      totalWin += BigInt(res.body.round.win);
      if (BigInt(res.body.round.win) > 0n) winners++;
      lastBalance = String(res.body.balance);
    }
    expect(totalBet).toBe(6_000n);

    const expectedCash = 50_000n - totalBet + totalWin;
    expect(BigInt(lastBalance)).toBe(expectedCash);
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(expectedCash);
    expect((await created.services.walletService.getBalances({ operatorId: op.id, userId: player.id })).cash).toBe(expectedCash);
    expect(await accountBalance(op.id, 'HOUSE', 'USD')).toBe(totalBet - totalWin);

    expect(await ledgerCount(op.id, 'BET')).toBe(6);
    expect(await ledgerCount(op.id, 'WIN')).toBe(winners);
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });

  it('repetir la jugada con el mismo roundId no vuelve a cobrar', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    await fundPlayer(created, op.id, player.id, 'USD', 5_000n);
    const token = playerToken(player.id, op.id);
    const body = { amount: '700', currency: 'USD', params: { target: 50, over: true }, roundId: randomUUID() };

    const first = await request(created.app).post('/studio/v1/play/nymfo-dice').set(bearer(token)).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const txBefore = await ledgerCount(op.id);
    const again = await request(created.app).post('/studio/v1/play/nymfo-dice').set(bearer(token)).send(body);
    expect(again.status).toBe(200);
    expect(again.body.round.id).toBe(first.body.round.id);
    expect(again.body.round.win).toBe(first.body.round.win);
    expect(await ledgerCount(op.id)).toBe(txBefore);
    expect(await ledgerCount(op.id, 'BET')).toBe(1);

    const cash = await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id);
    expect(cash).toBe(5_000n - 700n + BigInt(first.body.round.win));
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });

  it('sin saldo suficiente la ronda se rechaza y no deja asientos', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    await fundPlayer(created, op.id, player.id, 'USD', 300n);
    const before = await ledgerCount(op.id);
    const res = await request(created.app)
      .post('/studio/v1/play/nymfo-dice')
      .set(bearer(playerToken(player.id, op.id)))
      .send({ amount: '1000', currency: 'USD', params: { target: 50, over: true } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await ledgerCount(op.id)).toBe(before);
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(300n);
    await assertOperatorLedgerBalanced(op.id);
  });
});
