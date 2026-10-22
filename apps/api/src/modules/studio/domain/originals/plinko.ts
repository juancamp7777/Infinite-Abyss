import type { PlayOptions, PlayResult } from '../GameMath';
import type { Rng } from '../fairness/Rng';
import { GameParamError, OriginalGameMath, resolveOriginalRtp } from './types';

/**
 * Nymfo Plinko: n filas (8–16), cada clavija desvía a la derecha con p = 1/2 → casilla k ~ Binomial(n, 1/2).
 * Las tablas de pago son propias y se calculan para el RTP objetivo con la distribución binomial exacta:
 *   m_k = centro + (borde − centro) · (g^d − g^dmin) / (g^dmax − g^dmin),  d = |k − n/2|
 * donde centro/borde dependen del riesgo y g (convexidad) se resuelve por bisección para que Σ P(k)·m_k = RTP.
 * Después se redondean a valores "limpios" y se reajusta g para que el RTP exacto quede a < 0.1 % del objetivo.
 */
export type PlinkoRisk = 'low' | 'medium' | 'high';

export interface PlinkoConfig {
  minRows: number;
  maxRows: number;
  risks: PlinkoRisk[];
  /** Multiplicador del centro y del borde para 8 y 16 filas (el borde se interpola log-linealmente). */
  shape: Record<PlinkoRisk, { center: number; edge8: number; edge16: number }>;
}

export interface PlinkoOutcome {
  rows: number;
  risk: PlinkoRisk;
  /** 0 = izquierda, 1 = derecha en cada fila. */
  path: number[];
  bin: number;
  payout: number;
}

const CONFIG: PlinkoConfig = {
  minRows: 8,
  maxRows: 16,
  risks: ['low', 'medium', 'high'],
  shape: {
    low: { center: 0.5, edge8: 5.5, edge16: 16 },
    medium: { center: 0.4, edge8: 13, edge16: 110 },
    high: { center: 0.2, edge8: 29, edge16: 1000 },
  },
};

/** Probabilidades binomiales exactas P(k) = C(n,k) / 2^n. */
export function binomialProbs(n: number): number[] {
  const out: number[] = [];
  let c = 1;
  for (let k = 0; k <= n; k++) {
    out.push(c / 2 ** n);
    c = (c * (n - k)) / (k + 1);
  }
  return out;
}

function niceRound(x: number): number {
  if (x >= 100) return Math.round(x);
  if (x >= 10) return Math.round(x * 10) / 10;
  return Math.round(x * 100) / 100;
}

function shapeTable(n: number, center: number, edge: number, logG: number, round: boolean): number[] {
  const g = Math.exp(logG);
  const dists = Array.from({ length: n + 1 }, (_, k) => Math.abs(k - n / 2));
  const dmin = Math.min(...dists);
  const dmax = n / 2;
  const lo = g ** dmin;
  const hi = g ** dmax;
  return dists.map((d) => {
    const m = center + (edge - center) * ((g ** d - lo) / (hi - lo));
    return round ? niceRound(m) : m;
  });
}

export const tableRtp = (table: number[], probs: number[]): number => table.reduce((s, m, k) => s + m * probs[k], 0);

const cache = new Map<string, number[]>();

/** Tabla de pagos (n+1 casillas, simétrica) para filas, riesgo y RTP (fracción). */
export function plinkoTable(rows: number, risk: PlinkoRisk, rtp: number): number[] {
  const key = `${rows}:${risk}:${rtp}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { center, edge8, edge16 } = CONFIG.shape[risk];
  const edge = edge8 * (edge16 / edge8) ** ((rows - 8) / 8);
  const probs = binomialProbs(rows);
  // Σ P·m decrece con g: bisección sobre log g.
  let lo = 1e-6;
  let hi = 12;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tableRtp(shapeTable(rows, center, edge, mid, false), probs) > rtp) lo = mid;
    else hi = mid;
  }
  // Reajuste sobre la tabla redondeada: explorar alrededor y quedarse con la más cercana sin superar el objetivo.
  const base = (lo + hi) / 2;
  let best = shapeTable(rows, center, edge, base, true);
  let bestDiff = Infinity;
  for (let i = -400; i <= 400; i++) {
    const t = shapeTable(rows, center, edge, base * (1 + i / 2000), true);
    const r = tableRtp(t, probs);
    const diff = rtp - r;
    if (diff >= 0 && diff < bestDiff) {
      best = t;
      bestDiff = diff;
    }
  }
  // Ajuste fino voraz: subir pares simétricos un escalón de redondeo mientras el RTP no supere el objetivo.
  best = [...best];
  const step = (m: number) => (m >= 100 ? 1 : m >= 10 ? 0.1 : 0.01);
  for (let guard = 0; guard < 10000; guard++) {
    const current = tableRtp(best, probs);
    let pick = -1;
    let pickGain = 0;
    for (let k = 1; k <= Math.floor(rows / 2); k++) {
      const mirror = rows - k;
      const gain = step(best[k]) * (k === mirror ? probs[k] : probs[k] + probs[mirror]);
      if (current + gain <= rtp + 1e-12 && gain > pickGain) {
        pick = k;
        pickGain = gain;
      }
    }
    if (pick < 0) break;
    const v = niceRound(best[pick] + step(best[pick]));
    best[pick] = v;
    best[rows - pick] = v;
  }
  cache.set(key, best);
  return best;
}

interface PlinkoParams {
  rows: number;
  risk: PlinkoRisk;
}

function parseParams(params: Record<string, unknown> | undefined): PlinkoParams {
  const rows = params?.rows === undefined ? 16 : Number(params.rows);
  const risk = (params?.risk ?? 'medium') as PlinkoRisk;
  if (!Number.isInteger(rows) || rows < CONFIG.minRows || rows > CONFIG.maxRows) {
    throw new GameParamError('rows debe ser un entero entre 8 y 16');
  }
  if (!CONFIG.risks.includes(risk)) throw new GameParamError('risk debe ser low, medium o high');
  return { rows, risk };
}

export const nymfoPlinko: OriginalGameMath<PlinkoConfig, PlinkoOutcome> = {
  id: 'nymfo-plinko',
  name: 'Nymfo Plinko',
  kind: 'original',
  rtpTarget: 0.99,
  rtpRange: { min: 0.96, max: 0.99 },
  volatility: 'high',
  maxWinMultiplier: 1000,
  config: CONFIG,
  validateParams(params) {
    parseParams(params);
  },
  play(rng: Rng, opts?: PlayOptions): PlayResult<PlinkoOutcome> {
    const { rows, risk } = parseParams(opts?.params);
    const rtp = resolveOriginalRtp(opts?.rtpProfile, this.rtpTarget, this.rtpRange);
    const path: number[] = [];
    let bin = 0;
    for (let i = 0; i < rows; i++) {
      const right = rng.nextFloat() < 0.5 ? 1 : 0;
      path.push(right);
      bin += right;
    }
    const payout = plinkoTable(rows, risk, rtp)[bin];
    return { multiplier: payout, outcome: { rows, risk, path, bin, payout }, bonusTriggered: false };
  },
};
