/**
 * Ember Lines 20 — slot clásica 5x3 de Nymfo Studios (tema: farolillos y brasas).
 *
 * Reglas (datos en config.json):
 *  - 20 líneas fijas, pagan de izquierda a derecha desde el rodillo 1 con 3+ símbolos (solo el mayor premio por línea).
 *  - Wild "Llama Viva" (rodillos 2–4) sustituye a todo salvo al scatter. En el juego base, si un wild participa en una
 *    línea ganadora, su rodillo entero se convierte en wild y la grilla se reevalúa (repitiendo hasta que no haya
 *    expansiones nuevas).
 *  - Scatter "Farolillo Celeste" en cualquier posición: paga sobre la apuesta total y con 3+ otorga 10 giros gratis.
 *    Las tiras garantizan que un wild y un scatter nunca son visibles en el mismo rodillo, así que una expansión
 *    nunca tapa un scatter.
 *  - Giros gratis "Brasas Eternas": todo wild que cae se expande al instante y su rodillo queda wild (pegajoso) hasta
 *    el final del bonus. 3+ scatters visibles (fuera de rodillos pegajosos) suman 10 giros más (tope configurable).
 *  - Ganancia máxima por ronda: maxWinMultiplier x apuesta total (el bonus termina al alcanzarla).
 *
 * Todo el cálculo interno es entero en unidades de 1e-4 de la apuesta total (sin errores de redondeo).
 */
import type { GameMath, PlayOptions, PlayResult } from '../../GameMath';
import type { Rng } from '../../fairness/Rng';

export interface EmberSymbol {
  id: number;
  key: string;
  name: string;
  kind: 'high' | 'low' | 'wild' | 'scatter';
}

export interface EmberConfig {
  reels: number;
  rows: number;
  symbols: EmberSymbol[];
  wild: number;
  scatter: number;
  /** Fila (0 = arriba) de cada rodillo para cada línea. */
  lines: number[][];
  /** Pagos por línea en veces la apuesta de línea (apuesta total / nº de líneas) para 3, 4 y 5 símbolos. */
  paytable: Array<{ symbol: number; pays: [number, number, number] }>;
  /** Pago del scatter en veces la apuesta total, índice = nº de scatters visibles. */
  scatterPays: number[];
  freeSpins: { triggerCount: number; award: number; retriggerAward: number; maxTotal: number };
  /** Tiras de rodillos (símbolos por posición); parada uniforme. La ventana visible son 3 posiciones consecutivas. */
  strips: { base: number[][]; freeSpins: number[][] };
  maxWinMultiplier: number;
  rtpTarget: number;
}

/** Posición [rodillo, fila] (fila 0 = arriba). */
export type EmberPos = [number, number];

export interface EmberLineWin {
  /** Índice de línea (0..19). */
  line: number;
  symbol: number;
  count: number;
  positions: EmberPos[];
  /** Premio en veces la apuesta total. */
  win: number;
}

export interface EmberSpin {
  /** Paradas de cada rodillo en su tira. */
  stops: number[];
  /** Grilla tal como cae, grid[rodillo][fila]. */
  grid: number[][];
  /** Rodillos convertidos en wild en este giro (base: por participar en un premio; FS: wilds recién caídos). */
  expandedReels: number[];
  /** Solo en giros gratis: rodillos wild pegajosos vigentes tras este giro (incluye los nuevos). */
  stickyReels?: number[];
  /** Grilla evaluada (con los rodillos wild aplicados). */
  finalGrid: number[][];
  lineWins: EmberLineWin[];
  scatterCount: number;
  scatterPositions: EmberPos[];
  scatterWin: number;
  /** Premio del giro (líneas + scatter) en veces la apuesta total. */
  win: number;
  freeSpinsAwarded: number;
}

