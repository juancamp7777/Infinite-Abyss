import { DAY_COUNTERS, emptyRow, isBigCounter, type DayDelta, type DayRow, type KpiRepository, type PlayerDayKind, type Skin, type SkinPort } from '../domain/types';

export class InMemoryKpiRepository implements KpiRepository {
  private readonly events = new Set<string>();
  private readonly days = new Map<string, DayRow>();
  private readonly marks = new Map<string, Set<PlayerDayKind>>();
  private readonly players = new Map<string, { registeredDay?: string; firstDepositDay?: string }>();

  async claimEvent(key: string): Promise<boolean> {
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }

  async bumpDay(operatorId: string, day: string, delta: DayDelta): Promise<void> {
    const k = `${operatorId}|${day}`;
    const row = this.days.get(k) ?? emptyRow(operatorId, day);
    const r = row as unknown as Record<string, number | bigint>;
    for (const c of DAY_COUNTERS) {
      const d = delta[c];
      if (d === undefined) continue;
      r[c] = isBigCounter(c) ? (r[c] as bigint) + BigInt(d) : (r[c] as number) + Number(d);
    }
    this.days.set(k, row);
  }

  async touchPlayerDay(operatorId: string, day: string, playerId: string, kind: PlayerDayKind): Promise<boolean> {
    const k = `${operatorId}|${day}|${playerId}`;
    const set = this.marks.get(k) ?? new Set<PlayerDayKind>();
    this.marks.set(k, set);
    if (set.has(kind)) return false;
    set.add(kind);
    return true;
  }

  async setPlayerMilestone(operatorId: string, playerId: string, m: { registeredDay?: string; firstDepositDay?: string }): Promise<void> {
    const k = `${operatorId}|${playerId}`;
    const cur = this.players.get(k) ?? {};
    if (m.registeredDay && !cur.registeredDay) cur.registeredDay = m.registeredDay;
    if (m.firstDepositDay && !cur.firstDepositDay) cur.firstDepositDay = m.firstDepositDay;
    this.players.set(k, cur);
  }

  async getDays(operatorId: string | undefined, from: string, to: string): Promise<DayRow[]> {
    return [...this.days.values()]
      .filter((r) => (!operatorId || r.operatorId === operatorId) && r.day >= from && r.day <= to)
      .map((r) => ({ ...r }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.operatorId.localeCompare(b.operatorId));
  }

  async distinctPlayers(operatorId: string | undefined, from: string, to: string, kind: PlayerDayKind): Promise<number> {
    const seen = new Set<string>();
    for (const [k, kinds] of this.marks) {
      if (!kinds.has(kind)) continue;
      const [op, day, player] = k.split('|') as [string, string, string];
      if ((operatorId && op !== operatorId) || day < from || day > to) continue;
      seen.add(`${op}|${player}`);
    }
    return seen.size;
  }

  async listRegistrations(operatorId: string | undefined, from: string, to: string) {
    const out: Array<{ operatorId: string; playerId: string; day: string }> = [];
    for (const [k, p] of this.players) {
      if (!p.registeredDay || p.registeredDay < from || p.registeredDay > to) continue;
      const [op, playerId] = k.split('|') as [string, string];
      if (operatorId && op !== operatorId) continue;
      out.push({ operatorId: op, playerId, day: p.registeredDay });
    }
    return out;
  }

  async activeDaysOf(operatorId: string, playerIds: string[]): Promise<Map<string, Set<string>>> {
    const want = new Set(playerIds);
    const out = new Map<string, Set<string>>();
    for (const [k, kinds] of this.marks) {
      if (!kinds.has('active')) continue;
      const [op, day, player] = k.split('|') as [string, string, string];
      if (op !== operatorId || !want.has(player)) continue;
      const s = out.get(player) ?? new Set<string>();
      s.add(day);
      out.set(player, s);
    }
    return out;
  }
}

/** Adaptador por defecto de SkinPort (la Fase 1 lo sustituye con su modelo Skin). */
export class InMemorySkinPort implements SkinPort {
  private readonly skins = new Map<string, Skin>();
  async get(operatorId: string): Promise<Skin | null> {
    const s = this.skins.get(operatorId);
    return s ? structuredClone(s) : null;
  }
  async update(operatorId: string, skin: Skin): Promise<Skin> {
    this.skins.set(operatorId, structuredClone(skin));
    return structuredClone(skin);
  }
}
