/**
 * Estimador de RTP de Starfall con reducción de varianza (lo usan la prueba y la calibración).
 *
 * Por linealidad de la esperanza, RTP = E[cascadas del giro base] + E[pago scatter] + P(FS)·E[valor FS], y como la
 * sesión de free spins no depende del giro que la disparó (siempre arranca con 12 giros y RNG nuevo), por la
 * identidad de Wald E[valor FS] = E[N]·E[X], con N = giros jugados (tiempo de parada: el retrigger solo agrega
 * giros futuros) y X = valor de un free spin. P(FS), E[pago scatter] y E[N] son exactos (starfallAnalytics);
 * se simulan solo E[cascadas base], E[X] y, para el bonus buy, E[cascadas del giro comprado]. Esto evita
 * simular sesiones completas (la parte de mayor varianza) y da un error estándar mucho menor con el mismo tiempo.
 * Único sesgo: el tope de 5000x por ronda no entra en la descomposición (se sobrestima el RTP en lo que recorta
 * el tope); se mide aparte con la simulación directa (calibrate.ts / RTP_LONG) y es despreciable.
 */
import { SeededRng } from '../../fairness/Rng';
import { starfall, starfallAnalytics, starfallFastSpin } from './math';

export interface StarfallEstimate {
  rtp: number;
  rtpSe: number;
  bonusBuyRtp: number;
  bonusBuySe: number;
  baseTumble: { mean: number; se: number; hitRate: number };
  freeSpin: { mean: number; sd: number; se: number };
  bonusBuySpin: { mean: number; se: number };
  /** Parte del RTP que aportan los free spins. */
  fsShare: number;
  analytics: ReturnType<typeof starfallAnalytics>;
  durationMs: number;
}

interface Moments {
  n: number;
  sum: number;
  sumSq: number;
}
const mean = (m: Moments) => m.sum / m.n;
const variance = (m: Moments) => Math.max(m.sumSq / m.n - mean(m) ** 2, 0);
const se = (m: Moments) => Math.sqrt(variance(m) / m.n);

export function estimateStarfallRtp(opts: { seed: number; baseSpins: number; freeSpins: number; bonusBuySpins: number }): StarfallEstimate {
  const t0 = Date.now();
  const a = starfallAnalytics();
  const rng = new SeededRng(opts.seed);

  const base: Moments = { n: opts.baseSpins, sum: 0, sumSq: 0 };
  let hits = 0;
  for (let i = 0; i < opts.baseSpins; i++) {
    const t = starfallFastSpin(rng, false).tumbleWin / 100;
    base.sum += t;
    base.sumSq += t * t;
    if (t > 0) hits++;
  }

  const fs: Moments = { n: opts.freeSpins, sum: 0, sumSq: 0 };
  for (let i = 0; i < opts.freeSpins; i++) {
    const x = starfallFastSpin(rng, true).total / 100;
    fs.sum += x;
    fs.sumSq += x * x;
  }

  // Giro comprado: cantidad de scatters según los pesos del bonus buy; se suma solo la parte de cascadas.
  const bb: Moments = { n: opts.bonusBuySpins, sum: 0, sumSq: 0 };
  const cum: number[] = [];
  a.bbCounts.reduce((acc, c) => (cum.push(acc + c.prob), acc + c.prob), 0);
  for (let i = 0; i < opts.bonusBuySpins; i++) {
    const r = rng.nextFloat() * cum[cum.length - 1];
    let k = a.bbCounts.length - 1;
    for (let j = 0; j < cum.length; j++) if (r < cum[j]) { k = j; break; }
    const t = starfallFastSpin(rng, false, a.bbCounts[k].count).tumbleWin / 100;
    bb.sum += t;
    bb.sumSq += t * t;
  }

  const cost = starfall.bonusBuy!.costMultiplier;
  const fsValue = a.expectedFreeSpins * mean(fs);
  const fsPart = a.pTrigger * fsValue;
  const rtp = mean(base) + a.scatterPayEV + fsPart;
  const rtpSe = Math.sqrt(se(base) ** 2 + (a.pTrigger * a.expectedFreeSpins * se(fs)) ** 2);
  const bonusBuyRtp = (mean(bb) + a.bbScatterPayEV + fsValue) / cost;
  const bonusBuySe = Math.sqrt(se(bb) ** 2 + (a.expectedFreeSpins * se(fs)) ** 2) / cost;
  return {
    rtp,
    rtpSe,
    bonusBuyRtp,
    bonusBuySe,
    baseTumble: { mean: mean(base), se: se(base), hitRate: hits / opts.baseSpins },
    freeSpin: { mean: mean(fs), sd: Math.sqrt(variance(fs)), se: se(fs) },
    bonusBuySpin: { mean: mean(bb), se: se(bb) },
    fsShare: fsPart / rtp,
    analytics: a,
    durationMs: Date.now() - t0,
  };
}