export interface EmberOutcome {
  game: 'nymfo-ember-lines';
  base: EmberSpin;
  freeSpins: { totalAwarded: number; spins: EmberSpin[]; win: number } | null;
  /** Ganancia total (con tope aplicado) en veces la apuesta total. */
  totalWin: number;
  /** true si se alcanzó maxWinMultiplier (totalWin se recortó al tope). */
  capped: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const EMBER_CONFIG = require('./config.json') as EmberConfig;

/** Unidades internas por 1x de apuesta total. */
export const UNITS = 10_000;

/** Motor compilado (typed arrays + buffers reutilizables). No es reentrante entre hilos, pero JS es monohilo. */
export class EmberEngine {
  readonly R: number;
  readonly NR: number;
  readonly W: number;
  readonly S: number;
  readonly nLines: number;
  readonly lines: Int8Array;
  readonly payUnits: Int32Array;
  readonly scatterUnits: Int32Array;
  readonly baseStrips: Int8Array[];
  readonly fsStrips: Int8Array[];
  readonly capUnits: number;
  // Estado de trabajo del último giro.
  readonly grid: Int8Array;
  readonly stops: Int32Array;
  readonly winLine: Int8Array;
  readonly winSym: Int8Array;
  readonly winCount: Int8Array;
  readonly winUnits: Int32Array;
  nWins = 0;
  wildUsed = 0;

  constructor(readonly config: EmberConfig) {
    this.R = config.rows;
    this.NR = config.reels;
    this.W = config.wild;
    this.S = config.scatter;
    this.nLines = config.lines.length;
    this.lines = Int8Array.from(config.lines.flat());
    const nSym = config.symbols.length;
    this.payUnits = new Int32Array(nSym * (this.NR + 1));
    for (const { symbol, pays } of config.paytable) {
      pays.forEach((p, i) => {
        const u = (p * UNITS) / this.nLines;
        if (!Number.isInteger(u)) throw new Error(`Pago no representable en unidades: símbolo ${symbol}`);
        this.payUnits[symbol * (this.NR + 1) + 3 + i] = u;
      });
    }
    this.scatterUnits = new Int32Array(this.NR + 1);
    config.scatterPays.forEach((p, i) => (this.scatterUnits[i] = Math.round(p * UNITS)));
    this.baseStrips = config.strips.base.map((s) => Int8Array.from(s));
    this.fsStrips = config.strips.freeSpins.map((s) => Int8Array.from(s));
    this.capUnits = config.maxWinMultiplier * UNITS;
    this.grid = new Int8Array(this.NR * this.R);
    this.stops = new Int32Array(this.NR);
    this.winLine = new Int8Array(this.nLines);
    this.winSym = new Int8Array(this.nLines);
    this.winCount = new Int8Array(this.nLines);
    this.winUnits = new Int32Array(this.nLines);
  }

  /** Coloca los rodillos en las paradas dadas. */
  setStops(strips: Int8Array[], stops: ArrayLike<number>): void {
    const R = this.R;
    for (let r = 0; r < this.NR; r++) {
      const strip = strips[r];
      const len = strip.length;
      const s = stops[r];
      this.stops[r] = s;
      for (let row = 0; row < R; row++) this.grid[r * R + row] = strip[(s + row) % len];
    }
  }

  spinReels(strips: Int8Array[], rng: Rng): void {
    const R = this.R;
    for (let r = 0; r < this.NR; r++) {
      const strip = strips[r];
      const len = strip.length;
      const s = Math.floor(rng.nextFloat() * len);
      this.stops[r] = s;
      for (let row = 0; row < R; row++) this.grid[r * R + row] = strip[(s + row) % len];
    }
  }

