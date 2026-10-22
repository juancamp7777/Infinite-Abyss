import { DAY_COUNTERS, emptyRow, isBigCounter, type DayDelta, type DayRow, type KpiRepository, type PlayerDayKind, type Skin, type SkinPort } from '../domain/types';

/** Subconjunto del PrismaClient fusionado que usa este módulo. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BoPrismaLike = any;

const FIELD: Record<PlayerDayKind, string> = { active: 'active', depositor: 'depositor', bettor: 'bettor' };

export class PrismaKpiRepository implements KpiRepository {
  constructor(private readonly db: BoPrismaLike) {}

  async claimEvent(key: string): Promise<boolean> {
    const r = await this.db.boProcessedEvent.createMany({ data: [{ key }], skipDuplicates: true });
    return r.count === 1;
  }

  async bumpDay(operatorId: string, day: string, delta: DayDelta): Promise<void> {
    const create: Record<string, unknown> = { operatorId, day };
    const update: Record<string, unknown> = {};
    for (const c of DAY_COUNTERS) {
      const d = delta[c];
      if (d === undefined) continue;
      const v = isBigCounter(c) ? BigInt(d) : Number(d);
      create[c] = v;
      update[c] = { increment: v };
    }
    await this.db.boDayKpi.upsert({ where: { operatorId_day: { operatorId, day } }, create, update });
  }

  async touchPlayerDay(operatorId: string, day: string, playerId: string, kind: PlayerDayKind): Promise<boolean> {
    await this.db.boPlayerDay.createMany({ data: [{ operatorId, day, playerId }], skipDuplicates: true });
    const f = FIELD[kind];
    const r = await this.db.boPlayerDay.updateMany({ where: { operatorId, day, playerId, [f]: false }, data: { [f]: true } });
    return r.count === 1;
  }

  async setPlayerMilestone(operatorId: string, playerId: string, m: { registeredDay?: string; firstDepositDay?: string }): Promise<void> {
    await this.db.boPlayer.createMany({ data: [{ operatorId, playerId }], skipDuplicates: true });
    for (const f of ['registeredDay', 'firstDepositDay'] as const) {
      const v = m[f];
      if (v) await this.db.boPlayer.updateMany({ where: { operatorId, playerId, [f]: null }, data: { [f]: v } });
    }
  }

  async getDays(operatorId: string | undefined, from: string, to: string): Promise<DayRow[]> {
    const rows = await this.db.boDayKpi.findMany({
      where: { ...(operatorId ? { operatorId } : {}), day: { gte: from, lte: to } },
      orderBy: [{ day: 'asc' }, { operatorId: 'asc' }],
    });
    return rows.map((r: Record<string, unknown>) => {
      const out = emptyRow(String(r.operatorId), String(r.day)) as unknown as Record<string, unknown>;
      for (const c of DAY_COUNTERS) out[c] = isBigCounter(c) ? BigInt(r[c] as bigint) : Number(r[c]);
      return out as unknown as DayRow;
    });
  }

  async distinctPlayers(operatorId: string | undefined, from: string, to: string, kind: PlayerDayKind): Promise<number> {
    const rows = await this.db.boPlayerDay.findMany({
      where: { ...(operatorId ? { operatorId } : {}), day: { gte: from, lte: to }, [FIELD[kind]]: true },
      distinct: ['operatorId', 'playerId'],
      select: { operatorId: true },
    });
    return rows.length;
  }

  async listRegistrations(operatorId: string | undefined, from: string, to: string) {
    const rows = await this.db.boPlayer.findMany({
      where: { ...(operatorId ? { operatorId } : {}), registeredDay: { gte: from, lte: to } },
      select: { operatorId: true, playerId: true, registeredDay: true },
    });
    return rows.map((r: { operatorId: string; playerId: string; registeredDay: string }) => ({ operatorId: r.operatorId, playerId: r.playerId, day: r.registeredDay }));
  }

  async activeDaysOf(operatorId: string, playerIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (let i = 0; i < playerIds.length; i += 1000) {
      const rows = await this.db.boPlayerDay.findMany({
        where: { operatorId, active: true, playerId: { in: playerIds.slice(i, i + 1000) } },
        select: { playerId: true, day: true },
      });
      for (const r of rows as Array<{ playerId: string; day: string }>) {
        const s = out.get(r.playerId) ?? new Set<string>();
        s.add(r.day);
        out.set(r.playerId, s);
      }
    }
    return out;
  }
}

export class PrismaSkinPort implements SkinPort {
  constructor(private readonly db: BoPrismaLike) {}
  async get(operatorId: string): Promise<Skin | null> {
    const row = await this.db.boSkin.findUnique({ where: { operatorId } });
    return row ? (row.data as Skin) : null;
  }
  async update(operatorId: string, skin: Skin): Promise<Skin> {
    await this.db.boSkin.upsert({ where: { operatorId }, create: { operatorId, data: skin }, update: { data: skin } });
    return skin;
  }
}
