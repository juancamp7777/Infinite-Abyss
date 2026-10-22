/**
 * Tipos de los outcomes que devuelve el servidor (apps/api/src/modules/studio/domain/games/<juego>/math.ts).
 * El frontend solo los anima: nunca calcula premios.
 */

// ── Starfall (6x5, pay anywhere, tumble) ──
/** Celda: id de símbolo ('astra'…'meteor', 'portal' = scatter) u orbe 'x<n>' (solo free spins). */
export type StarfallCell = string;
export interface StarfallStep {
  wins: { symbol: string; count: number; pay: number }[];
  /** [col,row] eliminados (row 0 = arriba) sobre la grilla previa al paso. */
  removed: Array<[number, number]>;
  /** Por columna, símbolos nuevos que entran por arriba (de arriba hacia abajo). */
  newSymbols: StarfallCell[][];
  stepWin: number;
}
export interface StarfallSpin {
  /** grid[col][row] */
  grid: StarfallCell[][];
  steps: StarfallStep[];
  finalGrid: StarfallCell[][];
  multipliers: { col: number; row: number; value: number }[];
  multiplierSum: number;
  tumbleWin: number;
  scatterCount: number;
  scatterPay: number;
  freeSpinsAwarded: number;
  totalWin: number;
}
export interface StarfallOutcome {
  gameId: 'nymfo-starfall';
  bonusBuy: boolean;
  base: StarfallSpin;
  freeSpins: null | { awarded: number; played: number; spins: StarfallSpin[]; totalWin: number };
  totalWin: number;
  capped: boolean;
}

// ── Verdant Grid (7x7 cluster, índice = fila*7+col) ──
export interface VerdantCluster {
  symbol: number;
  positions: number[];
  size: number;
  basePay: number;
  multiplier: number;
  win: number;
}
export interface VerdantStep {
  /** Grilla antes de evaluar el paso. */
  grid: number[];
  /** 0 = sin marca, 1 = marcada, ≥2 = multiplicador de posición. */
  multipliers: number[];
  clusters: VerdantCluster[];
  win: number;
  multipliersAfter: number[];
}
export interface VerdantSpin {
  steps: VerdantStep[];
  finalGrid: number[];
  scatterCount: number;
  scatterPositions: number[];
  scatterWin: number;
  win: number;
  freeSpinsAwarded: number;
}
export interface VerdantOutcome {
  game: 'nymfo-verdant-grid';
  bonusBuy: boolean;
  /** null si fue bonus buy. */
  base: VerdantSpin | null;
  freeSpins: null | { totalAwarded: number; spins: VerdantSpin[]; win: number };
  totalWin: number;
  capped: boolean;
}

// ── Ember Lines (5x3, 20 líneas) ──
export type EmberPos = [number, number];
export interface EmberSpin {
  stops: number[];
  /** grid[rodillo][fila]; 8 = wild, 9 = scatter */
  grid: number[][];
  expandedReels: number[];
  stickyReels?: number[];
  finalGrid: number[][];
  lineWins: { line: number; symbol: number; count: number; positions: EmberPos[]; win: number }[];
  scatterCount: number;
  scatterPositions: EmberPos[];
  scatterWin: number;
  win: number;
  freeSpinsAwarded: number;
}
export interface EmberOutcome {
  game: 'nymfo-ember-lines';
  base: EmberSpin;
  freeSpins: null | { totalAwarded: number; spins: EmberSpin[]; win: number };
  totalWin: number;
  capped: boolean;
}
