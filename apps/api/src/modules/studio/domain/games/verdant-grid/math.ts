/**
 * Verdant Grid — slot de clusters 7x7 de Abyss Studios (tema: jardín botánico encantado).
 *
 * Reglas (datos en config.json):
 *  - Grilla 7x7 rellenada símbolo a símbolo por pesos. Gana todo grupo de `minCluster` (5) o más símbolos iguales
 *    conectados en horizontal o vertical (no diagonal). Premio = pago(tamaño) x suma de multiplicadores de posición
 *    del cluster (si ninguna posición del cluster tiene multiplicador, x1).
 *  - Cascadas: los símbolos ganadores explotan, los de arriba caen y entran nuevos desde arriba (pesos *Refill*, sin
 *    scatters). Se repite mientras haya clusters (con tope de seguridad maxCascades).
 *  - Multiplicadores de posición: la primera explosión en una celda la deja "marcada"; la siguiente la convierte en
 *    x2 (`first`) y cada explosión posterior lo duplica hasta `cap` (x1024). Las marcas permanecen en la celda
 *    aunque caigan símbolos nuevos. En el juego base se reinician tras cada giro; en los giros gratis persisten
 *    durante todo el bonus.
 *  - Scatter "Fuente Encantada": solo aparece en el relleno inicial de cada giro; paga sobre la apuesta total y con
 *    3+ otorga 10 giros gratis (retrigger: +5 por 3+ scatters, hasta maxTotal).
 *  - Bonus buy a 100x la apuesta: entra directamente a los giros gratis.
 *  - Ganancia máxima por ronda: maxWinMultiplier (5000x); al alcanzarla la ronda termina.
 *
 * Todos los cálculos internos son enteros en unidades de 1e-4 de la apuesta (sin errores de redondeo flotante).
 * Celdas indexadas como idx = fila * 7 + columna (fila 0 = arriba).
 */
import type { GameMath, PlayOptions, PlayResult } from '../../GameMath';
import type { Rng } from '../../fairness/Rng';

export interface VerdantSymbol {
  id: number;
  key: string;
  name: string;
  kind: 'high' | 'low' | 'scatter';
}

export interface VerdantConfig {
  id: string;
  name: string;
  rtpTarget: number;
  maxWinMultiplier: number;
  rows: number;
  cols: number;
  minCluster: number;
  symbols: VerdantSymbol[];
  scatter: number;
  /** Pesos por símbolo (índice = id). *Refill* se usa para las caídas (cascadas). */
  weights: { base: number[]; baseRefill: number[]; freeSpins: number[]; freeSpinsRefill: number[] };
  /** pays[símbolo][i] = pago (veces la apuesta) para un cluster de sizes[i] (el último vale para ese tamaño o mayor). */
  paytable: { sizes: number[]; pays: number[][] };
  positionMultipliers: { first: number; cap: number };
  /** Pago del scatter en veces la apuesta, índice = nº de scatters (el último vale para ese número o más). */
  scatterPays: number[];
  freeSpins: { triggerCount: number; award: number; retriggerAward: number; maxTotal: number };
  bonusBuy: { costMultiplier: number; freeSpins: number };
  maxCascades: number;
}

export interface VerdantCluster {
  symbol: number;
  /** Índices de celda (fila * 7 + columna). */
  positions: number[];
  size: number;
  /** Pago base del cluster (veces la apuesta) antes del multiplicador. */
  basePay: number;
  /** Suma de multiplicadores de posición aplicada (1 si no había ninguno). */
  multiplier: number;
  /** Premio del cluster en veces la apuesta. */
  win: number;
}

export interface VerdantCascadeStep {
  /** Grilla antes de evaluar el paso (49 ids, fila a fila). */
  grid: number[];
  /** Multiplicadores de posición vigentes al evaluar el paso (0 = sin marca, 1 = marcada, ≥2 = multiplicador). */
  multipliers: number[];
  clusters: VerdantCluster[];
  /** Premio del paso (veces la apuesta). */
  win: number;
  /** Multiplicadores tras las explosiones de este paso. */
  multipliersAfter: number[];
}

export interface VerdantSpin {
  steps: VerdantCascadeStep[];
  /** Grilla final (sin clusters). */
  finalGrid: number[];
  scatterCount: number;
  /** Índices de los scatters del relleno inicial. */
  scatterPositions: number[];
  scatterWin: number;
  /** Premio del giro (clusters + scatter) en veces la apuesta. */
  win: number;
  freeSpinsAwarded: number;
}

