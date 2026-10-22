import type { Jackpot, JackpotContribution, JackpotLevel, JackpotLevelKey, JackpotSeedFunding, JackpotWin } from '../../domain/jackpot';
import type {
  ContributionHooks,
  ContributionInput,
  ContributionResult,
  JackpotLevelReport,
  JackpotPatch,
  JackpotReport,
  JackpotRepository,
  NewJackpot,
} from '../../application/ports';
import { PrismaLike, TX_OPTIONS } from './PrismaBonusRepository';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toLevel(r: Row): JackpotLevel {
  return {
    key: r.key as JackpotLevelKey,
    seedAmount: r.seedAmount,
    shareBps: r.shareBps,
    triggerChancePpm: r.triggerChancePpm,
    mustDropBy: r.mustDropBy ?? null,
    dropPoint: r.dropPoint ?? null,
    currentAmount: r.currentAmount,
    sortOrder: r.sortOrder,
  };
}

function toJackpot(r: Row): Jackpot {
  const { levels, ...rest } = r;
  return { ...(rest as Omit<Jackpot, 'levels'>), levels: ((levels ?? []) as Row[]).map(toLevel).sort((a, b) => a.sortOrder - b.sortOrder) };
}

const perLevelToJson = (p: Partial<Record<JackpotLevelKey, bigint>>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, (v as bigint).toString()]));
const perLevelFromJson = (j: unknown): Partial<Record<JackpotLevelKey, bigint>> =>
  Object.fromEntries(Object.entries((j ?? {}) as Record<string, string>).map(([k, v]) => [k, BigInt(v)]));

const toWin = (r: Row): JackpotWin => ({ ...(r as JackpotWin), levelKey: r.levelKey as JackpotLevelKey });

/**
 * Jackpots sobre PostgreSQL: cada contribución corre en una transacción que bloquea las filas de niveles del
 * jackpot (SELECT … FOR UPDATE), así que los pools no pierden incrementos ni pagan dos veces bajo concurrencia.
 */
export class PrismaJackpotRepository implements JackpotRepository {
  constructor(private readonly db: PrismaLike) {}

