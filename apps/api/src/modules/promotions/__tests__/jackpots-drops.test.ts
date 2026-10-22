import { describe, expect, it } from 'vitest';
import { bigintReplacer } from '../../shared/money';
import { WalletError } from '../../shared/ports/WalletPort';
import { remainingStock } from '../domain/drops';
import { splitContribution, totalContribution } from '../domain/jackpot';
import { bet, CUR, dropsEnv, jackpotEnv, OP, T0 } from './helpers';

const LEVELS = [
  { key: 'mini' as const, seedAmount: 1000n, shareBps: 6000, triggerChancePpm: 100 },
  { key: 'major' as const, seedAmount: 10000n, shareBps: 3000, triggerChancePpm: 10 },
  { key: 'mega' as const, seedAmount: 100000n, shareBps: 1000, triggerChancePpm: 1 },
];

async function expectBalanced(env: ReturnType<typeof jackpotEnv>, id: string) {
  const r = await env.service.report(undefined, id);
  expect(r.contributions + r.seedFunding - r.payouts).toBe(r.pools);
  expect(r.balanced).toBe(true);
  return r;
}

describe('jackpots: reparto de la contribución', () => {
  it('reparte sin perder unidades y el residuo va al nivel de mayor share', () => {
    const levels = LEVELS.map((l, i) => ({ ...l, sortOrder: i }));
    expect(splitContribution(3n, levels)).toEqual({ mini: 3n, major: 0n, mega: 0n });
    expect(splitContribution(7n, levels)).toEqual({ mini: 5n, major: 2n, mega: 0n });
    for (let t = 0n; t < 500n; t += 7n) {
      const s = splitContribution(t, levels);
      expect(Object.values(s).reduce((a, b) => a + b, 0n)).toBe(t);
    }
    // Empate de share → menor sortOrder.
    expect(splitContribution(1n, [{ key: 'major', shareBps: 5000, sortOrder: 1 }, { key: 'mini', shareBps: 5000, sortOrder: 0 }])).toEqual({ mini: 1n, major: 0n });
    expect(totalContribution(333n, 100)).toBe(3n);
  });

  it('las contribuciones registradas suman exactamente el crecimiento de los pools', async () => {
    const env = jackpotEnv();
    const j = await env.service.create({ operatorId: OP, name: 'Abyss Mega', currency: CUR, contributionBps: 150, levels: LEVELS });
    const bets = [333n, 1n, 999n, 12345n, 70n, 101n, 5000n];
    for (const b of bets) await env.service.onBetPlaced(bet('p1', b));
    const expected = bets.reduce((s, b) => s + (b * 150n) / 10000n, 0n);
    const contribs = await env.repo.listContributions(j.id, 100);
    expect(contribs).toHaveLength(bets.length);
    expect(contribs.reduce((s, c) => s + c.amount, 0n)).toBe(expected);
    for (const c of contribs) expect(Object.values(c.perLevel).reduce((a, b) => a! + b!, 0n)).toBe(c.amount);
    const after = (await env.service.getScoped(OP, j.id)).levels.reduce((s, l) => s + l.currentAmount, 0n);
    expect(after).toBe(111000n + expected);
    const r = await expectBalanced(env, j.id);
    expect(r.contributions).toBe(expected);
    expect(r.seedFunding).toBe(111000n);
  });

  it('ignora apuestas no elegibles (moneda, apuesta mínima, juegos, pausado) y reprocesos', async () => {
    const env = jackpotEnv();
    const j = await env.service.create({ operatorId: OP, name: 'J', currency: CUR, contributionBps: 100, minBet: 100n, gameIds: ['starfall'], levels: LEVELS });
    await env.service.onBetPlaced(bet('p1', 1000n, { currency: 'EUR' }));
    await env.service.onBetPlaced(bet('p1', 99n));
    await env.service.onBetPlaced(bet('p1', 1000n, { gameId: 'crash' }));
    await env.service.onBetPlaced(bet('p1', 1000n, { operatorId: 'op-2' }));
    const e = bet('p1', 1000n);
    await env.service.onBetPlaced(e);
    await env.service.onBetPlaced(e);
    expect(await env.repo.listContributions(j.id, 10)).toHaveLength(1);
    await env.service.update(OP, j.id, { status: 'PAUSED' });
    await env.service.onBetPlaced(bet('p1', 1000n));
    expect(await env.repo.listContributions(j.id, 10)).toHaveLength(1);
  });

  it('contribuciones concurrentes no pierden incrementos', async () => {
    const env = jackpotEnv();
    const j = await env.service.create({ operatorId: OP, name: 'J', currency: CUR, contributionBps: 100, levels: LEVELS });
    await Promise.all(Array.from({ length: 200 }, (_, i) => env.service.onBetPlaced(bet(`p${i % 7}`, 1000n + BigInt(i)))));
    const r = await expectBalanced(env, j.id);
    expect(r.contributions).toBe(Array.from({ length: 200 }, (_, i) => ((1000n + BigInt(i)) * 100n) / 10000n).reduce((a, b) => a + b, 0n));
  });
});