export interface VerdantOutcome {
  game: 'nymfo-verdant-grid';
  bonusBuy: boolean;
  /** Giro base (null si fue bonus buy). */
  base: VerdantSpin | null;
  freeSpins: { totalAwarded: number; spins: VerdantSpin[]; win: number } | null;
  /** Ganancia total (con tope) en veces la apuesta base. */
  totalWin: number;
  capped: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const VERDANT_CONFIG = require('./config.json') as VerdantConfig;

export const UNITS = 10_000;

/** Tabla de pesos acumulada para muestreo rápido. */
class WeightTable {
  readonly cum: Float64Array;
  readonly total: number;
  constructor(weights: number[]) {
    this.cum = new Float64Array(weights.length);
    let t = 0;
    weights.forEach((w, i) => {
      if (!(w >= 0)) throw new Error('Peso inválido');
      t += w;
      this.cum[i] = t;
    });
    if (!(t > 0)) throw new Error('Suma de pesos 0');
    this.total = t;
  }
  pick(rng: Rng): number {
    const r = rng.nextFloat() * this.total;
    const cum = this.cum;
    for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
    for (let i = cum.length - 1; i >= 0; i--) if (cum[i] > (i ? cum[i - 1] : 0)) return i;
    return cum.length - 1;
  }
}

export class VerdantEngine {
  readonly R: number;
  readonly C: number;
  readonly N: number;
  readonly S: number;
  readonly minCluster: number;
  /** payUnits[sym * (N + 1) + size] */
  readonly payUnits: Int32Array;
  readonly scatterUnits: Int32Array;
  readonly capUnits: number;
  readonly tBase: WeightTable;
  readonly tBaseRefill: WeightTable;
  readonly tFs: WeightTable;
  readonly tFsRefill: WeightTable;
  // Buffers de trabajo.
  readonly grid: Int8Array;
  /** Multiplicador de posición: 0 sin marca, 1 marcada, ≥2 multiplicador. */
  readonly mult: Int32Array;
  readonly visited: Uint8Array;
  readonly exploded: Uint8Array;
  readonly stack: Int32Array;
  readonly members: Int32Array;
  readonly clusterStart: Int32Array;
  readonly clusterSym: Int8Array;
  readonly clusterUnits: Float64Array;
  readonly clusterMult: Int32Array;
  nClusters = 0;
  nMembers = 0;

  constructor(readonly config: VerdantConfig) {
    this.R = config.rows;
    this.C = config.cols;
    this.N = this.R * this.C;
    this.S = config.scatter;
    this.minCluster = config.minCluster;
    const nSym = config.symbols.length;
    this.payUnits = new Int32Array(nSym * (this.N + 1));
    const { sizes, pays } = config.paytable;
    pays.forEach((row, sym) => {
      for (let size = this.minCluster; size <= this.N; size++) {
        let k = -1;
        for (let i = 0; i < sizes.length; i++) if (sizes[i] <= size) k = i;
        if (k < 0) continue;
        const u = Math.round(row[k] * UNITS);
        if (Math.abs(u - row[k] * UNITS) > 1e-6) throw new Error(`Pago no representable en 1e-4: ${sym}/${size}`);
        this.payUnits[sym * (this.N + 1) + size] = u;
      }
    });
    this.scatterUnits = new Int32Array(this.N + 1);
    for (let n = 0; n <= this.N; n++) this.scatterUnits[n] = Math.round(config.scatterPays[Math.min(n, config.scatterPays.length - 1)] * UNITS);
    this.capUnits = config.maxWinMultiplier * UNITS;
    this.tBase = new WeightTable(config.weights.base);
    this.tBaseRefill = new WeightTable(config.weights.baseRefill);
    this.tFs = new WeightTable(config.weights.freeSpins);
    this.tFsRefill = new WeightTable(config.weights.freeSpinsRefill);
    if (config.weights.baseRefill[this.S] || config.weights.freeSpinsRefill[this.S]) throw new Error('Los rellenos no deben traer scatters');
    this.grid = new Int8Array(this.N);
    this.mult = new Int32Array(this.N);
    this.visited = new Uint8Array(this.N);
    this.exploded = new Uint8Array(this.N);
    this.stack = new Int32Array(this.N);
    this.members = new Int32Array(this.N);
    this.clusterStart = new Int32Array(this.N + 1);
    this.clusterSym = new Int8Array(this.N);
    this.clusterUnits = new Float64Array(this.N);
    this.clusterMult = new Int32Array(this.N);
  }

