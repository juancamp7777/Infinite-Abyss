/**
 * Starfall Nymphs (nymfo-starfall): slot 6x5 "pay anywhere" con cascadas (tumble), scatter Puerta Estelar
 * que da free spins con retrigger, orbes Supernova multiplicadores (solo en free spins) y bonus buy.
 *
 * Reglas (datos en config.json):
 * - Cada celda se sortea con los pesos del modo (base o free spins), iguales en las 6 columnas.
 * - Paga cada símbolo con 8+ apariciones en cualquier posición (tramos 8–9, 10–11, 12+). Los ganadores se
 *   eliminan, lo de arriba cae y entran símbolos nuevos por arriba hasta que no haya ganancia.
 * - Los símbolos nuevos de las cascadas nunca son scatter: el scatter solo llega en la caída inicial, así el
 *   número de scatters de un giro es Binomial(30, q) y se puede calcular de forma exacta (ver starfallAnalytics).
 * - Scatter: 4+ en el giro base pagan (no se multiplica) y dan 12 free spins; en free spins 3+ dan +4 giros.
 * - Orbes Supernova (2x–100x) solo en free spins: no se eliminan, caen con la cascada y, al terminar las cascadas
 *   del giro, la suma de todos los orbes del tablero multiplica la ganancia de cascadas de ese giro (si > 0).
 * - Bonus buy (100x): el giro de compra fuerza 4, 5 o 6 scatters en posiciones aleatorias.
 * - Tope: 5000x la apuesta base por ronda (giro base + free spins); al alcanzarlo la ronda termina.
 *
 * Aritmética: los pagos se manejan en centésimas de apuesta (enteros) para que la suma de pasos sea exacta.
 * El bucle caliente usa typed arrays reutilizados: play() es síncrono, así que el estado de módulo es seguro.
 */
import type { GameMath, PlayOptions, PlayResult } from '../../GameMath';
import type { Rng } from '../../fairness/Rng';
import rawConfig from './config.json';

export interface StarfallSymbolDef {
  id: string;
  name: string;
  kind: 'pay' | 'scatter' | 'multiplier';
}

export interface StarfallConfig {
  id: string;
  name: string;
  theme: string;
  cols: number;
  rows: number;
  rtpTarget: number;
  maxWinMultiplier: number;
  symbols: StarfallSymbolDef[];
  /** Cantidad mínima de cada tramo: [8, 10, 12] → 8–9, 10–11, 12+. */
  payTiers: [number, number, number];
  /** Pago en veces la apuesta por tramo (múltiplos de 0.01). */
  paytable: Record<string, [number, number, number]>;
  weights: { note?: string; base: number[]; freeSpins: number[] };
  scatter: {
    /** Pago por cantidad de scatters; la clave más alta aplica a esa cantidad o más. */
    pays: Record<string, number>;
    triggerCount: number;
    freeSpins: number;
    retriggerCount: number;
    retriggerSpins: number;
  };
  multipliers: { values: number[]; weights: number[] };
  bonusBuy: { costMultiplier: number; scatterCountWeights: Record<string, number> };
}

// ---------- Outcome serializable (lo anima el frontend) ----------

/** Celdas: id del símbolo ('astra', 'portal', ...) o multiplicador como 'x<valor>' (p. ej. 'x25'). */
export type StarfallCell = string;

export interface StarfallSymbolWin {
  symbol: string;
  count: number;
  /** Pago en veces la apuesta, antes de multiplicadores. */
  pay: number;
}

export interface StarfallTumbleStep {
  wins: StarfallSymbolWin[];
  /** Posiciones eliminadas como [col, row] (row 0 = arriba), referidas a la grilla ANTES de este paso. */
  removed: Array<[number, number]>;
  /** Por columna, símbolos que entran por arriba (de arriba hacia abajo) tras la caída. */
  newSymbols: StarfallCell[][];
  /** Suma de pays de este paso (veces la apuesta, sin multiplicador). */
  stepWin: number;
}

export interface StarfallMultiplier {
  col: number;
  row: number;
  value: number;
}