describe('jackpots: disparo y pago', () => {
  it('paga una sola vez aunque el evento se reprocese, reinicia con la semilla y cuadra el ledger', async () => {
    const env = jackpotEnv();
    const j = await env.service.create({ operatorId: OP, name: 'J', currency: CUR, contributionBps: 100, levels: LEVELS });
    for (let i = 0; i < 5; i++) await env.service.onBetPlaced(bet('p1', 10000n));
    const before = (await env.service.getScoped(OP, j.id)).levels.find((l) => l.key === 'mini')!.currentAmount; // 1000 + 5×60
    expect(before).toBe(1300n);

    env.hitNext(); // el primer nivel evaluado (mini) dispara
    const winning = bet('p2', 10000n);
    const paid = await env.service.onBetPlaced(winning);
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ levelKey: 'mini', amount: 1360n, status: 'PAID', playerId: 'p2' });
    await env.service.onBetPlaced(winning);
    env.hitNext();
    await env.service.onBetPlaced(winning);
    await env.service.tick();
    const credits = env.wallet.getHistory({ reason: 'JACKPOT' });
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ playerId: 'p2', amount: 1360n, idempotencyKey: `promo:jp:${j.id}:${paid[0].id}` });
    expect((await env.wallet.getBalance(OP, 'p2', CUR)).cash).toBe(1360n);

    const jp = await env.service.getScoped(OP, j.id);
    expect(jp.levels.find((l) => l.key === 'mini')!.currentAmount).toBe(1000n);
    const r = await expectBalanced(env, j.id);
    expect(r).toMatchObject({ payouts: 1360n, paidOut: 1360n, pendingPayouts: 0n, winsCount: 1 });
    expect(r.seedFunding).toBe(111000n + 1000n); // semilla inicial + reseed del mini
    expect((await env.repo.listSeedFunding(j.id)).filter((s) => s.reason === 'RESEED')).toHaveLength(1);
  });

  it('si la billetera falla, el premio queda PENDING y un reintento lo paga una vez', async () => {
    const env = jackpotEnv();
    const j = await env.service.create({ operatorId: OP, name: 'J', currency: CUR, contributionBps: 100, levels: LEVELS });
    const original = env.wallet.credit.bind(env.wallet);
    let fail = true;
    env.wallet.credit = async (req) => {
      if (fail) throw new WalletError('INVALID_AMOUNT', 'caída simulada');
      return original(req);
    };
    env.hitNext();
    const e = bet('p1', 10000n);
    expect(await env.service.onBetPlaced(e)).toHaveLength(0);
    expect(await env.repo.listPendingWins(10)).toHaveLength(1);
    fail = false;
    await env.service.onBetPlaced(e); // reproceso del evento: paga el pendiente
    await env.service.tick();
    await env.service.onBetPlaced(e);
    expect(env.wallet.getHistory({ reason: 'JACKPOT' })).toHaveLength(1);
    expect(await env.repo.listPendingWins(10)).toHaveLength(0);
    await expectBalanced(env, j.id);
  });

  it('"must drop by": cae como muy tarde al llegar al punto oculto', async () => {
    const env = jackpotEnv();
    env.push(49); // dropPoint = seed + 1 + 49 = 1050
    const j = await env.service.create({
      operatorId: OP, name: 'MDB', currency: CUR, contributionBps: 1000,
      levels: [{ key: 'mini', seedAmount: 1000n, shareBps: 10000, triggerChancePpm: 0, mustDropBy: 2000n }],
    });
    expect(j.levels[0].dropPoint).toBe(1050n);
    expect(await env.service.onBetPlaced(bet('p1', 400n))).toHaveLength(0); // 1040
    env.push(99); // siguiente dropPoint = 1100
    const wins = await env.service.onBetPlaced(bet('p1', 100n)); // 1050 → cae
    expect(wins).toHaveLength(1);
    expect(wins[0].amount).toBe(1050n);
    const after = await env.service.getScoped(OP, j.id);
    expect(after.levels[0]).toMatchObject({ currentAmount: 1000n, dropPoint: 1100n });
    // La vista pública no expone el punto oculto.
    expect(JSON.stringify((await env.service.publicList(OP))[0], bigintReplacer)).not.toContain('dropPoint');
    await expectBalanced(env, j.id);
  });

  it('valida la configuración de niveles', async () => {
    const env = jackpotEnv();
    await expect(env.service.create({ operatorId: OP, name: 'x', currency: CUR, contributionBps: 100, levels: [{ key: 'mini', seedAmount: 1n, shareBps: 9000, triggerChancePpm: 1 }] })).rejects.toMatchObject({ status: 400 });
    await expect(env.service.create({ operatorId: OP, name: 'x', currency: CUR, contributionBps: 100, levels: [{ key: 'mini', seedAmount: 100n, shareBps: 10000, triggerChancePpm: 0, mustDropBy: 50n }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('drops & wins', () => {
  const campaign = (stock: number[]) => ({
    operatorId: OP,
    name: 'Drops semanales',
    currency: CUR,
    startsAt: new Date(T0.getTime() - 3_600_000),
    endsAt: new Date(T0.getTime() + 3_600_000),
    minBet: 10n,
    dropChancePpm: 1_000_000,
    gameIds: [],
    status: 'ACTIVE' as const,
    prizes: stock.map((q, i) => ({ amount: BigInt((i + 1) * 100), quantity: q })),
  });

  it('con stock limitado nunca se excede, ni con apuestas concurrentes', async () => {
    const env = dropsEnv();
    const c = await env.service.create(campaign([2, 1]));
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => env.service.onBetPlaced(bet(`p${i}`, 50n))));
    const awards = results.flat();
    expect(awards).toHaveLength(3);
    const credits = env.wallet.getHistory({ reason: 'TOURNAMENT_PRIZE' });
    expect(credits).toHaveLength(3);
    expect(credits.reduce((s, x) => s + x.amount, 0n)).toBe(400n);
    const after = (await env.service.getScoped(OP, c.id))!;
    expect(after.prizes.every((p) => p.awarded <= p.quantity)).toBe(true);
    expect(remainingStock(after)).toBe(0);
    expect(await env.service.activeCampaigns(OP)).toHaveLength(0);
  });

  it('reprocesar una ronda no paga dos veces y respeta apuesta mínima, fechas y probabilidad', async () => {
    const env = dropsEnv((_c, roundId) => (roundId.endsWith('lose') ? 999_999 : 0));
    await env.service.create({ ...campaign([10]), dropChancePpm: 500_000 });
    const e = bet('p1', 50n);
    expect(await env.service.onBetPlaced(e)).toHaveLength(1);
    expect(await env.service.onBetPlaced(e)).toHaveLength(0);
    expect(await env.service.onBetPlaced(bet('p1', 5n))).toHaveLength(0);
    expect(await env.service.onBetPlaced(bet('p1', 50n, { roundId: 'x-lose' }))).toHaveLength(0);
    env.clock.advanceHours(2);
    expect(await env.service.onBetPlaced(bet('p1', 50n))).toHaveLength(0);
    expect(env.wallet.getHistory({ reason: 'TOURNAMENT_PRIZE' })).toHaveLength(1);
  });
});