  fill(table: WeightTable, rng: Rng): void {
    for (let i = 0; i < this.N; i++) this.grid[i] = table.pick(rng);
  }

  /**
   * Busca clusters (≥ minCluster, adyacencia ortogonal) en la grilla actual. Deja los miembros en members[],
   * agrupados por clusterStart[]. No calcula pagos. Los scatters nunca forman cluster.
   */
  findClusters(): number {
    const { R, C, N, grid, visited, stack, members, clusterStart, clusterSym } = this;
    visited.fill(0);
    let nC = 0;
    let nM = 0;
    for (let start = 0; start < N; start++) {
      if (visited[start]) continue;
      const sym = grid[start];
      visited[start] = 1;
      if (sym === this.S || sym < 0) continue;
      let sp = 0;
      let cnt = 0;
      const base = nM;
      stack[sp++] = start;
      while (sp > 0) {
        const i = stack[--sp];
        members[nM + cnt++] = i;
        const r = (i / C) | 0;
        const c = i - r * C;
        if (r > 0 && !visited[i - C] && grid[i - C] === sym) {
          visited[i - C] = 1;
          stack[sp++] = i - C;
        }
        if (r < R - 1 && !visited[i + C] && grid[i + C] === sym) {
          visited[i + C] = 1;
          stack[sp++] = i + C;
        }
        if (c > 0 && !visited[i - 1] && grid[i - 1] === sym) {
          visited[i - 1] = 1;
          stack[sp++] = i - 1;
        }
        if (c < C - 1 && !visited[i + 1] && grid[i + 1] === sym) {
          visited[i + 1] = 1;
          stack[sp++] = i + 1;
        }
      }
      if (cnt >= this.minCluster) {
        clusterStart[nC] = base;
        clusterSym[nC] = sym;
        nC++;
        nM += cnt;
      }
    }
    clusterStart[nC] = nM;
    this.nClusters = nC;
    this.nMembers = nM;
    return nC;
  }

  /** Calcula los pagos de los clusters encontrados con los multiplicadores vigentes. Devuelve unidades. */
  payClusters(): number {
    const { members, clusterStart, mult } = this;
    let total = 0;
    for (let k = 0; k < this.nClusters; k++) {
      const a = clusterStart[k];
      const b = clusterStart[k + 1];
      let m = 0;
      for (let j = a; j < b; j++) if (mult[members[j]] >= 2) m += mult[members[j]];
      if (m === 0) m = 1;
      const u = this.payUnits[this.clusterSym[k] * (this.N + 1) + (b - a)] * m;
      this.clusterMult[k] = m;
      this.clusterUnits[k] = u;
      total += u;
    }
    return total;
  }

  /** Marca/duplica multiplicadores en las celdas explotadas y aplica la caída con relleno. */
  explodeAndDrop(refill: WeightTable, rng: Rng): void {
    const { R, C, grid, mult, members, exploded } = this;
    const { first, cap } = this.config.positionMultipliers;
    exploded.fill(0);
    for (let j = 0; j < this.nMembers; j++) {
      const i = members[j];
      exploded[i] = 1;
      const m = mult[i];
      mult[i] = m === 0 ? 1 : m === 1 ? first : Math.min(m * 2, cap);
    }
    for (let c = 0; c < C; c++) {
      let write = R - 1;
      for (let r = R - 1; r >= 0; r--) {
        const i = r * C + c;
        if (!exploded[i]) {
          grid[write * C + c] = grid[i];
          write--;
        }
      }
      // Relleno desde arriba: se rellena de abajo hacia arriba para que la animación sea natural.
      for (let r = write; r >= 0; r--) grid[r * C + c] = refill.pick(rng);
    }
  }

  countScatters(): number {
    let n = 0;
    for (let i = 0; i < this.N; i++) if (this.grid[i] === this.S) n++;
    return n;
  }