export interface StarfallSpin {
  /** Grilla inicial por columnas: grid[col][row], row 0 = arriba. */
  grid: StarfallCell[][];
  steps: StarfallTumbleStep[];
  /** Grilla al terminar las cascadas. */
  finalGrid: StarfallCell[][];
  /** Orbes en la grilla final (posiciones finales). */
  multipliers: StarfallMultiplier[];
  /** Suma de orbes (0 si no hay); se aplica a tumbleWin si tumbleWin > 0. */
  multiplierSum: number;
  /** Suma de stepWin. */
  tumbleWin: number;
  scatterCount: number;
  scatterPay: number;
  /** Free spins otorgados por este giro (trigger o retrigger). */
  freeSpinsAwarded: number;
  /** tumbleWin * (multiplierSum || 1) + scatterPay. */
  totalWin: number;
}

export interface StarfallOutcome {
  gameId: 'nymfo-starfall';
  bonusBuy: boolean;
  base: StarfallSpin;
  freeSpins: null | {
    /** Total otorgado (inicial + retriggers). */
    awarded: number;
    played: number;
    spins: StarfallSpin[];
    totalWin: number;
  };
  /** Ganancia total en veces la apuesta base (= PlayResult.multiplier), ya con el tope aplicado. */
  totalWin: number;
  /** true si se alcanzó el tope de maxWinMultiplier (la ronda terminó ahí). */
  capped: boolean;
}

// ---------- Validación y precomputación ----------

const CFG = rawConfig as unknown as StarfallConfig;

function validate(cfg: StarfallConfig): void {
  const n = cfg.symbols.length;
  if (cfg.weights.base.length !== n || cfg.weights.freeSpins.length !== n) throw new Error('starfall: pesos con largo distinto a symbols');
  if (cfg.multipliers.values.length !== cfg.multipliers.weights.length) throw new Error('starfall: multiplicadores mal definidos');
  for (const s of cfg.symbols) {
    if (s.kind === 'pay') {
      const p = cfg.paytable[s.id];
      if (!p || p.length !== 3) throw new Error(`starfall: falta paytable de ${s.id}`);
      for (const v of p) if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) throw new Error(`starfall: pago no múltiplo de 0.01 en ${s.id}`);
    }
  }
  if (cfg.weights.base[cfg.symbols.findIndex((s) => s.kind === 'multiplier')] !== 0) throw new Error('starfall: el multiplicador no puede salir en el juego base');
}
validate(CFG);

const COLS = CFG.cols;
const ROWS = CFG.rows;
const CELLS = COLS * ROWS;
const NSYM = CFG.symbols.length;
const SCATTER = CFG.symbols.findIndex((s) => s.kind === 'scatter');
const MULT = CFG.symbols.findIndex((s) => s.kind === 'multiplier');
const SYMBOL_IDS = CFG.symbols.map((s) => s.id);
const IS_PAY = Uint8Array.from(CFG.symbols.map((s) => (s.kind === 'pay' ? 1 : 0)));
const [TIER1, TIER2, TIER3] = CFG.payTiers;
/** Pagos en centésimas: PAY[sym*3 + tramo]. */
const PAY = new Int32Array(NSYM * 3);
CFG.symbols.forEach((s, i) => {
  if (s.kind === 'pay') for (let t = 0; t < 3; t++) PAY[i * 3 + t] = Math.round(CFG.paytable[s.id][t] * 100);
});
const SCATTER_KEYS = Object.keys(CFG.scatter.pays).map(Number).sort((a, b) => a - b);
/** Pago de scatter en centésimas por cantidad 0..CELLS. */
const SCATTER_PAY = new Int32Array(CELLS + 1);
for (let k = 0; k <= CELLS; k++) {
  let pay = 0;
  for (const key of SCATTER_KEYS) if (k >= key) pay = Math.round(CFG.scatter.pays[String(key)] * 100);
  SCATTER_PAY[k] = pay;
}
const CAP = Math.round(CFG.maxWinMultiplier * 100);

function cumulative(weights: number[]): Float64Array {
  const out = new Float64Array(weights.length);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    if (!(weights[i] >= 0)) throw new Error('starfall: peso negativo');
    acc += weights[i];
    out[i] = acc;
  }
  if (!(acc > 0)) throw new Error('starfall: pesos vacíos');
  return out;
}
const withoutScatter = (w: number[]) => w.map((v, i) => (i === SCATTER ? 0 : v));

