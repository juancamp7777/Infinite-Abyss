import type { GameMath, PlayOptions } from './GameMath';
import { SeededRng } from './fairness/Rng';

export interface SimOptions {
  spins: number;
  seed: number;
  bonusBuy?: boolean;
  params?: Record<string, unknown>;
  rtpProfile?: string;
}

/** Límites inferiores de los buckets de distribución (en veces la apuesta). */
export const DIST_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '0', min: 0, max: 0 },
  { label: '(0,1)', min: 0, max: 1 },
  { label: '[1,2)', min: 1, max: 2 },
  { label: '[2,5)', min: 2, max: 5 },
  { label: '[5,20)', min: 5, max: 20 },
  { label: '[20,100)', min: 20, max: 100 },
  { label: '[100,1000)', min: 100, max: 1000 },
  { label: '[1000,inf)', min: 1000, max: Infinity },
];

export interface SimBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  /** Fracción de rondas en el bucket. */
  share: number;
  /** Fracción del RTP aportada por el bucket. */
  rtpShare: number;
}

export interface SimReport {
  gameId: string;
  spins: number;
  seed: number;
  bonusBuy: boolean;
  /** Retorno medio por unidad apostada (con bonusBuy: sobre el coste de la compra). */
  rtp: number;
  hitRate: number;
  /** Desviación estándar del retorno por unidad apostada (índice de volatilidad). */
  stdDev: number;
  /** Intervalo de confianza del 95 % del RTP. */
  ci95: [number, number];
  maxMultiplier: number;
  bonusFrequency: number;
  /** 1 / bonusFrequency (rondas por bonus), Infinity si nunca. */
  bonusEvery: number;
  distribution: SimBucket[];
  durationMs: number;
}

/** Acumulador fusionable (para repartir la simulación entre workers). */
export interface SimAccumulator {
  spins: number;
  sum: number;
  sumSq: number;
  hits: number;
  bonus: number;
  max: number;
  counts: number[];
  sums: number[];
}

export function emptyAccumulator(): SimAccumulator {
  return { spins: 0, sum: 0, sumSq: 0, hits: 0, bonus: 0, max: 0, counts: DIST_BUCKETS.map(() => 0), sums: DIST_BUCKETS.map(() => 0) };
}

function bucketIndex(m: number): number {
  if (m <= 0) return 0;
  if (m < 1) return 1;
  if (m < 2) return 2;
  if (m < 5) return 3;
  if (m < 20) return 4;
  if (m < 100) return 5;
  if (m < 1000) return 6;
  return 7;
}

/** Ejecuta `opts.spins` rondas y acumula (sin finalizar). */
export function runAccumulate(game: GameMath<any, any>, opts: SimOptions): SimAccumulator {
  if (opts.bonusBuy && !game.bonusBuy) throw new Error(`${game.id} no admite bonus buy`);
  const rng = new SeededRng(opts.seed);
  const playOpts: PlayOptions = { bonusBuy: !!opts.bonusBuy, params: opts.params, rtpProfile: opts.rtpProfile };
  const acc = emptyAccumulator();
  const { counts, sums } = acc;
  let sum = 0;
  let sumSq = 0;
  let hits = 0;
  let bonus = 0;
  let max = 0;
  for (let i = 0; i < opts.spins; i++) {
    const r = game.play(rng, playOpts);
    const m = r.multiplier;
    sum += m;
    sumSq += m * m;
    if (m > 0) hits++;
    if (r.bonusTriggered) bonus++;
    if (m > max) max = m;
    const b = bucketIndex(m);
    counts[b]++;
    sums[b] += m;
  }
  acc.spins = opts.spins;
  acc.sum = sum;
  acc.sumSq = sumSq;
  acc.hits = hits;
  acc.bonus = bonus;
  acc.max = max;
  return acc;
}

export function mergeAccumulators(list: SimAccumulator[]): SimAccumulator {
  const out = emptyAccumulator();
  for (const a of list) {
    out.spins += a.spins;
    out.sum += a.sum;
    out.sumSq += a.sumSq;
    out.hits += a.hits;
    out.bonus += a.bonus;
    out.max = Math.max(out.max, a.max);
    a.counts.forEach((c, i) => (out.counts[i] += c));
    a.sums.forEach((s, i) => (out.sums[i] += s));
  }
  return out;
}

export function finalizeReport(
  game: Pick<GameMath<any, any>, 'id' | 'bonusBuy'>,
  acc: SimAccumulator,
  meta: { seed: number; bonusBuy?: boolean; durationMs: number },
): SimReport {
  const n = Math.max(acc.spins, 1);
  const cost = meta.bonusBuy && game.bonusBuy ? game.bonusBuy.costMultiplier : 1;
  const mean = acc.sum / n;
  const variance = Math.max(acc.sumSq / n - mean * mean, 0);
  const rtp = mean / cost;
  const stdDev = Math.sqrt(variance) / cost;
  const half = (1.96 * stdDev) / Math.sqrt(n);
  const bonusFrequency = acc.bonus / n;
  return {
    gameId: game.id,
    spins: acc.spins,
    seed: meta.seed,
    bonusBuy: !!meta.bonusBuy,
    rtp,
    hitRate: acc.hits / n,
    stdDev,
    ci95: [rtp - half, rtp + half],
    maxMultiplier: acc.max,
    bonusFrequency,
    bonusEvery: bonusFrequency > 0 ? 1 / bonusFrequency : Infinity,
    distribution: DIST_BUCKETS.map((b, i) => ({
      ...b,
      count: acc.counts[i],
      share: acc.counts[i] / n,
      rtpShare: acc.sum > 0 ? acc.sums[i] / acc.sum : 0,
    })),
    durationMs: meta.durationMs,
  };
}

/** Simulación síncrona en un hilo (pruebas y corridas cortas). Para corridas largas usa el CLI con --workers. */
export function simulate(game: GameMath<any, any>, opts: SimOptions): SimReport {
  const t0 = Date.now();
  const acc = runAccumulate(game, opts);
  return finalizeReport(game, acc, { seed: opts.seed, bonusBuy: opts.bonusBuy, durationMs: Date.now() - t0 });
}