  /**
   * Un giro completo (relleno + cascadas) sobre los multiplicadores actuales. Si record, devuelve el detalle.
   * `budget` = unidades que aún se pueden ganar antes del tope (las cascadas se detienen al alcanzarlo).
   */
  spin(fill: WeightTable, refill: WeightTable, rng: Rng, budget: number, record: boolean): { units: number; scatters: number; spin: VerdantSpin | null } {
    this.fill(fill, rng);
    const scatters = this.countScatters();
    const scatterPositions: number[] = [];
    if (record) for (let i = 0; i < this.N; i++) if (this.grid[i] === this.S) scatterPositions.push(i);
    const scatterU = this.scatterUnits[scatters];
    let units = scatterU;
    const steps: VerdantCascadeStep[] = [];
    for (let k = 0; k < this.config.maxCascades && units < budget; k++) {
      if (!this.findClusters()) break;
      const stepU = this.payClusters();
      let snap: VerdantCascadeStep | null = null;
      if (record) {
        snap = { grid: Array.from(this.grid), multipliers: Array.from(this.mult), clusters: this.clustersSnapshot(), win: stepU / UNITS, multipliersAfter: [] };
      }
      units += stepU;
      this.explodeAndDrop(refill, rng);
      if (snap) {
        snap.multipliersAfter = Array.from(this.mult);
        steps.push(snap);
      }
    }
    if (!record) return { units, scatters, spin: null };
    return {
      units,
      scatters,
      spin: {
        steps,
        finalGrid: Array.from(this.grid),
        scatterCount: scatters,
        scatterPositions,
        scatterWin: scatterU / UNITS,
        win: units / UNITS,
        freeSpinsAwarded: 0,
      },
    };
  }

  /**
   * Evalúa los clusters de una grilla dada (49 ids, fila a fila) con unos multiplicadores de posición opcionales,
   * sin explotar ni rellenar. Útil para pruebas y para reproducir rondas.
   */
  evaluateClusters(grid: ArrayLike<number>, multipliers?: ArrayLike<number>): VerdantCluster[] {
    for (let i = 0; i < this.N; i++) {
      this.grid[i] = grid[i];
      this.mult[i] = multipliers ? multipliers[i] : 0;
    }
    this.findClusters();
    this.payClusters();
    return this.clustersSnapshot();
  }

  clustersSnapshot(): VerdantCluster[] {
    const out: VerdantCluster[] = [];
    for (let k = 0; k < this.nClusters; k++) {
      const a = this.clusterStart[k];
      const b = this.clusterStart[k + 1];
      const positions = Array.from(this.members.subarray(a, b)).sort((x, y) => x - y);
      const basePay = this.payUnits[this.clusterSym[k] * (this.N + 1) + (b - a)] / UNITS;
      out.push({ symbol: this.clusterSym[k], positions, size: b - a, basePay, multiplier: this.clusterMult[k], win: this.clusterUnits[k] / UNITS });
    }
    return out;
  }

  /** Sesión de giros gratis (multiplicadores persistentes). `alreadyWon` en unidades para el tope. */
  freeSpinsSession(rng: Rng, award: number, alreadyWon: number, record: boolean): { units: number; totalAwarded: number; spins: VerdantSpin[] } {
    const fs = this.config.freeSpins;
    this.mult.fill(0);
    let remaining = award;
    let totalAwarded = award;
    let units = 0;
    const spins: VerdantSpin[] = [];
    while (remaining > 0 && alreadyWon + units < this.capUnits) {
      remaining--;
      const r = this.spin(this.tFs, this.tFsRefill, rng, this.capUnits - alreadyWon - units, record);
      units += r.units;
      let awarded = 0;
      if (r.scatters >= fs.triggerCount) {
        awarded = Math.max(0, Math.min(fs.retriggerAward, fs.maxTotal - totalAwarded));
        totalAwarded += awarded;
        remaining += awarded;
      }
      if (r.spin) {
        r.spin.freeSpinsAwarded = awarded;
        spins.push(r.spin);
      }
    }
    return { units, totalAwarded, spins };
  }