  async create(j: NewJackpot): Promise<Jackpot> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      const { levels, ...rest } = j;
      const row = await tx.promoJackpot.create({ data: { ...rest, levels: { create: levels } }, include: { levels: true } });
      await tx.promoJackpotSeedFunding.createMany({
        data: levels.map((l) => ({ jackpotId: row.id, levelKey: l.key, amount: l.currentAmount, reason: 'INITIAL' })),
      });
      return toJackpot(row);
    }, TX_OPTIONS);
  }

  async update(id: string, patch: JackpotPatch): Promise<Jackpot | null> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      const exists = await tx.promoJackpot.findUnique({ where: { id } });
      if (!exists) return null;
      await this.lockLevels(tx, id);
      const { levels, ...rest } = patch;
      if (Object.keys(rest).length > 0) await tx.promoJackpot.update({ where: { id }, data: rest });
      if (levels) {
        const current = (await tx.promoJackpotLevel.findMany({ where: { jackpotId: id } })) as Row[];
        for (const cfg of levels) {
          const l = current.find((x) => x.key === cfg.key);
          if (!l) continue;
          let dropPoint: bigint | null = l.dropPoint ?? null;
          if ((l.mustDropBy ?? null) !== cfg.mustDropBy) {
            if (cfg.mustDropBy == null) dropPoint = null;
            else if (dropPoint == null || dropPoint > cfg.mustDropBy) dropPoint = cfg.mustDropBy;
          }
          await tx.promoJackpotLevel.update({
            where: { id: l.id },
            data: { seedAmount: cfg.seedAmount, shareBps: cfg.shareBps, triggerChancePpm: cfg.triggerChancePpm, mustDropBy: cfg.mustDropBy, dropPoint },
          });
        }
      }
      return toJackpot(await tx.promoJackpot.findUnique({ where: { id }, include: { levels: true } }));
    }, TX_OPTIONS);
  }

  async get(id: string): Promise<Jackpot | null> {
    const r = await this.db.promoJackpot.findUnique({ where: { id }, include: { levels: true } });
    return r ? toJackpot(r) : null;
  }

  async list(operatorId?: string): Promise<Jackpot[]> {
    const rows = await this.db.promoJackpot.findMany({ where: operatorId ? { operatorId } : {}, include: { levels: true }, orderBy: { createdAt: 'asc' } });
    return rows.map(toJackpot);
  }

  async contribute(input: ContributionInput, hooks: ContributionHooks): Promise<ContributionResult> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      await this.lockLevels(tx, input.jackpotId);
      const row = await tx.promoJackpot.findUnique({ where: { id: input.jackpotId }, include: { levels: true } });
      if (!row) return { duplicate: false, wins: [], jackpot: null };
      const jackpot = toJackpot(row);
      const existing = await tx.promoJackpotContribution.findUnique({ where: { jackpotId_roundId: { jackpotId: input.jackpotId, roundId: input.roundId } } });
      if (existing) {
        const pending = await tx.promoJackpotWin.findMany({ where: { jackpotId: input.jackpotId, roundId: input.roundId, status: 'PENDING' } });
        return { duplicate: true, wins: pending.map(toWin), jackpot };
      }
      const { total, perLevel } = hooks.split(jackpot);
      await tx.promoJackpotContribution.create({
        data: {
          jackpotId: input.jackpotId,
          operatorId: input.operatorId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          betAmount: input.betAmount,
          amount: total,
          perLevel: perLevelToJson(perLevel),
        },
      });
      for (const l of jackpot.levels) l.currentAmount += perLevel[l.key] ?? 0n;
      const decisions = hooks.decide(jackpot.levels.map((l) => ({ ...l })));
      const wins: JackpotWin[] = [];
      for (const l of jackpot.levels) {
        const d = decisions.find((x) => x.key === l.key);
        if (d) {
          const w = await tx.promoJackpotWin.create({
            data: {
              jackpotId: input.jackpotId,
              operatorId: input.operatorId,
              playerId: input.playerId,
              currency: input.currency,
              levelKey: l.key,
              roundId: input.roundId,
              gameId: input.gameId,
              amount: l.currentAmount,
            },
          });
          wins.push(toWin(w));
          await tx.promoJackpotSeedFunding.create({ data: { jackpotId: input.jackpotId, levelKey: l.key, amount: l.seedAmount, reason: 'RESEED' } });
          l.currentAmount = l.seedAmount;
          l.dropPoint = d.nextDropPoint;
        }
        await tx.promoJackpotLevel.update({
          where: { jackpotId_key: { jackpotId: input.jackpotId, key: l.key } },
          data: { currentAmount: l.currentAmount, dropPoint: l.dropPoint },
        });
      }
      return { duplicate: false, wins, jackpot };
    }, TX_OPTIONS);
  }

  async markWinPaid(winId: string, txId: string, at: Date): Promise<JackpotWin | null> {
    await this.db.promoJackpotWin.updateMany({ where: { id: winId, status: 'PENDING' }, data: { status: 'PAID', txId, paidAt: at } });
    const r = await this.db.promoJackpotWin.findUnique({ where: { id: winId } });
    return r ? toWin(r) : null;
  }

  async listPendingWins(limit: number): Promise<JackpotWin[]> {
    return (await this.db.promoJackpotWin.findMany({ where: { status: 'PENDING' }, take: limit, orderBy: { createdAt: 'asc' } })).map(toWin);
  }

  async listWins(jackpotId: string, limit: number): Promise<JackpotWin[]> {
    return (await this.db.promoJackpotWin.findMany({ where: { jackpotId }, take: limit, orderBy: { createdAt: 'desc' } })).map(toWin);
  }

  async listContributions(jackpotId: string, limit: number): Promise<JackpotContribution[]> {
    const rows = (await this.db.promoJackpotContribution.findMany({ where: { jackpotId }, take: limit, orderBy: { createdAt: 'desc' } })) as Row[];
    return rows.map((r) => ({ ...(r as JackpotContribution), perLevel: perLevelFromJson(r.perLevel) }));
  }

  async listSeedFunding(jackpotId: string): Promise<JackpotSeedFunding[]> {
    const rows = (await this.db.promoJackpotSeedFunding.findMany({ where: { jackpotId }, orderBy: { createdAt: 'asc' } })) as Row[];
    return rows.map((r) => ({ ...(r as JackpotSeedFunding), levelKey: r.levelKey as JackpotLevelKey }));
  }

  async report(jackpotId: string): Promise<JackpotReport | null> {
    const j = await this.get(jackpotId);
    if (!j) return null;
    const contrib = (await this.db.$queryRaw`
      SELECT e.key AS key, SUM(e.value::numeric)::text AS total
      FROM promo_jackpot_contributions c, jsonb_each_text(c."perLevel") AS e
      WHERE c."jackpotId" = ${jackpotId}::uuid
      GROUP BY e.key`) as Array<{ key: string; total: string | null }>;
    const seeds = (await this.db.promoJackpotSeedFunding.groupBy({ by: ['levelKey'], where: { jackpotId }, _sum: { amount: true } })) as Row[];
    const wins = (await this.db.promoJackpotWin.groupBy({ by: ['levelKey', 'status'], where: { jackpotId }, _sum: { amount: true }, _count: { _all: true } })) as Row[];
    const levels: JackpotLevelReport[] = j.levels.map((l) => ({
      key: l.key,
      contributions: BigInt(contrib.find((c) => c.key === l.key)?.total ?? '0'),
      seedFunding: BigInt(seeds.find((s) => s.levelKey === l.key)?._sum.amount ?? 0),
      payouts: wins.filter((w) => w.levelKey === l.key).reduce((s, w) => s + BigInt(w._sum.amount ?? 0), 0n),
      current: l.currentAmount,
    }));
    const sum = (f: (l: JackpotLevelReport) => bigint) => levels.reduce((s, l) => s + f(l), 0n);
    const byStatus = (st: string) => wins.filter((w) => w.status === st).reduce((s, w) => s + BigInt(w._sum.amount ?? 0), 0n);
    return {
      jackpotId,
      contributions: sum((l) => l.contributions),
      seedFunding: sum((l) => l.seedFunding),
      payouts: sum((l) => l.payouts),
      paidOut: byStatus('PAID'),
      pendingPayouts: byStatus('PENDING'),
      pools: sum((l) => l.current),
      winsCount: wins.reduce((s, w) => s + Number(w._count._all ?? 0), 0),
      levels,
    };
  }

  private async lockLevels(tx: PrismaLike, jackpotId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM promo_jackpot_levels WHERE "jackpotId" = ${jackpotId}::uuid ORDER BY id FOR UPDATE`;
  }
}