  /**
   * Evalúa las 20 líneas sobre la grilla actual con los rodillos de `mask` (bits) convertidos en wild.
   * Devuelve las unidades ganadas y deja los premios en winLine/winSym/winCount/winUnits y en wildUsed
   * los rodillos cuyo wild participó en algún premio.
   */
  evalLines(mask: number): number {
    const { R, NR, W, S, lines, grid, payUnits } = this;
    let total = 0;
    let n = 0;
    let used = 0;
    for (let l = 0; l < this.nLines; l++) {
      const base = l * NR;
      let sym = -1;
      let count = 0;
      let wildBits = 0;
      for (let r = 0; r < NR; r++) {
        const c = (mask >> r) & 1 ? W : grid[r * R + lines[base + r]];
        if (c === S) break;
        if (c === W) {
          count++;
          wildBits |= 1 << r;
        } else if (sym < 0) {
          sym = c;
          count++;
        } else if (c === sym) count++;
        else break;
      }
      // El wild no paga por sí solo (no aparece en el rodillo 1, pero se cubre el caso general).
      if (sym < 0 || count < 3) continue;
      const u = payUnits[sym * (NR + 1) + count];
      if (u <= 0) continue;
      this.winLine[n] = l;
      this.winSym[n] = sym;
      this.winCount[n] = count;
      this.winUnits[n] = u;
      n++;
      total += u;
      used |= wildBits;
    }
    this.nWins = n;
    this.wildUsed = used;
    return total;
  }

  /** Scatters visibles fuera de los rodillos de `mask`. */
  countScatters(mask: number): number {
    let n = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === this.S && !((mask >> Math.floor(i / this.R)) & 1)) n++;
    return n;
  }

  /** Juego base sobre la grilla actual: expansiones iterativas. Devuelve { units, mask }. */
  resolveBase(): { units: number; mask: number } {
    let mask = 0;
    let units = this.evalLines(0);
    for (;;) {
      const add = this.wildUsed & ~mask;
      if (!add) break;
      mask |= add;
      units = this.evalLines(mask);
    }
    return { units, mask };
  }

