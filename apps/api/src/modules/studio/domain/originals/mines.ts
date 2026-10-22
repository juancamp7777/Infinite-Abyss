import type { PlayOptions, PlayResult } from '../GameMath';
import type { Rng } from '../fairness/Rng';
import { floor4, GameActionError, GameParamError, InteractiveGame, OriginalGameMath, resolveOriginalRtp } from './types';

/**
 * Nymfo Mines: grilla 5x5 (celdas 0–24) con 1–24 minas colocadas por Fisher-Yates con el Rng provably fair
 * (las primeras `mines` posiciones de la permutación). Tras r diamantes descubiertos:
 *   P(supervivencia) = Π_{i<r} (25 − minas − i) / (25 − i),   multiplicador = floor4(RTP / P).
 * Retirar con 0 descubiertos no está permitido; el cierre forzado sin descubrir devuelve la apuesta (1x).
 */
export interface MinesConfig {
  cells: number;
  minMines: number;
  maxMines: number;
}

export interface MinesOutcome {
  mines: number;
  minePositions: number[];
  picks: number[];
  hitMine: boolean;
  payout: number;
}

export interface MinesState {
  mines: number;
  minePositions: number[];
  revealed: number[];
  status: 'playing' | 'busted' | 'cashed_out';
  rtp: number;
}

const CONFIG: MinesConfig = { cells: 25, minMines: 1, maxMines: 24 };

export function minesSurvival(mines: number, revealed: number): number {
  let p = 1;
  for (let i = 0; i < revealed; i++) p *= (CONFIG.cells - mines - i) / (CONFIG.cells - i);
  return p;
}

export function minesMultiplier(mines: number, revealed: number, rtp: number): number {
  if (revealed <= 0) return 0;
  if (revealed > CONFIG.cells - mines) throw new GameParamError('Más descubiertos que diamantes');
  return floor4(rtp / minesSurvival(mines, revealed));
}

/** Posiciones de las minas (orden de la permutación provably fair). */
export function minePositionsFromRng(rng: Rng, mines: number): number[] {
  const cells = Array.from({ length: CONFIG.cells }, (_, i) => i);
  for (let i = 0; i < mines; i++) {
    const j = i + rng.nextInt(CONFIG.cells - i);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, mines);
}

function parseMines(params: Record<string, unknown> | undefined): number {
  const mines = params?.mines === undefined ? 3 : Number(params.mines);
  if (!Number.isInteger(mines) || mines < CONFIG.minMines || mines > CONFIG.maxMines) {
    throw new GameParamError('mines debe ser un entero entre 1 y 24');
  }
  return mines;
}

function parseCell(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= CONFIG.cells) throw new GameParamError('Celda inválida (0–24)');
  return v as number;
}

/** picks: lista de celdas distintas o un número n (se toman las celdas 0..n−1, equivalente por simetría). */
function parsePicks(params: Record<string, unknown> | undefined, mines: number): number[] {
  const raw = params?.picks ?? 1;
  let picks: number[];
  if (Array.isArray(raw)) picks = raw.map(parseCell);
  else if (Number.isInteger(raw)) picks = Array.from({ length: raw as number }, (_, i) => i);
  else throw new GameParamError('picks debe ser una lista de celdas o un entero');
  if (picks.length < 1 || picks.length > CONFIG.cells - mines) throw new GameParamError('Cantidad de picks inválida');
  if (new Set(picks).size !== picks.length) throw new GameParamError('picks repetidos');
  return picks;
}

let maxWin = 0;
for (let m = 1; m <= 24; m++) for (let r = 1; r <= 25 - m; r++) maxWin = Math.max(maxWin, 1 / minesSurvival(m, r));