/** Distribuciones acumuladas: [base inicial, base cascada, FS inicial, FS cascada]. */
const CUM_BASE = cumulative(CFG.weights.base);
const CUM_BASE_REFILL = cumulative(withoutScatter(CFG.weights.base));
const CUM_FS = cumulative(CFG.weights.freeSpins);
const CUM_FS_REFILL = cumulative(withoutScatter(CFG.weights.freeSpins));
const CUM_MULT = cumulative(CFG.multipliers.weights);
const MULT_VALUES = Int32Array.from(CFG.multipliers.values);
const BB_COUNTS = Object.keys(CFG.bonusBuy.scatterCountWeights).map(Number).sort((a, b) => a - b);
const CUM_BB = cumulative(BB_COUNTS.map((k) => CFG.bonusBuy.scatterCountWeights[String(k)]));

function pick(rng: Rng, cum: Float64Array): number {
  const r = rng.nextFloat() * cum[cum.length - 1];
  for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
  for (let i = cum.length - 1; i >= 0; i--) if (cum[i] > (i > 0 ? cum[i - 1] : 0)) return i;
  return cum.length - 1;
}

// ---------- Estado reutilizado del bucle caliente ----------

const grid = new Uint8Array(CELLS); // índice = col*ROWS + row (row 0 = arriba)
const mval = new Int32Array(CELLS); // valor del orbe si grid[i] === MULT
const counts = new Uint8Array(NSYM);
const winning = new Uint8Array(NSYM);
const perm = new Uint8Array(CELLS);

/** Resultado del último giro (para estadísticas y analítica). */
const last = { tumbleWin: 0, scatterCount: 0, multiplierSum: 0, scatterPay: 0 };

const cellToken = (i: number): StarfallCell => (grid[i] === MULT ? `x${mval[i]}` : SYMBOL_IDS[grid[i]]);
function snapshot(): StarfallCell[][] {
  const out: StarfallCell[][] = [];
  for (let c = 0; c < COLS; c++) {
    const col: StarfallCell[] = [];
    for (let r = 0; r < ROWS; r++) col.push(cellToken(c * ROWS + r));
    out.push(col);
  }
  return out;
}

function drawCell(rng: Rng, i: number, cum: Float64Array): void {
  const s = pick(rng, cum);
  grid[i] = s;
  mval[i] = s === MULT ? MULT_VALUES[pick(rng, CUM_MULT)] : 0;
}

/**
 * Juega un giro (base o free spin). Devuelve la ganancia del giro en centésimas (sin tope) y deja detalles en `last`.
 * forcedScatters > 0 coloca exactamente esa cantidad de scatters (bonus buy) y el resto de celdas sin scatter.
 */