  /** Bits de los rodillos con algún wild visible. */
  wildReels(): number {
    let m = 0;
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] === this.W) m |= 1 << Math.floor(i / this.R);
    return m;
  }

  private gridArrays(mask: number): { grid: number[][]; finalGrid: number[][] } {
    const grid: number[][] = [];
    const finalGrid: number[][] = [];
    for (let r = 0; r < this.NR; r++) {
      const col = Array.from(this.grid.subarray(r * this.R, (r + 1) * this.R));
      grid.push(col);
      finalGrid.push((mask >> r) & 1 ? col.map(() => this.W) : col);
    }
    return { grid, finalGrid };
  }

  private lineWinsSnapshot(): EmberLineWin[] {
    const out: EmberLineWin[] = [];
    for (let i = 0; i < this.nWins; i++) {
      const l = this.winLine[i];
      const count = this.winCount[i];
      const positions: EmberPos[] = [];
      for (let r = 0; r < count; r++) positions.push([r, this.lines[l * this.NR + r]]);
      out.push({ line: l, symbol: this.winSym[i], count, positions, win: this.winUnits[i] / UNITS });
    }
    return out;
  }

  private scatterPositions(mask: number): EmberPos[] {
    const out: EmberPos[] = [];
    for (let r = 0; r < this.NR; r++) {
      if ((mask >> r) & 1) continue;
      for (let row = 0; row < this.R; row++) if (this.grid[r * this.R + row] === this.S) out.push([r, row]);
    }
    return out;
  }

  private bitsToList(mask: number): number[] {
    const out: number[] = [];
    for (let r = 0; r < this.NR; r++) if ((mask >> r) & 1) out.push(r);
    return out;
  }

  /** Un giro base completo (con registro para el outcome si record = true). */
  baseSpin(rng: Rng, record: boolean): { units: number; scatters: number; spin: EmberSpin | null } {
    this.spinReels(this.baseStrips, rng);
    return this.resolveCurrentBase(record);
  }

  /** Evalúa como giro base una grilla dada (grid[rodillo][fila]); útil para pruebas y para reproducir rondas. */
  evaluateBaseGrid(grid: number[][]): EmberSpin {
    for (let r = 0; r < this.NR; r++) {
      this.stops[r] = -1;
      for (let row = 0; row < this.R; row++) this.grid[r * this.R + row] = grid[r][row];
    }
    return this.resolveCurrentBase(true).spin!;
  }

  private resolveCurrentBase(record: boolean): { units: number; scatters: number; spin: EmberSpin | null } {
    const { units: lineUnits, mask } = this.resolveBase();
    const scatters = this.countScatters(0);
    const scatterUnits = this.scatterUnits[Math.min(scatters, this.NR)];
    const units = lineUnits + scatterUnits;
    const fs = this.config.freeSpins;
    const awarded = scatters >= fs.triggerCount ? fs.award : 0;
    let spin: EmberSpin | null = null;
    if (record) {
      const { grid, finalGrid } = this.gridArrays(mask);
      spin = {
        stops: Array.from(this.stops),
        grid,
        expandedReels: this.bitsToList(mask),
        finalGrid,
        lineWins: this.lineWinsSnapshot(),
        scatterCount: scatters,
        scatterPositions: this.scatterPositions(0),
        scatterWin: scatterUnits / UNITS,
        win: units / UNITS,
        freeSpinsAwarded: awarded,
      };
    }
    return { units, scatters, spin };
  }

  /**
   * Sesión de giros gratis con wilds pegajosos. `alreadyWon` (unidades) sirve para aplicar el tope de la ronda.
   * Devuelve las unidades ganadas en el bonus (sin recortar) y, si record, los giros.
   */
  freeSpinsSession(
    rng: Rng,
    alreadyWon: number,
    record: boolean,
  ): { units: number; totalAwarded: number; spins: EmberSpin[] } {
    const fs = this.config.freeSpins;
    let remaining = fs.award;
    let totalAwarded = fs.award;
    let sticky = 0;
    let units = 0;
    const spins: EmberSpin[] = [];
    while (remaining > 0) {
      remaining--;
      this.spinReels(this.fsStrips, rng);
      const landed = this.wildReels() & ~sticky;
      sticky |= landed;
      const lineUnits = this.evalLines(sticky);
      const scatters = this.countScatters(sticky);
      const scatterUnits = this.scatterUnits[Math.min(scatters, this.NR)];
      let awarded = 0;
      if (scatters >= fs.triggerCount) {
        awarded = Math.min(fs.retriggerAward, fs.maxTotal - totalAwarded);
        totalAwarded += awarded;
        remaining += awarded;
      }
      const spinUnits = lineUnits + scatterUnits;
      units += spinUnits;
      if (record) {
        const { grid, finalGrid } = this.gridArrays(sticky);
        spins.push({
          stops: Array.from(this.stops),
          grid,
          expandedReels: this.bitsToList(landed),
          stickyReels: this.bitsToList(sticky),
          finalGrid,
          lineWins: this.lineWinsSnapshot(),
          scatterCount: scatters,
          scatterPositions: this.scatterPositions(sticky),
          scatterWin: scatterUnits / UNITS,
          win: spinUnits / UNITS,
          freeSpinsAwarded: awarded,
        });
      }
      if (alreadyWon + units >= this.capUnits) break;
    }
    return { units, totalAwarded, spins };
  }
}

export const emberEngine = new EmberEngine(EMBER_CONFIG);

export interface EmberExactBase {
  combinations: number;
  /** RTP de líneas del juego base (con expansiones), exacto. */
  lineRtp: number;
  /** RTP de los pagos de scatter del juego base, exacto. */
  scatterRtp: number;
  /** Probabilidad exacta de activar los giros gratis por giro. */
  triggerProb: number;
  /** Probabilidad de que el giro base pague algo (líneas o scatter). */
  hitRate: number;
  /** E[premio base^2] (para la varianza del juego base). */
  secondMoment: number;
}

/**
 * Enumera todas las combinaciones de paradas de las tiras base (∏ longitudes) y devuelve las métricas exactas del
 * juego base. Sirve para calibrar y para que la prueba de RTP solo tenga que estimar por Monte Carlo la parte de FS.
 */
