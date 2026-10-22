import type { CostSource, DayRow, KpiRepository } from '../domain/types';
import { emptyRow } from '../domain/types';

/** Busca un servicio publicado por otro módulo: clave exacta o con prefijo `<modulo>.` (p. ej. 'crm.crmProfiles'). */
export function findService<T = any>(services: Record<string, unknown>, ...names: string[]): T | undefined {
  for (const n of names) {
    if (services[n] !== undefined) return services[n] as T;
    const k = Object.keys(services).find((key) => key.endsWith(`.${n}`));
    if (k) return services[k] as T;
  }
  return undefined;
}

const dayOfDate = (d: Date | string | undefined): string | undefined => {
  if (!d) return undefined;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
};

/**
 * Costos del NGR leídos de promotions (bonos y jackpots). Si el módulo no está montado devuelve vacío
 * y lo declara en missing() para que el dashboard muestre una advertencia.
 */
export class PromotionsCostSource implements CostSource {
  private readonly absent = new Set<string>();
  constructor(private readonly services: Record<string, unknown>) {}

  private svc() {
    return findService<any>(this.services, 'promotions');
  }

  missing(): string[] {
    return [...this.absent];
  }

  async bonusGrants(operatorId: string | undefined, from: string, to: string) {
    const out: Array<{ operatorId: string; day: string; amount: bigint }> = [];
    const bonuses = this.svc()?.bonuses ?? findService<any>(this.services, 'bonuses');
    if (!bonuses?.listBonuses) {
      this.absent.add('bonuses');
      return out;
    }
    const list: any[] = await bonuses.listBonuses({ ...(operatorId ? { operatorId } : {}), limit: 5000 });
    for (const b of list ?? []) {
      if (!b.grantTxId && !b.activatedAt) continue;
      const day = dayOfDate(b.activatedAt ?? b.createdAt);
      if (!day || day < from || day > to) continue;
      const amount = BigInt(b.amount ?? 0);
      if (amount > 0n) out.push({ operatorId: b.operatorId, day, amount });
    }
    return out;
  }

  async jackpotFunding(operatorId: string | undefined, from: string, to: string) {
    const out: Array<{ operatorId: string; day: string; amount: bigint }> = [];
    const jackpots = this.svc()?.jackpots ?? findService<any>(this.services, 'jackpots');
    const repo = jackpots?.d?.repo;
    if (!jackpots?.list || !repo?.listSeedFunding) {
      this.absent.add('jackpots');
      return out;
    }
    const list: any[] = await jackpots.list(operatorId);
    for (const j of list ?? []) {
      const items: any[] = await repo.listSeedFunding(j.id);
      for (const s of items ?? []) {
        const day = dayOfDate(s.createdAt);
        if (!day || day < from || day > to) continue;
        const amount = BigInt(s.amount ?? 0);
        if (amount > 0n) out.push({ operatorId: j.operatorId ?? operatorId ?? '', day, amount });
      }
    }
    return out;
  }
}

export interface DashboardDay {
  day: string;
  registrations: number;
  logins: number;
  activePlayers: number;
  depositors: number;
  ftdCount: number;
  ftdAmount: bigint;
  depositsAmount: bigint;
  withdrawalsAmount: bigint;
  betCount: number;
  bets: bigint;
  wins: bigint;
  ggr: bigint;
  bonusCost: bigint;
  jackpotFunding: bigint;
  ngr: bigint;
}

export interface RetentionStat {
  eligible: number;
  retained: number;
  rate: number | null;
}

export interface Dashboard {
  operatorId: string | null;
  from: string;
  to: string;
  totals: Omit<DashboardDay, 'day'> & { bettors: number; withdrawalsCount: number; depositsCount: number; netDeposits: bigint; hold: number | null };
  days: DashboardDay[];
  retention: { d1: RetentionStat; d7: RetentionStat; d30: RetentionStat };
  formulas: Record<string, string>;
  warnings: string[];
}