export const nymfoMines: OriginalGameMath<MinesConfig, MinesOutcome> = {
  id: 'nymfo-mines',
  name: 'Nymfo Mines',
  kind: 'original',
  rtpTarget: 0.99,
  rtpRange: { min: 0.96, max: 0.99 },
  volatility: 'high',
  maxWinMultiplier: Math.floor(maxWin),
  config: CONFIG,
  validateParams(params) {
    parsePicks(params, parseMines(params));
  },
  play(rng: Rng, opts?: PlayOptions): PlayResult<MinesOutcome> {
    const mines = parseMines(opts?.params);
    const picks = parsePicks(opts?.params, mines);
    const rtp = resolveOriginalRtp(opts?.rtpProfile, this.rtpTarget, this.rtpRange);
    const minePositions = minePositionsFromRng(rng, mines);
    const hitMine = picks.some((c) => minePositions.includes(c));
    const payout = minesMultiplier(mines, picks.length, rtp);
    return { multiplier: hitMine ? 0 : payout, outcome: { mines, minePositions, picks, hitMine, payout }, bonusTriggered: false };
  },
};

function minesView(s: MinesState): Record<string, unknown> {
  const done = s.status !== 'playing';
  const r = s.revealed.length;
  return {
    mines: s.mines,
    revealed: s.revealed,
    status: s.status,
    currentMultiplier: s.status === 'busted' ? 0 : minesMultiplier(s.mines, r, s.rtp),
    nextMultiplier: r < CONFIG.cells - s.mines ? minesMultiplier(s.mines, r + 1, s.rtp) : null,
    ...(done ? { minePositions: s.minePositions } : {}),
  };
}

export const nymfoMinesInteractive: InteractiveGame<MinesState> = {
  id: 'nymfo-mines',
  name: 'Nymfo Mines',
  rtpTarget: nymfoMines.rtpTarget,
  rtpRange: nymfoMines.rtpRange,
  volatility: 'high',
  maxWinMultiplier: nymfoMines.maxWinMultiplier,
  config: { ...CONFIG },
  validateParams(params) {
    parseMines(params);
  },
  start(rng, params, ctx) {
    const mines = parseMines(params);
    const state: MinesState = { mines, minePositions: minePositionsFromRng(rng, mines), revealed: [], status: 'playing', rtp: ctx.rtp };
    return { state, view: minesView(state), done: false, multiplier: 0 };
  },
  action(state, action) {
    if (state.status !== 'playing') throw new GameActionError('La ronda ya terminó');
    if (action.type === 'reveal') {
      const cell = parseCell(action.cell);
      if (state.revealed.includes(cell)) throw new GameActionError('Celda ya descubierta');
      if (state.minePositions.includes(cell)) {
        const s: MinesState = { ...state, revealed: [...state.revealed, cell], status: 'busted' };
        return { state: s, view: minesView(s), done: true, multiplier: 0 };
      }
      const revealed = [...state.revealed, cell];
      if (revealed.length === CONFIG.cells - state.mines) {
        const s: MinesState = { ...state, revealed, status: 'cashed_out' };
        return { state: s, view: minesView(s), done: true, multiplier: minesMultiplier(s.mines, revealed.length, s.rtp) };
      }
      const s: MinesState = { ...state, revealed };
      return { state: s, view: minesView(s), done: false, multiplier: 0 };
    }
    if (action.type === 'cashout') {
      if (state.revealed.length === 0) throw new GameActionError('Descubre al menos una celda antes de retirar');
      const s: MinesState = { ...state, status: 'cashed_out' };
      return { state: s, view: minesView(s), done: true, multiplier: minesMultiplier(s.mines, s.revealed.length, s.rtp) };
    }
    throw new GameActionError(`Acción no soportada: ${action.type}`);
  },
  settle(state) {
    if (state.status === 'busted') return { state, view: minesView(state), done: true, multiplier: 0 };
    const s: MinesState = { ...state, status: 'cashed_out' };
    const r = s.revealed.length;
    return { state: s, view: minesView(s), done: true, multiplier: r === 0 ? 1 : minesMultiplier(s.mines, r, s.rtp) };
  },
  verify(rng, params) {
    const mines = parseMines(params);
    return { mines, minePositions: minePositionsFromRng(rng, mines) };
  },
};