function spinCore(rng: Rng, freeSpin: boolean, forcedScatters: number, rec: StarfallSpin | null): number {
  const cumInit = freeSpin ? CUM_FS : CUM_BASE;
  const cumRefill = freeSpin ? CUM_FS_REFILL : CUM_BASE_REFILL;
  if (forcedScatters > 0) {
    for (let i = 0; i < CELLS; i++) perm[i] = i;
    for (let i = 0; i < forcedScatters; i++) {
      const j = i + rng.nextInt(CELLS - i);
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    grid.fill(255);
    for (let i = 0; i < forcedScatters; i++) {
      grid[perm[i]] = SCATTER;
      mval[perm[i]] = 0;
    }
    for (let i = 0; i < CELLS; i++) if (grid[i] === 255) drawCell(rng, i, cumRefill);
  } else {
    for (let i = 0; i < CELLS; i++) drawCell(rng, i, cumInit);
  }
  if (rec) rec.grid = snapshot();

  let tumbleWin = 0;
  for (;;) {
    counts.fill(0);
    for (let i = 0; i < CELLS; i++) counts[grid[i]]++;
    let stepWin = 0;
    let any = false;
    for (let s = 0; s < NSYM; s++) {
      winning[s] = 0;
      if (!IS_PAY[s]) continue;
      const n = counts[s];
      if (n < TIER1) continue;
      const pay = PAY[s * 3 + (n >= TIER3 ? 2 : n >= TIER2 ? 1 : 0)];
      stepWin += pay;
      winning[s] = 1;
      any = true;
    }
    if (!any) break;
    tumbleWin += stepWin;

    let step: StarfallTumbleStep | null = null;
    if (rec) {
      step = { wins: [], removed: [], newSymbols: [], stepWin: stepWin / 100 };
      for (let s = 0; s < NSYM; s++) if (winning[s]) step.wins.push({ symbol: SYMBOL_IDS[s], count: counts[s], pay: PAY[s * 3 + (counts[s] >= TIER3 ? 2 : counts[s] >= TIER2 ? 1 : 0)] / 100 });
      for (let i = 0; i < CELLS; i++) if (winning[grid[i]]) step.removed.push([Math.floor(i / ROWS), i % ROWS]);
    }
    // Caída por columna: compacta hacia abajo y rellena arriba (de arriba hacia abajo).
    for (let c = 0; c < COLS; c++) {
      const base = c * ROWS;
      let w = ROWS - 1;
      for (let r = ROWS - 1; r >= 0; r--) {
        const g = grid[base + r];
        if (winning[g]) continue;
        if (w !== r) {
          grid[base + w] = g;
          mval[base + w] = mval[base + r];
        }
        w--;
      }
      for (let r = 0; r <= w; r++) drawCell(rng, base + r, cumRefill);
      if (step) {
        const fresh: StarfallCell[] = [];
        for (let r = 0; r <= w; r++) fresh.push(cellToken(base + r));
        step.newSymbols.push(fresh);
      }
    }
    if (rec && step) rec.steps.push(step);
  }

  let scatters = 0;
  let multSum = 0;
  for (let i = 0; i < CELLS; i++) {
    const g = grid[i];
    if (g === SCATTER) scatters++;
    else if (g === MULT) multSum += mval[i];
  }
  const scatterPay = SCATTER_PAY[scatters];
  const total = (tumbleWin > 0 && multSum > 0 ? tumbleWin * multSum : tumbleWin) + scatterPay;
  last.tumbleWin = tumbleWin;
  last.scatterCount = scatters;
  last.multiplierSum = multSum;
  last.scatterPay = scatterPay;

  if (rec) {
    rec.finalGrid = snapshot();
    for (let i = 0; i < CELLS; i++) if (grid[i] === MULT) rec.multipliers.push({ col: Math.floor(i / ROWS), row: i % ROWS, value: mval[i] });
    rec.multiplierSum = multSum;
    rec.tumbleWin = tumbleWin / 100;
    rec.scatterCount = scatters;
    rec.scatterPay = scatterPay / 100;
    rec.totalWin = total / 100;
  }
  return total;
}

const emptySpin = (): StarfallSpin => ({
  grid: [],
  steps: [],
  finalGrid: [],
  multipliers: [],
  multiplierSum: 0,
  tumbleWin: 0,
  scatterCount: 0,
  scatterPay: 0,
  freeSpinsAwarded: 0,
  totalWin: 0,
});

interface RoundStats {
  /** Ganancia de la ronda en centésimas, con tope. */
  total: number;
  bonus: boolean;
  freeSpins: number;
}
const roundStats: RoundStats = { total: 0, bonus: false, freeSpins: 0 };

/** Juega una ronda completa. Si `outcome` no es null, lo rellena (modo juego); si es null no asigna memoria (modo simulación). */
function playRound(rng: Rng, bonusBuy: boolean, outcome: StarfallOutcome | null): RoundStats {
  const forced = bonusBuy ? BB_COUNTS[pick(rng, CUM_BB)] : 0;
  const baseRec = outcome ? outcome.base : null;
  let total = spinCore(rng, false, forced, baseRec);
  let capped = false;
  if (total >= CAP) {
    total = CAP;
    capped = true;
  }
  let awarded = 0;
  let played = 0;
  let fsTotal = 0;
  const triggered = last.scatterCount >= CFG.scatter.triggerCount;
  if (triggered) {
    awarded = CFG.scatter.freeSpins;
    if (baseRec) baseRec.freeSpinsAwarded = awarded;
    if (outcome) outcome.freeSpins = { awarded, played: 0, spins: [], totalWin: 0 };
    let remaining = awarded;
    while (remaining > 0 && !capped) {
      remaining--;
      played++;
      const rec = outcome ? emptySpin() : null;
      const w = spinCore(rng, true, 0, rec);
      fsTotal += w;
      if (last.scatterCount >= CFG.scatter.retriggerCount) {
        remaining += CFG.scatter.retriggerSpins;
        awarded += CFG.scatter.retriggerSpins;
        if (rec) rec.freeSpinsAwarded = CFG.scatter.retriggerSpins;
      }
      if (rec && outcome?.freeSpins) outcome.freeSpins.spins.push(rec);
      total += w;
      if (total >= CAP) {
        total = CAP;
        capped = true;
      }
    }
    if (outcome?.freeSpins) {
      outcome.freeSpins.awarded = awarded;
      outcome.freeSpins.played = played;
      outcome.freeSpins.totalWin = fsTotal / 100;
    }
  }
  if (outcome) {
    outcome.totalWin = total / 100;
    outcome.capped = capped;
  }
  roundStats.total = total;
  roundStats.bonus = triggered;
  roundStats.freeSpins = awarded;
  return roundStats;
}

export const starfall: GameMath<StarfallConfig, StarfallOutcome> = {
  id: 'nymfo-starfall',
  name: CFG.name,
  kind: 'slot',
  rtpTarget: CFG.rtpTarget,
  volatility: 'high',
  maxWinMultiplier: CFG.maxWinMultiplier,
  config: CFG,
  bonusBuy: { costMultiplier: CFG.bonusBuy.costMultiplier },
  play(rng: Rng, opts?: PlayOptions): PlayResult<StarfallOutcome> {
    const outcome: StarfallOutcome = { gameId: 'nymfo-starfall', bonusBuy: !!opts?.bonusBuy, base: emptySpin(), freeSpins: null, totalWin: 0, capped: false };
    const r = playRound(rng, !!opts?.bonusBuy, outcome);
    return { multiplier: r.total / 100, outcome, bonusTriggered: r.bonus, freeSpins: r.bonus ? r.freeSpins : undefined };
  },
};

// ---------- API de simulación rápida y analítica (calibración y pruebas) ----------

/** Ronda sin construir outcome (mismo consumo de RNG que play): devuelve la ganancia en veces la apuesta base. */
export function starfallFastRound(rng: Rng, bonusBuy = false): RoundStats {
  return playRound(rng, bonusBuy, null);
}

/** Un giro aislado sin outcome; devuelve centésimas sin tope y los detalles del giro. */
export function starfallFastSpin(rng: Rng, freeSpin: boolean, forcedScatters = 0): { total: number; tumbleWin: number; scatterCount: number; scatterPay: number } {
  const total = spinCore(rng, freeSpin, forcedScatters, null);
  return { total, tumbleWin: last.tumbleWin, scatterCount: last.scatterCount, scatterPay: last.scatterPay };
}

function binomTail(n: number, q: number, k: number): number {
  let p = 0;
  let c = 1; // C(n, i)
  for (let i = 0; i < k; i++) {
    p += c * q ** i * (1 - q) ** (n - i);
    c = (c * (n - i)) / (i + 1);
  }
  return 1 - p;
}

/**
 * Partes exactas del RTP. El scatter solo llega en la caída inicial, por lo que su cantidad es Binomial(30, q)
 * con q = peso_scatter / suma_pesos. Free spins: cada giro da +retriggerSpins con probabilidad pRetrigger, así que
 * el número esperado de giros (proceso de ramificación) es freeSpins / (1 − retriggerSpins · pRetrigger).
 */
export function starfallAnalytics() {
  const cfg = CFG;
  const sc = cfg.symbols.findIndex((s) => s.kind === 'scatter');
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
  const n = cfg.cols * cfg.rows;
  const qBase = cfg.weights.base[sc] / sum(cfg.weights.base);
  const qFs = cfg.weights.freeSpins[sc] / sum(cfg.weights.freeSpins);
  const pTrigger = binomTail(n, qBase, cfg.scatter.triggerCount);
  const pRetrigger = binomTail(n, qFs, cfg.scatter.retriggerCount);
  const growth = cfg.scatter.retriggerSpins * pRetrigger;
  if (growth >= 1) throw new Error('starfall: retrigger explosivo');
  const expectedFreeSpins = cfg.scatter.freeSpins / (1 - growth);
  // E[pago scatter] del giro base natural.
  let scatterPayEV = 0;
  let c = 1;
  for (let k = 0; k <= n; k++) {
    scatterPayEV += c * qBase ** k * (1 - qBase) ** (n - k) * (SCATTER_PAY[k] / 100);
    c = (c * (n - k)) / (k + 1);
  }
  const bbTotal = BB_COUNTS.reduce((a, k) => a + cfg.bonusBuy.scatterCountWeights[String(k)], 0);
  const bbScatterPayEV = BB_COUNTS.reduce((a, k) => a + (cfg.bonusBuy.scatterCountWeights[String(k)] / bbTotal) * (SCATTER_PAY[k] / 100), 0);
  const bbCounts = BB_COUNTS.map((k) => ({ count: k, prob: cfg.bonusBuy.scatterCountWeights[String(k)] / bbTotal }));
  return { qBase, qFs, pTrigger, pRetrigger, expectedFreeSpins, scatterPayEV, bbScatterPayEV, bbCounts };
}