export const FORMULAS = {
  ggr: 'GGR = Σ apuestas liquidadas − Σ ganancias (bet.settled)',
  ngr: 'NGR = GGR − bonos otorgados − jackpots financiados por la casa',
  ftd: 'FTD = depósitos con isFirst=true',
  retention: 'Dn = % de los registrados el día d (con d+n ya transcurrido) con actividad el día d+n',
} as const;

const MAX_DAYS = 366;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function normalizeRange(from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
  const today = now.toISOString().slice(0, 10);
  const t = to ?? today;
  const f = from ?? addDays(t, -29);
  if (!DAY_RE.test(f) || !DAY_RE.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t))) throw new RangeError('Fechas inválidas (usa YYYY-MM-DD)');
  if (f > t) throw new RangeError('from debe ser anterior o igual a to');
  if (daysBetween(f, t).length > MAX_DAYS) throw new RangeError(`Rango máximo ${MAX_DAYS} días`);
  return { from: f, to: t };
}

export class DashboardService {
  constructor(
    private readonly repo: KpiRepository,
    private readonly costs: CostSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Filas por operador y día con costos y GGR/NGR (base del dashboard y del CSV kpis-daily). */
  async rows(operatorId: string | undefined, from: string, to: string) {
    const [dayRows, bonus, jack] = await Promise.all([
      this.repo.getDays(operatorId, from, to),
      this.costs.bonusGrants(operatorId, from, to).catch(() => []),
      this.costs.jackpotFunding(operatorId, from, to).catch(() => []),
    ]);
    const map = new Map<string, DayRow>();
    for (const r of dayRows) map.set(`${r.operatorId}|${r.day}`, r);
    const bonusBy = new Map<string, bigint>();
    const jackBy = new Map<string, bigint>();
    for (const [src, dst] of [[bonus, bonusBy], [jack, jackBy]] as const) {
      for (const c of src) {
        const k = `${c.operatorId}|${c.day}`;
        dst.set(k, (dst.get(k) ?? 0n) + c.amount);
        if (!map.has(k)) map.set(k, emptyRow(c.operatorId, c.day));
      }
    }
    return [...map.entries()]
      .map(([k, r]) => {
        const bonusCost = bonusBy.get(k) ?? 0n;
        const jackpotFunding = jackBy.get(k) ?? 0n;
        const ggr = r.settledStake - r.settledWins;
        return { ...r, ggr, bonusCost, jackpotFunding, ngr: ggr - bonusCost - jackpotFunding };
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.operatorId.localeCompare(b.operatorId));
  }

  async dashboard(operatorId: string | undefined, fromQ?: string, toQ?: string): Promise<Dashboard> {
    const { from, to } = normalizeRange(fromQ, toQ, this.clock());
    const rows = await this.rows(operatorId, from, to);
    const byDay = new Map<string, DashboardDay>();
    for (const d of daysBetween(from, to)) byDay.set(d, blankDay(d));
    for (const r of rows) {
      const d = byDay.get(r.day);
      if (!d) continue;
      d.registrations += r.registrations;
      d.logins += r.logins;
      d.activePlayers += r.activePlayers;
      d.depositors += r.depositors;
      d.ftdCount += r.ftdCount;
      d.ftdAmount += r.ftdAmount;
      d.depositsAmount += r.depositsAmount;
      d.withdrawalsAmount += r.withdrawalsAmount;
      d.betCount += r.betCount;
      d.bets += r.settledStake;
      d.wins += r.settledWins;
      d.ggr += r.ggr;
      d.bonusCost += r.bonusCost;
      d.jackpotFunding += r.jackpotFunding;
      d.ngr += r.ngr;
    }
    const days = [...byDay.values()];
    const sum = (k: Exclude<keyof DashboardDay, 'day'>): number | bigint => {
      let n = 0;
      let b = 0n;
      for (const d of days) {
        const v = d[k];
        if (typeof v === 'bigint') b += v;
        else n += v;
      }
      return typeof days[0]?.[k] === 'bigint' ? b : n;
    };
    const [uniqDep, uniqActive, uniqBettors] = await Promise.all([
      this.repo.distinctPlayers(operatorId, from, to, 'depositor'),
      this.repo.distinctPlayers(operatorId, from, to, 'active'),
      this.repo.distinctPlayers(operatorId, from, to, 'bettor'),
    ]);
    const tot = {
      registrations: sum('registrations') as number,
      logins: sum('logins') as number,
      activePlayers: uniqActive,
      depositors: uniqDep,
      bettors: uniqBettors,
      ftdCount: sum('ftdCount') as number,
      ftdAmount: sum('ftdAmount') as bigint,
      depositsAmount: sum('depositsAmount') as bigint,
      depositsCount: rows.reduce((a, r) => a + r.depositsCount, 0),
      withdrawalsAmount: sum('withdrawalsAmount') as bigint,
      withdrawalsCount: rows.reduce((a, r) => a + r.withdrawalsCount, 0),
      betCount: sum('betCount') as number,
      bets: sum('bets') as bigint,
      wins: sum('wins') as bigint,
      ggr: sum('ggr') as bigint,
      bonusCost: sum('bonusCost') as bigint,
      jackpotFunding: sum('jackpotFunding') as bigint,
      ngr: sum('ngr') as bigint,
    };
    const retention = await this.retention(operatorId, from, to);
    const warnings = this.costs.missing().map((m) => `Fuente de costos no disponible (${m}): NGR sin ese costo`);
    return {
      operatorId: operatorId ?? null,
      from,
      to,
      totals: { ...tot, netDeposits: tot.depositsAmount - tot.withdrawalsAmount, hold: tot.bets > 0n ? Number((tot.ggr * 10000n) / tot.bets) / 100 : null },
      days,
      retention,
      formulas: { ...FORMULAS },
      warnings,
    };
  }

  /** Retención por cohorte de registro (jugadores registrados en [from,to]). */
  async retention(operatorId: string | undefined, from: string, to: string): Promise<Dashboard['retention']> {
    const today = this.clock().toISOString().slice(0, 10);
    const regs = await this.repo.listRegistrations(operatorId, from, to);
    const stats = { d1: { eligible: 0, retained: 0 }, d7: { eligible: 0, retained: 0 }, d30: { eligible: 0, retained: 0 } };
    const byOp = new Map<string, typeof regs>();
    for (const r of regs) byOp.set(r.operatorId, [...(byOp.get(r.operatorId) ?? []), r]);
    for (const [op, list] of byOp) {
      const active = await this.repo.activeDaysOf(op, list.map((r) => r.playerId));
      for (const r of list) {
        const days = active.get(r.playerId);
        for (const [key, n] of [['d1', 1], ['d7', 7], ['d30', 30]] as const) {
          const target = addDays(r.day, n);
          if (target > today) continue; // cohorte aún no madura
          stats[key].eligible += 1;
          if (days?.has(target)) stats[key].retained += 1;
        }
      }
    }
    const fin = (s: { eligible: number; retained: number }): RetentionStat => ({ ...s, rate: s.eligible > 0 ? Math.round((s.retained / s.eligible) * 10000) / 100 : null });
    return { d1: fin(stats.d1), d7: fin(stats.d7), d30: fin(stats.d30) };
  }
}

function blankDay(day: string): DashboardDay {
  return { day, registrations: 0, logins: 0, activePlayers: 0, depositors: 0, ftdCount: 0, ftdAmount: 0n, depositsAmount: 0n, withdrawalsAmount: 0n, betCount: 0, bets: 0n, wins: 0n, ggr: 0n, bonusCost: 0n, jackpotFunding: 0n, ngr: 0n };
}
