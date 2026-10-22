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
  hubWallet,
  launchHub,
  ledgerCount,
  playerToken,
  promotionsOf,
  waitFor,
} from './helpers';

// (c) Bono con wagering: grant (BONUS_EXPENSE→PLAYER_BONUS) → apuestas reales en el Hub hasta cumplir
// el wagering → conversión a cash (PLAYER_BONUS→PLAYER_CASH), todo sobre el ledger real.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

describe('(c) Bono con wagering → conversión a cash', () => {
  it('grant, apuestas que cumplen el wagering y conversión del saldo de bono a cash', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    const promo = promotionsOf(created);
    const code = `S6${randomUUID().slice(0, 8).toUpperCase()}`;

    await promo.bonuses.createTemplate({
      operatorId: op.id,
      name: 'Bono integración s6',
      type: 'promo_code',
      currency: 'USD',
      code,
      fixedAmount: 1_000n,
      wageringMultiplier: 2,
    });
    const bonus = await promo.bonuses.claim(op.id, player.id, code);
    expect(bonus.status).toBe('ACTIVE');
    expect(bonus.wageringRequired).toBe(2_000n);

    // Grant: BONUS_EXPENSE → PLAYER_BONUS.
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'USD', player.id)).toBe(1_000n);
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(0n);
    expect(await accountBalance(op.id, 'BONUS_EXPENSE', 'USD')).toBe(-1_000n);
    expect(await ledgerCount(op.id, 'BONUS_GRANT')).toBe(1);

    // Apuestas reales en el Hub: el bet gasta cash primero y luego bono; los premios van a cash.
    const session = await launchHub(created, playerToken(player.id, op.id), 'USD');
    for (let i = 0; i < 5; i++) {
      const roundId = `r-${randomUUID()}`;
      const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId, amount: '400' });
      expect(bet.status, JSON.stringify(bet.body)).toBe(200);
      await created.services.bus.drain();
      if (i < 4) {
        const win = await hubWallet(created, 'win', { sessionToken: session, transactionId: `w-${randomUUID()}`, roundId, amount: '400' });
        expect(win.status, JSON.stringify(win.body)).toBe(200);
        await created.services.bus.drain();
      }
    }

    const done = await waitFor(
      () => promo.bonuses.getBonus(bonus.id),
      (b) => b?.status === 'COMPLETED',
    );
    expect(done?.status).toBe('COMPLETED');
    expect(done?.wageringProgress).toBeGreaterThanOrEqual(2_000n);

    // 1ª apuesta: 400 de bono (queda 600). Las siguientes gastan el cash de los premios. Al cumplir el
    // wagering, los 600 de bono pasan a cash.
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'USD', player.id)).toBe(0n);
    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(600n);
    const balances = await created.services.walletService.getBalances({ operatorId: op.id, userId: player.id });
    expect(balances.cash).toBe(600n);
    expect(balances.bonus).toBe(0n);

    const converts = await prisma.ledgerTransaction.findMany({
      where: { operatorId: op.id, type: 'BONUS_CONVERT' },
      include: { entries: { include: { account: true } } },
    });
    expect(converts).toHaveLength(1);
    const lines = Object.fromEntries(converts[0].entries.map((e) => [e.account.type, e.amount]));
    expect(lines).toEqual({ PLAYER_BONUS: -600n, PLAYER_CASH: 600n });

    const byType = await assertOperatorLedgerBalanced(op.id);
    expect(byType).toMatchObject({ BONUS_GRANT: 1, BET: 5, WIN: 4, BONUS_CONVERT: 1 });
    await expectReconciled(created, op.id);
  });

  it('el reintento de claim con el mismo código no duplica el grant', async () => {
    const op = await createTestOperator();
    const player = await createTestPlayer(op.id);
    const promo = promotionsOf(created);
    const code = `S6${randomUUID().slice(0, 8).toUpperCase()}`;
    await promo.bonuses.createTemplate({ operatorId: op.id, name: 'Una vez', type: 'promo_code', currency: 'USD', code, fixedAmount: 500n, wageringMultiplier: 1, maxUsesPerPlayer: 1 });
    await promo.bonuses.claim(op.id, player.id, code);
    await expect(promo.bonuses.claim(op.id, player.id, code)).rejects.toBeTruthy();
    expect(await ledgerCount(op.id, 'BONUS_GRANT')).toBe(1);
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'USD', player.id)).toBe(500n);
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });
});
