import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createModuleWalletAdapters } from '../../src/infrastructure/modules/wallet';
import { WalletError, isWalletError } from '../../src/modules/shared/ports/WalletPort';
import type { PlayerBonus } from '../../src/modules/promotions/domain/bonus';
import { withJackpotLedger } from '../../src/modules/promotions/application/JackpotLedger';
import { InMemoryJackpotRepository } from '../../src/modules/promotions/infrastructure/memory/InMemoryJackpotRepository';
import { AppError } from '../../src/domain/errors/AppError';
import { fund, nonZeroTransactions, reconciliation, setup, wallet } from './helpers';

const adapters = createModuleWalletAdapters({ prisma, wallet });
const port = adapters.wallet;

const operatorsUsed: string[] = [];

async function ctx(cash = 10_000n) {
  const { operator, player, currency } = await setup('USD');
  operatorsUsed.push(operator.id);
  if (cash > 0n) await fund(operator.id, player.id, cash, currency);
  return { operatorId: operator.id, playerId: player.id, currency };
}

async function operatorAccount(operatorId: string, type: string): Promise<bigint> {
  const rows = await prisma.ledgerAccount.findMany({ where: { operatorId, type: type as never } });
  return rows.reduce((s, r) => s + r.balance, 0n);
}

async function txOf(operatorId: string, txId: string) {
  return prisma.ledgerTransaction.findFirstOrThrow({ where: { id: txId, operatorId }, include: { entries: { include: { account: true } } } });
}

const bonus = (c: { operatorId: string; playerId: string; currency: string }): PlayerBonus =>
  ({ id: randomUUID(), operatorId: c.operatorId, playerId: c.playerId, currency: c.currency }) as unknown as PlayerBonus;

const key = (p: string) => `${p}:${randomUUID()}`;

afterEach(async () => {
  // Tras cada escenario: cada tx suma 0 y la reconciliación de la Fase 1 no encuentra discrepancias.
  for (const op of operatorsUsed.splice(0)) {
    expect(await nonZeroTransactions(op)).toEqual([]);
    const r = await reconciliation.run({ operatorId: op });
    expect(r.totalDiscrepancies).toBe(0);
  }
});

