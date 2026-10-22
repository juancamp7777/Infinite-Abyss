/**
 * Verificación de los repositorios Prisma contra PostgreSQL real: la BD de pruebas que el globalSetup migra con
 * `prisma migrate deploy` (TEST_DATABASE_URL → DATABASE_URL). Cada prueba usa su propio operador (uuid) para aislar sus
 * datos de otras pruebas y corridas, sin truncar tablas.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { silentLogger } from '../../shared/module';
import { WalletBonusFunds } from '../application/BonusFunds';
import { BonusService } from '../application/BonusService';
import { DropsService } from '../application/DropsService';
import { JackpotService } from '../application/JackpotService';
import { PrismaBonusRepository } from '../infrastructure/prisma/PrismaBonusRepository';
import { PrismaDropRepository } from '../infrastructure/prisma/PrismaDropRepository';
import { PrismaJackpotRepository } from '../infrastructure/prisma/PrismaJackpotRepository';
import { bet as baseBet, CUR, manualClock, scriptedRng, T0 } from './helpers';

describe('repositorios Prisma de promociones (PostgreSQL)', () => {
  let prisma: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let OP = '';
  const bet = (playerId: string, amount: bigint, extra: Parameters<typeof baseBet>[2] = {}) =>
    baseBet(playerId, amount, { operatorId: OP, ...extra });

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  });

  beforeEach(() => {
    OP = randomUUID();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('bonos: límites de código, wagering con dedupe, conversión, expiración y cashback idempotente', async () => {
    const wallet = new InMemoryWallet();
    const clock = manualClock();
    const repo = new PrismaBonusRepository(prisma);
    const svc = new BonusService({ repo, funds: new WalletBonusFunds(wallet), clock: clock.clock, logger: silentLogger, defaultCurrency: CUR });
    await svc.createTemplate({ operatorId: OP, name: 'P', type: 'promo_code', currency: CUR, code: 'PGCODE', fixedAmount: 100n, wageringMultiplier: 3, maxUsesTotal: 2, contributionBps: { slots: 10000, originals: 5000 } });
    const res = await Promise.allSettled(['a', 'b', 'c', 'd'].map((p) => svc.claim(OP, p, 'PGCODE')));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const winner = (res.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.claim>>>).value;

    const e1 = bet(winner.playerId, 200n);
    await Promise.all([svc.onBetPlaced(e1), svc.onBetPlaced(e1)]);
    await svc.onBetPlaced(bet(winner.playerId, 200n, { category: 'originals' }));
    let b = (await svc.getBonus(winner.id))!;
    expect(b.wageringProgress).toBe(300n);
    expect(b.status).toBe('COMPLETED');
    expect(wallet.findTransaction(OP, `promo:bonus:${b.id}:convert`)?.amount).toBe(100n);

    const other = (res.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<Awaited<ReturnType<typeof svc.claim>>>>).map((r) => r.value).find((x) => x.id !== winner.id)!;
    clock.advanceHours(24 * 8);
    // tick() expira bonos de todos los operadores: con BD compartida basta con que haya expirado el de esta prueba.
    expect((await svc.tick()).expired).toBeGreaterThanOrEqual(1);
    b = (await svc.getBonus(other.id))!;
    expect(b.status).toBe('FORFEITED');

    await Promise.all([svc.grantCashback(OP, 'cb', 75n, 'r1'), svc.grantCashback(OP, 'cb', 75n, 'r1')]);
    expect(wallet.getHistory({ reason: 'CASHBACK' })).toHaveLength(1);

    await svc.onBetSettled({ operatorId: OP, playerId: 'cb', at: T0.toISOString(), amount: 500n, win: 100n, currency: CUR, gameId: 'g', provider: 'x', category: 'slots', roundId: 'pg-s1', multiplier: 0.2 });
    await svc.onBetSettled({ operatorId: OP, playerId: 'cb', at: T0.toISOString(), amount: 500n, win: 100n, currency: CUR, gameId: 'g', provider: 'x', category: 'slots', roundId: 'pg-s1', multiplier: 0.2 });
    expect(await repo.netResults(OP, CUR, new Date(T0.getTime() - 1000), new Date(T0.getTime() + 1000))).toEqual([{ playerId: 'cb', wagered: 500n, won: 100n }]);
  });

  it('jackpots: contribuciones concurrentes, disparo pagado una vez y ledger cuadrado', async () => {
    const wallet = new InMemoryWallet();
    const r = scriptedRng();
    const svc = new JackpotService({ repo: new PrismaJackpotRepository(prisma), wallet, clock: manualClock().clock, rng: r.rng, logger: silentLogger });
    const j = await svc.create({
      operatorId: OP, name: 'PG', currency: CUR, contributionBps: 100,
      levels: [
        { key: 'mini', seedAmount: 1000n, shareBps: 6000, triggerChancePpm: 10 },
        { key: 'major', seedAmount: 5000n, shareBps: 4000, triggerChancePpm: 1 },
      ],
    });
    await Promise.all(Array.from({ length: 40 }, (_, i) => svc.onBetPlaced(bet(`p${i}`, 1001n))));
    r.hitNext();
    const win = bet('lucky', 1000n);
    const paid = await svc.onBetPlaced(win);
    expect(paid).toHaveLength(1);
    await svc.onBetPlaced(win);
    expect(wallet.getHistory({ reason: 'JACKPOT' })).toHaveLength(1);
    const rep = await svc.report(OP, j.id);
    expect(rep.contributions).toBe(41n * 10n);
    expect(rep.contributions + rep.seedFunding - rep.payouts).toBe(rep.pools);
    expect(rep.balanced).toBe(true);
  });

  it('drops: el stock no se excede con concurrencia', async () => {
    const wallet = new InMemoryWallet();
    const svc = new DropsService({ repo: new PrismaDropRepository(prisma), wallet, clock: manualClock().clock, rng: scriptedRng(() => 0).rng, roller: () => 0, logger: silentLogger });
    await svc.create({
      operatorId: OP, name: 'PG drops', currency: CUR, startsAt: new Date(T0.getTime() - 1000), endsAt: new Date(T0.getTime() + 3_600_000),
      minBet: 1n, dropChancePpm: 1_000_000, gameIds: [], status: 'ACTIVE', prizes: [{ amount: 10n, quantity: 3 }],
    });
    const out = (await Promise.all(Array.from({ length: 15 }, (_, i) => svc.onBetPlaced(bet(`d${i}`, 5n))))).flat();
    expect(out).toHaveLength(3);
    expect(wallet.getHistory({ reason: 'TOURNAMENT_PRIZE' })).toHaveLength(3);
  });
});