export function computeEmberExactBase(engine: EmberEngine = emberEngine): EmberExactBase {
  const strips = engine.baseStrips;
  const lens = strips.map((s) => s.length);
  const stops = new Int32Array(engine.NR);
  const trig = engine.config.freeSpins.triggerCount;
  let lineSum = 0;
  let scatterSum = 0;
  let sq = 0;
  let hits = 0;
  let triggers = 0;
  let total = 0;
  const rec = (r: number): void => {
    if (r === engine.NR) {
      engine.setStops(strips, stops);
      const { units } = engine.resolveBase();
      const sc = engine.countScatters(0);
      const su = engine.scatterUnits[Math.min(sc, engine.NR)];
      const u = units + su;
      lineSum += units;
      scatterSum += su;
      sq += u * u;
      if (u > 0) hits++;
      if (sc >= trig) triggers++;
      total++;
      return;
    }
    for (let s = 0; s < lens[r]; s++) {
      stops[r] = s;
      rec(r + 1);
    }
  };
  rec(0);
  return {
    combinations: total,
    lineRtp: lineSum / total / UNITS,
    scatterRtp: scatterSum / total / UNITS,
    triggerProb: triggers / total,
    hitRate: hits / total,
    secondMoment: sq / total / (UNITS * UNITS),
  };
}

export interface EmberAnalyticBase {
  /** RTP exacto de líneas del juego base (con expansiones). */
  lineRtp: number;
  /** E[pago de scatter] en veces la apuesta total (exacto, convolución por rodillo). */
  scatterRtp: number;
  /** lineRtp + scatterRtp. */
  baseRtp: number;
  /** Probabilidad exacta de 3+ scatters (activación de FS). */
  triggerProb: number;
}

/**
 * RTP exacto del juego base sin enumerar las ∏Lᵢ combinaciones completas (~1 s en vez de ~40 s):
 *  - El wild solo existe en los rodillos 2–4, así que qué rodillos se expanden depende solo de los rodillos 1–4
 *    (un wild del rodillo r ≤ 4 participa si el prefijo de su línea casa hasta r y alcanza 3 símbolos, lo que no
 *    depende del rodillo 5). Se enumeran las paradas de los rodillos 1–4.
 *  - El rodillo 5 solo decide si una línea con 4 coincidencias paga 4 o 5; toda celda del rodillo 5 tiene la misma
 *    distribución marginal (parada uniforme), así que E[pago] = p4 + P(símbolo en rodillo 5)·(p5 − p4).
 *  - Scatters: convolución exacta del nº de scatters visibles por rodillo (independientes entre sí).
 */