  /** Ronda completa. */
  playRound(rng: Rng, bonusBuy: boolean, record: boolean): { units: number; triggered: boolean; outcome: VerdantOutcome | null; fsAwarded: number } {
    const fsCfg = this.config.freeSpins;
    let units = 0;
    let base: VerdantSpin | null = null;
    let triggered = bonusBuy;
    let award = this.config.bonusBuy.freeSpins;
    if (!bonusBuy) {
      this.mult.fill(0);
      const r = this.spin(this.tBase, this.tBaseRefill, rng, this.capUnits, record);
      units = r.units;
      triggered = r.scatters >= fsCfg.triggerCount;
      award = fsCfg.award;
      if (r.spin) {
        r.spin.freeSpinsAwarded = triggered ? award : 0;
        base = r.spin;
      }
    }
    let freeSpins: VerdantOutcome['freeSpins'] = null;
    let fsAwarded = 0;
    if (triggered && units < this.capUnits) {
      const fs = this.freeSpinsSession(rng, award, units, record);
      units += fs.units;
      fsAwarded = fs.totalAwarded;
      if (record) freeSpins = { totalAwarded: fs.totalAwarded, spins: fs.spins, win: fs.units / UNITS };
    }
    const capped = units >= this.capUnits;
    const total = Math.min(units, this.capUnits);
    const outcome: VerdantOutcome | null = record
      ? { game: 'nymfo-verdant-grid', bonusBuy, base, freeSpins, totalWin: total / UNITS, capped }
      : null;
    return { units: total, triggered, outcome, fsAwarded };
  }
}

export const verdantEngine = new VerdantEngine(VERDANT_CONFIG);

/** Ronda sin registro (rápida) para simulaciones: devuelve la ganancia en veces la apuesta base. */
export function verdantFastRound(rng: Rng, bonusBuy = false): { win: number; triggered: boolean } {
  const r = verdantEngine.playRound(rng, bonusBuy, false);
  return { win: r.units / UNITS, triggered: r.triggered };
}

/** Probabilidades exactas del relleno inicial del juego base (scatters i.i.d. por celda: Binomial(49, p)). */
export function verdantAnalytic(engine: VerdantEngine = verdantEngine): { scatterProb: number; triggerProb: number; scatterRtp: number } {
  const w = engine.config.weights.base;
  const p = w[engine.S] / w.reduce((a, b) => a + b, 0);
  const n = engine.N;
  let triggerProb = 0;
  let scatterRtp = 0;
  // Coeficiente binomial en log para estabilidad.
  let logC = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log((n - k + 1) / k);
    const pk = Math.exp(logC + k * Math.log(p) + (n - k) * Math.log1p(-p));
    if (k >= engine.config.freeSpins.triggerCount) triggerProb += pk;
    scatterRtp += (pk * engine.scatterUnits[k]) / UNITS;
  }
  return { scatterProb: p, triggerProb, scatterRtp };
}

/**
 * Giro base aislado (sin pago de scatter ni FS) para estimar por Monte Carlo la parte de clusters del juego base.
 * Las cascadas del juego base no alcanzan el tope en la práctica, así que se usa el tope completo como presupuesto.
 */
export function verdantBaseClusterWin(rng: Rng): number {
  const e = verdantEngine;
  e.mult.fill(0);
  const r = e.spin(e.tBase, e.tBaseRefill, rng, e.capUnits, false);
  return (r.units - e.scatterUnits[r.scatters]) / UNITS;
}

/** Sesión de giros gratis aislada (como en bonus buy), en veces la apuesta base y con tope. */
export function verdantFreeSpinsWin(rng: Rng, award = VERDANT_CONFIG.freeSpins.award): number {
  const r = verdantEngine.freeSpinsSession(rng, award, 0, false);
  return Math.min(r.units, verdantEngine.capUnits) / UNITS;
}

/** Crea el GameMath sobre una configuración (la de producción o una variante para pruebas). */
export function createVerdantGrid(config: VerdantConfig = VERDANT_CONFIG): GameMath<VerdantConfig, VerdantOutcome> & { rtpProfiles: string[] } {
  const engine = config === VERDANT_CONFIG ? verdantEngine : new VerdantEngine(config);
  return {
    id: 'nymfo-verdant-grid',
    name: 'Verdant Grid',
    kind: 'slot',
    rtpTarget: config.rtpTarget,
    volatility: 'high',
    maxWinMultiplier: config.maxWinMultiplier,
    config,
    bonusBuy: { costMultiplier: config.bonusBuy.costMultiplier },
    rtpProfiles: ['96.5'],
    play(rng: Rng, opts?: PlayOptions): PlayResult<VerdantOutcome> {
      const r = engine.playRound(rng, !!opts?.bonusBuy, true);
      const outcome = r.outcome!;
      return {
        multiplier: outcome.totalWin,
        outcome,
        bonusTriggered: r.triggered,
        ...(r.triggered ? { freeSpins: r.fsAwarded } : {}),
      };
    },
  };
}

export const verdantGrid = createVerdantGrid(VERDANT_CONFIG);
