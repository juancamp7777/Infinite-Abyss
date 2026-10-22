import type { ChurnRisk, CrmPlayerView, CrmProfile, Favorite } from './types';

export const DAY_MS = 86_400_000;

export const toDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

export function daysBetween(fromIso: string | undefined, now: Date): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/**
 * Quintil (1–5) por rango percentil dentro de la población: pr = (menores + ½·iguales) / n.
 * Valores "sin actividad" (inactive=true) siempre son quintil 1, así una población toda en cero
 * no recibe un 3 artificial.
 */
function quintileOf(value: number, population: number[], inactive: boolean): number {
  if (inactive || population.length === 0) return 1;
  let less = 0;
  let equal = 0;
  for (const v of population) {
    if (v < value) less++;
    else if (v === value) equal++;
  }
  const pr = (less + equal / 2) / population.length;
  return Math.min(5, 1 + Math.floor(pr * 5));
}

export interface RfmScorer {
  score(p: CrmProfile): { r: number; f: number; m: number };
}

export const activeDaysInWindow = (p: CrmProfile, now: Date, days = 30): number => {
  const from = now.getTime() - days * DAY_MS;
  return p.activeDays.filter((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return t + DAY_MS > from && t <= now.getTime();
  }).length;
};

/**
 * RFM por operador (la población es el conjunto de perfiles del operador):
 *  - R (recencia): quintil de −días desde la última actividad (más reciente → 5).
 *  - F (frecuencia): quintil de días activos en 30 días.
 *  - M (monto): quintil del total apostado.
 */
export function buildRfmScorer(population: CrmProfile[], now: Date): RfmScorer {
  const recency = population.map((p) => -(daysBetween(p.lastActivityAt, now) ?? 10_000));
  const freq = population.map((p) => activeDaysInWindow(p, now));
  const money = population.map((p) => Number(p.totalWagered));
  return {
    score(p) {
      const d = daysBetween(p.lastActivityAt, now);
      const f = activeDaysInWindow(p, now);
      const m = Number(p.totalWagered);
      return {
        r: quintileOf(-(d ?? 10_000), recency, d === null),
        f: quintileOf(f, freq, f === 0),
        m: quintileOf(m, money, m === 0),
      };
    },
  };
}

/**
 * Valor VIP 0–100: combinación ponderada de los quintiles RFM, con el monto como factor principal:
 * 50% M + 30% F + 20% R, reescalado de [1,5] a [0,100]. Sin actividad (1,1,1) → 0; (5,5,5) → 100.
 */
export function vipScoreOf(rfm: { r: number; f: number; m: number }): number {
  const w = 0.5 * rfm.m + 0.3 * rfm.f + 0.2 * rfm.r;
  return Math.round(((w - 1) / 4) * 100);
}

/**
 * Riesgo de abandono (heurística RFM + días sin actividad). Suma puntos:
 *  - días sin actividad: <7 → 0, 7–13 → 1, 14–29 → 2, ≥30 → 3 (sin actividad alguna cuenta como ≥30)
 *  - +1 si la recencia es baja (R ≤ 2) y +1 si la frecuencia es baja (F ≤ 2)
 * Total ≥ 4 → high; ≥ 2 → medium; en otro caso low.
 * Consecuencia: quien jugó en la última semana nunca supera "medium"; quien lleva ≥30 días
 * inactivo es como mínimo "medium" y "high" si además su R o F es bajo.
 */
export function churnRiskOf(daysSince: number | null, rfm: { r: number; f: number }): ChurnRisk {
  const d = daysSince ?? 10_000;
  const dayPoints = d >= 30 ? 3 : d >= 14 ? 2 : d >= 7 ? 1 : 0;
  const points = dayPoints + (rfm.r <= 2 ? 1 : 0) + (rfm.f <= 2 ? 1 : 0);
  return points >= 4 ? 'high' : points >= 2 ? 'medium' : 'low';
}

export function topFavorites(map: Record<string, bigint>, n = 5): Favorite[] {
  return Object.entries(map)
    .map(([id, wagered]) => ({ id, wagered }))
    .sort((a, b) => (a.wagered === b.wagered ? a.id.localeCompare(b.id) : a.wagered > b.wagered ? -1 : 1))
    .slice(0, n);
}

export function enrich(p: CrmProfile, now: Date, scorer: RfmScorer): CrmPlayerView {
  const { activeDays: _a, games, categories, ...rest } = p;
  const rfm = scorer.score(p);
  const daysSince = daysBetween(p.lastActivityAt, now);
  return {
    ...rest,
    ltv: p.depositsTotal - p.withdrawalsTotal,
    ggr: p.totalWagered - p.totalWon,
    activeDays30: activeDaysInWindow(p, now),
    daysSinceLastActivity: daysSince,
    favoriteGames: topFavorites(games),
    favoriteCategories: topFavorites(categories),
    rfm,
    vipScore: vipScoreOf(rfm),
    churnRisk: churnRiskOf(daysSince, rfm),
  };
}