describe('Adaptador WalletPort de módulos sobre el ledger Prisma', () => {
  it('bet/win: PLAYER_CASH → HOUSE y HOUSE → PLAYER_CASH', async () => {
    const c = await ctx();
    const ref = { provider: 'hub', gameId: 'slot-1', roundId: 'r1' };
    const bet = await port.debit({ ...c, amount: 300n, idempotencyKey: key('bet'), reason: 'BET', ref });
    expect(bet.balance).toBe(9_700n);
    const win = await port.credit({ ...c, amount: 1_000n, idempotencyKey: key('win'), reason: 'WIN', ref });
    expect(win.balance).toBe(10_700n);
    const betTx = await txOf(c.operatorId, bet.txId);
    expect(betTx.type).toBe('BET');
    expect(betTx.entries.map((e) => [e.account.type, e.amount]).sort()).toEqual([['HOUSE', 300n], ['PLAYER_CASH', -300n]]);
    expect((await txOf(c.operatorId, win.txId)).type).toBe('WIN');
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 10_700n, bonus: 0n });
  });

  it('reintento idempotente devuelve el mismo txId y no duplica; otro payload → IDEMPOTENCY_CONFLICT', async () => {
    const c = await ctx();
    const k = key('bet');
    const ref = { provider: 'hub', gameId: 'slot-1', roundId: 'r2' };
    const a = await port.debit({ ...c, amount: 500n, idempotencyKey: k, reason: 'BET', ref });
    const b = await port.debit({ ...c, amount: 500n, idempotencyKey: k, reason: 'BET', ref });
    expect(b.txId).toBe(a.txId);
    expect((await port.getBalance(c.operatorId, c.playerId, 'USD')).cash).toBe(9_500n);
    expect(await prisma.ledgerTransaction.count({ where: { operatorId: c.operatorId, idempotencyKey: k } })).toBe(1);

    await expect(port.debit({ ...c, amount: 501n, idempotencyKey: k, reason: 'BET', ref })).rejects.toSatisfy((e) =>
      isWalletError(e, 'IDEMPOTENCY_CONFLICT'),
    );
    await expect(port.debit({ ...c, amount: 500n, idempotencyKey: k, reason: 'BET', ref: { ...ref, roundId: 'otro' } })).rejects.toSatisfy(
      (e) => isWalletError(e, 'IDEMPOTENCY_CONFLICT'),
    );
    await expect(port.credit({ ...c, amount: 500n, idempotencyKey: k, reason: 'WIN', ref })).rejects.toSatisfy((e) =>
      isWalletError(e, 'IDEMPOTENCY_CONFLICT'),
    );
  });

  it('rollback por clave original revierte exacto, es idempotente y no se repite', async () => {
    const c = await ctx();
    const k = key('bet');
    await port.debit({ ...c, amount: 2_000n, idempotencyKey: k, reason: 'BET', ref: { gameId: 'g', roundId: 'r3' } });
    const rk = key('rb');
    const rb = await port.rollback({ operatorId: c.operatorId, playerId: c.playerId, originalIdempotencyKey: k, idempotencyKey: rk });
    expect(rb.balance).toBe(10_000n);
    const again = await port.rollback({ operatorId: c.operatorId, playerId: c.playerId, originalIdempotencyKey: k, idempotencyKey: rk });
    expect(again.txId).toBe(rb.txId);
    await expect(
      port.rollback({ operatorId: c.operatorId, playerId: c.playerId, originalIdempotencyKey: k, idempotencyKey: key('rb') }),
    ).rejects.toSatisfy((e) => isWalletError(e, 'ALREADY_ROLLED_BACK'));
    await expect(
      port.rollback({ operatorId: c.operatorId, playerId: c.playerId, originalIdempotencyKey: 'no-existe', idempotencyKey: key('rb') }),
    ).rejects.toSatisfy((e) => isWalletError(e, 'UNKNOWN_TRANSACTION'));
    expect((await txOf(c.operatorId, rb.txId)).type).toBe('ROLLBACK');
  });

  it('REFUND devuelve a las cuentas de la apuesta original de la ronda; sin apuesta, HOUSE → CASH', async () => {
    const c = await ctx(100n);
    await adapters.bonusFunds.grant(bonus(c), 400n);
    const ref = { provider: 'hub', gameId: 'slot-9', roundId: 'r-refund' };
    await port.debit({ ...c, amount: 300n, idempotencyKey: key('bet'), reason: 'BET', ref }); // 100 cash + 200 bono
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 0n, bonus: 200n });
    const r = await port.credit({ ...c, amount: 300n, idempotencyKey: key('refund'), reason: 'REFUND', ref });
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 100n, bonus: 400n });
    expect((await txOf(c.operatorId, r.txId)).type).toBe('REFUND');

    await port.credit({ ...c, amount: 50n, idempotencyKey: key('refund'), reason: 'REFUND', ref: { roundId: 'sin-apuesta' } });
    expect((await port.getBalance(c.operatorId, c.playerId, 'USD')).cash).toBe(150n);
  });

  it('aislamiento entre operadores: jugador de otro operador → FORBIDDEN', async () => {
    const a = await ctx();
    const b = await ctx();
    const attempt = port.debit({ operatorId: b.operatorId, playerId: a.playerId, currency: 'USD', amount: 10n, idempotencyKey: key('x'), reason: 'BET', ref: {} });
    await expect(attempt).rejects.toSatisfy((e) => e instanceof AppError && e.code === 'FORBIDDEN');
    await expect(port.getBalance(b.operatorId, a.playerId, 'USD')).rejects.toSatisfy((e) => e instanceof AppError && e.code === 'FORBIDDEN');
    // Rollback de una tx del operador A pedido desde B no la encuentra.
    const k = key('bet');
    await port.debit({ ...a, amount: 10n, idempotencyKey: k, reason: 'BET', ref: {} });
    await expect(
      port.rollback({ operatorId: b.operatorId, playerId: b.playerId, originalIdempotencyKey: k, idempotencyKey: key('rb') }),
    ).rejects.toSatisfy((e) => isWalletError(e, 'UNKNOWN_TRANSACTION'));
    expect((await port.getBalance(a.operatorId, a.playerId, 'USD')).cash).toBe(9_990n);
  });

  it('fondos insuficientes → INSUFFICIENT_FUNDS sin movimiento; monto inválido → INVALID_AMOUNT; OTHER sin gameId rechazado', async () => {
    const c = await ctx(100n);
    await expect(port.debit({ ...c, amount: 101n, idempotencyKey: key('bet'), reason: 'BET', ref: {} })).rejects.toSatisfy((e) =>
      isWalletError(e, 'INSUFFICIENT_FUNDS'),
    );
    await expect(port.debit({ ...c, amount: 0n, idempotencyKey: key('bet'), reason: 'BET', ref: {} })).rejects.toBeInstanceOf(WalletError);
    await expect(port.debit({ ...c, amount: 10n, idempotencyKey: key('o'), reason: 'OTHER', ref: { gameId: 'x' } })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'VALIDATION_ERROR',
    );
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 100n, bonus: 0n });
  });

  it('bono: grant → apuesta con bono → convert → forfeit (BonusFundsPort y convenciones de gameId)', async () => {
    const c = await ctx(0n);
    const b1 = bonus(c);
    const g = await adapters.bonusFunds.grant(b1, 1_000n);
    expect((await txOf(c.operatorId, g.txId)).type).toBe('BONUS_GRANT');
    // Reintento idempotente por la clave promo:bonus:<id>:grant (mismo payload por el otro camino).
    const g2 = await port.credit({ ...c, amount: 1_000n, idempotencyKey: `promo:bonus:${b1.id}:grant`, reason: 'BONUS_GRANT', ref: { provider: 'nymfo-promotions', gameId: 'bonus-grant', roundId: b1.id } });
    expect(g2.txId).toBe(g.txId);
    expect(await adapters.bonusFunds.bonusBalance(c.operatorId, c.playerId, 'USD')).toBe(1_000n);
    expect(await operatorAccount(c.operatorId, 'BONUS_EXPENSE')).toBe(-1_000n);

    await port.debit({ ...c, amount: 200n, idempotencyKey: key('bet'), reason: 'BET', ref: { roundId: 'rb1' } });
    const conv = await adapters.bonusFunds.convert(b1, 600n);
    const convTx = await txOf(c.operatorId, conv.txId);
    expect(convTx.type).toBe('BONUS_CONVERT');
    expect(convTx.entries.map((e) => [e.account.type, e.amount]).sort()).toEqual([['PLAYER_BONUS', -600n], ['PLAYER_CASH', 600n]]);
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 600n, bonus: 200n });

    // Segundo bono: convenciones de gameId del WalletPort, perdido.
    const b2 = bonus(c);
    await port.credit({ ...c, amount: 300n, idempotencyKey: `promo:bonus:${b2.id}:grant`, reason: 'BONUS_GRANT', ref: { provider: 'nymfo-promotions', gameId: 'bonus-grant', roundId: b2.id } });
    const ff = await port.debit({ ...c, amount: 500n, idempotencyKey: `promo:bonus:${b2.id}:forfeit`, reason: 'OTHER', ref: { provider: 'nymfo-promotions', gameId: 'bonus-forfeit', roundId: b2.id } });
    expect((await txOf(c.operatorId, ff.txId)).type).toBe('BONUS_FORFEIT');
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 600n, bonus: 0n });
    // forfeit nunca toca cash
    await expect(adapters.bonusFunds.forfeit(bonus(c), 1n)).rejects.toSatisfy((e) => isWalletError(e, 'INSUFFICIENT_FUNDS'));
    expect(await operatorAccount(c.operatorId, 'BONUS_EXPENSE')).toBe(-1_300n + 500n);
  });

  it('cashback: CASHBACK_EXPENSE → PLAYER_CASH (WalletPort y grantCash)', async () => {
    const c = await ctx(0n);
    const r = await port.credit({ ...c, amount: 250n, idempotencyKey: key('cb'), reason: 'CASHBACK', ref: { gameId: 'cashback-cash' } });
    expect((await txOf(c.operatorId, r.txId)).type).toBe('CASHBACK');
    await adapters.bonusFunds.grantCash(bonus(c), 50n);
    expect(await port.getBalance(c.operatorId, c.playerId, 'USD')).toEqual({ cash: 300n, bonus: 0n });
    expect(await operatorAccount(c.operatorId, 'CASHBACK_EXPENSE')).toBe(-300n);
  });

  it('jackpot: semilla y contribución HOUSE → JACKPOT_POOL (idempotentes) y pago JACKPOT_POOL → PLAYER_CASH', async () => {
    const c = await ctx(1_000n);
    const jackpotId = randomUUID();
    await adapters.jackpotLedger.recordSeed({ key: `jp:seed:${jackpotId}:mini:initial`, operatorId: c.operatorId, currency: 'USD', jackpotId, levelKey: 'mini', reason: 'INITIAL', amount: 5_000n });
    const contrib = { key: `jp:contrib:${jackpotId}:r1`, operatorId: c.operatorId, currency: 'USD', jackpotId, roundId: 'r1', gameId: 'slot', playerId: c.playerId, amount: 30n };
    await adapters.jackpotLedger.recordContribution(contrib);
    await adapters.jackpotLedger.recordContribution(contrib); // reintento: sin duplicar
    await expect(adapters.jackpotLedger.recordContribution({ ...contrib, amount: 31n })).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === 'CONFLICT',
    );
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(5_030n);

    const pay = await port.credit({ ...c, amount: 5_030n, idempotencyKey: key('jp'), reason: 'JACKPOT', ref: { provider: 'nymfo-promotions', gameId: 'slot', roundId: 'r1' } });
    expect((await txOf(c.operatorId, pay.txId)).type).toBe('JACKPOT_PAYOUT');
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(0n);
    expect((await port.getBalance(c.operatorId, c.playerId, 'USD')).cash).toBe(6_030n);
    expect(await operatorAccount(c.operatorId, 'HOUSE')).toBe(-5_030n);
  });

  it('withJackpotLedger: alta (semillas), contribuciones y disparo (reseed) quedan en JACKPOT_POOL; el pago lo vacía', async () => {
    const c = await ctx(0n);
    const repo = withJackpotLedger(new InMemoryJackpotRepository(), adapters.jackpotLedger);
    const level = (key: 'mini' | 'major', seed: bigint, share: number, sortOrder: number) => ({
      key, seedAmount: seed, shareBps: share, triggerChancePpm: 0, mustDropBy: null, dropPoint: null, currentAmount: seed, sortOrder,
    });
    const jp = await repo.create({
      operatorId: c.operatorId, name: 'JP', currency: 'USD', contributionBps: 100, minBet: 1n, gameIds: [], categories: [], status: 'ACTIVE',
      levels: [level('mini', 1_000n, 5_000, 0), level('major', 9_000n, 5_000, 1)],
    });
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(10_000n);
    const input = { jackpotId: jp.id, operatorId: c.operatorId, playerId: c.playerId, currency: 'USD', roundId: 'r1', gameId: 'slot', betAmount: 4_000n };
    const hooks = (trigger: boolean) => ({
      split: () => ({ total: 40n, perLevel: { mini: 20n, major: 20n } }),
      decide: () => (trigger ? [{ key: 'mini' as const, nextDropPoint: null }] : []),
    });
    const r1 = await repo.contribute(input, hooks(false));
    expect(r1.duplicate).toBe(false);
    const dup = await repo.contribute(input, hooks(false));
    expect(dup.duplicate).toBe(true);
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(10_040n);

    const r2 = await repo.contribute({ ...input, roundId: 'r2' }, hooks(true));
    const win = r2.wins.find((w) => w.roundId === 'r2');
    expect(win).toBeDefined();
    // contribución 40 + reseed del mini (1000) financiado por la casa
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(11_080n);
    await port.credit({ ...c, amount: win!.amount, idempotencyKey: `jp:win:${win!.id}`, reason: 'JACKPOT', ref: { gameId: 'slot', roundId: 'r2' } });
    const levels = (await repo.get(jp.id))!.levels;
    const pools = levels.reduce((s, l) => s + l.currentAmount, 0n);
    // El pozo contable coincide con la suma de los niveles del módulo.
    expect(await operatorAccount(c.operatorId, 'JACKPOT_POOL')).toBe(pools);
  });

  it('torneo: buy-in CASH → TOURNAMENT_POOL; premio desde el pool y el faltante desde BONUS_EXPENSE', async () => {
    const a = await ctx(1_000n);
    const p2 = await ctx(0n); // otro operador: su pool no se mezcla
    const buy = await port.debit({ ...a, amount: 100n, idempotencyKey: key('buyin'), reason: 'TOURNAMENT_BUYIN', ref: { roundId: 't1' } });
    expect((await txOf(a.operatorId, buy.txId)).type).toBe('TOURNAMENT_BUYIN');
    expect(await operatorAccount(a.operatorId, 'TOURNAMENT_POOL')).toBe(100n);

    const prize = await port.credit({ ...a, amount: 250n, idempotencyKey: key('prize'), reason: 'TOURNAMENT_PRIZE', ref: { roundId: 't1' } });
    const tx = await txOf(a.operatorId, prize.txId);
    expect(tx.type).toBe('TOURNAMENT_PRIZE');
    expect(tx.entries.map((e) => [e.account.type, e.amount]).sort()).toEqual([
      ['BONUS_EXPENSE', -150n],
      ['PLAYER_CASH', 250n],
      ['TOURNAMENT_POOL', -100n],
    ]);
    expect(await operatorAccount(a.operatorId, 'TOURNAMENT_POOL')).toBe(0n);
    expect((await port.getBalance(a.operatorId, a.playerId, 'USD')).cash).toBe(1_150n);
    // Pool vacío: premio íntegro desde BONUS_EXPENSE.
    await port.credit({ ...p2, amount: 40n, idempotencyKey: key('prize'), reason: 'TOURNAMENT_PRIZE', ref: { roundId: 't2' } });
    expect(await operatorAccount(p2.operatorId, 'BONUS_EXPENSE')).toBe(-40n);
    expect(await operatorAccount(p2.operatorId, 'TOURNAMENT_POOL')).toBe(0n);
  });
});