export function computeEmberAnalyticBase(engine: EmberEngine = emberEngine): EmberAnalyticBase {
  const { NR, R, W, S, lines, grid, payUnits } = engine;
  const strips = engine.baseStrips;
  if (strips[0].includes(W) || strips[NR - 1].includes(W)) throw new Error('El cálculo exacto supone wilds solo en rodillos 2–4');
  const nSym = engine.config.symbols.length;
  const last = strips[NR - 1];
  const freqLast = new Float64Array(nSym);
  for (let i = 0; i < last.length; i++) freqLast[last[i]] += 1 / last.length;
  const stops = new Int32Array(NR);
  let lineEv = 0;
  let combos = 0;
  const rec = (r: number): void => {
    if (r === NR - 1) {
      stops[r] = 0;
      engine.setStops(strips, stops);
      const { mask } = engine.resolveBase();
      let ev = 0;
      for (let l = 0; l < engine.nLines; l++) {
        const base = l * NR;
        let sym = -1;
        let count = 0;
        for (let k = 0; k < NR - 1; k++) {
          const c = (mask >> k) & 1 ? W : grid[k * R + lines[base + k]];
          if (c === S) break;
          if (c === W) count++;
          else if (sym < 0) {
            sym = c;
            count++;
          } else if (c === sym) count++;
          else break;
        }
        if (sym < 0 || count < 3) continue;
        const off = sym * (NR + 1);
        if (count < NR - 1) ev += payUnits[off + count];
        else ev += payUnits[off + count] + freqLast[sym] * (payUnits[off + NR] - payUnits[off + count]);
      }
      lineEv += ev;
      combos++;
      return;
    }
    for (let s = 0; s < strips[r].length; s++) {
      stops[r] = s;
      rec(r + 1);
    }
  };
  rec(0);
  // Distribución exacta del nº de scatters: convolución de la distribución por rodillo (contando ventanas).
  let dist = new Float64Array(NR * R + 1);
  dist[0] = 1;
  for (const strip of engine.baseStrips) {
    const per = new Float64Array(R + 1);
    for (let st = 0; st < strip.length; st++) {
      let c = 0;
      for (let row = 0; row < R; row++) if (strip[(st + row) % strip.length] === S) c++;
      per[c] += 1 / strip.length;
    }
    const next = new Float64Array(dist.length);
    for (let a = 0; a < dist.length; a++) for (let c = 0; c <= R && a + c < dist.length; c++) next[a + c] += dist[a] * per[c];
    dist = next;
  }
  let scatterEv = 0;
  let trig = 0;
  for (let n = 0; n < dist.length; n++) {
    scatterEv += dist[n] * engine.scatterUnits[Math.min(n, NR)];
    if (n >= engine.config.freeSpins.triggerCount) trig += dist[n];
  }
  const lineRtp = lineEv / combos / UNITS;
  const scatterRtp = scatterEv / UNITS;
  return { lineRtp, scatterRtp, baseRtp: lineRtp + scatterRtp, triggerProb: trig };
}

/** Un giro base sin registro (para medir hit rate y varianza por Monte Carlo). */
export function emberBaseSample(rng: Rng): { win: number; scatters: number } {
  const e = emberEngine;
  e.spinReels(e.baseStrips, rng);
  const { units } = e.resolveBase();
  const scatters = e.countScatters(0);
  return { win: (units + e.scatterUnits[Math.min(scatters, e.NR)]) / UNITS, scatters };
}

/** Gana una sesión de giros gratis aislada (veces la apuesta, sin tope de base previo). Para estimar E[FS]. */
export function emberFreeSpinsWin(rng: Rng): number {
  const r = emberEngine.freeSpinsSession(rng, 0, false);
  return Math.min(r.units, emberEngine.capUnits) / UNITS;
}

/** Crea el GameMath sobre una configuración (la de producción o una variante para pruebas). */
export function createEmberLines(config: EmberConfig = EMBER_CONFIG): GameMath<EmberConfig, EmberOutcome> & { rtpProfiles: string[] } {
  const e = config === EMBER_CONFIG ? emberEngine : new EmberEngine(config);
  return {
    id: 'nymfo-ember-lines',
    name: 'Ember Lines 20',
    kind: 'slot',
    rtpTarget: config.rtpTarget,
    volatility: 'medium',
    maxWinMultiplier: config.maxWinMultiplier,
    config,
    rtpProfiles: ['96.5'],
    play(rng: Rng, _opts?: PlayOptions): PlayResult<EmberOutcome> {
      const base = e.baseSpin(rng, true);
      const triggered = base.scatters >= config.freeSpins.triggerCount;
      let units = base.units;
      let freeSpins: EmberOutcome['freeSpins'] = null;
      if (triggered && units < e.capUnits) {
        const fs = e.freeSpinsSession(rng, units, true);
        units += fs.units;
        freeSpins = { totalAwarded: fs.totalAwarded, spins: fs.spins, win: fs.units / UNITS };
      }
      const capped = units >= e.capUnits;
      const totalWin = Math.min(units, e.capUnits) / UNITS;
      return {
        multiplier: totalWin,
        outcome: { game: 'nymfo-ember-lines', base: base.spin!, freeSpins, totalWin, capped },
        bonusTriggered: triggered,
        ...(freeSpins ? { freeSpins: freeSpins.totalAwarded } : {}),
      };
    },
  };
}

export const emberLines = createEmberLines(EMBER_CONFIG);
