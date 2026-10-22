import type { PlayOptions, PlayResult } from '../GameMath';
import type { Rng } from '../fairness/Rng';
import { GameActionError, GameParamError, InteractiveGame, OriginalGameMath, resolveOriginalRtp } from './types';

/**
 * Abyss Crash. Punto de crash provably fair derivado del HMAC de la ronda:
 *   f = primer float del Rng,  v = RTP / (1 − f),  punto = floor(100·v)/100  (1.00 = crash instantáneo, tope 1 000 000x).
 * Así P(punto ≥ c) = RTP / c para todo c ≥ 1.01 y cualquier retiro en c devuelve exactamente RTP (edge = 1 − RTP).
 * Se gana si el retiro c ≤ punto. El retiro mínimo es 1.01x y el máximo 10 000x.
 * Curva en vivo: m(t) = floor(100·e^(0.00006·t_ms))/100 (la misma del motor original).
 */
export interface CrashConfig {
  minCashout: number;
  maxCashout: number;
  maxCrashPoint: number;
  growthPerMs: number;
}

export interface CrashOutcome {
  crashPoint: number;
  cashout: number | null;
  win: boolean;
}

export interface CrashState {
  crashPoint: number;
  startedAt: number;
  autoCashout: number | null;
  status: 'running' | 'cashed_out' | 'crashed';
  cashout: number | null;
}

const CONFIG: CrashConfig = { minCashout: 1.01, maxCashout: 10000, maxCrashPoint: 1_000_000, growthPerMs: 0.00006 };

export function crashPointFromRng(rng: Rng, rtp: number): number {
  const f = rng.nextFloat();
  const v = rtp / (1 - f);
  const point = Math.floor(v * 100 + 1e-9) / 100;
  return Math.min(CONFIG.maxCrashPoint, Math.max(1, point));
}

/** Multiplicador de la curva tras `elapsedMs`. */
export function crashMultiplierAt(elapsedMs: number): number {
  return Math.max(1, Math.floor(100 * Math.exp(CONFIG.growthPerMs * Math.max(0, elapsedMs)) + 1e-9) / 100);
}

/** Milisegundos hasta que la curva alcanza m. */
export const crashTimeTo = (m: number): number => Math.ceil(Math.log(m) / CONFIG.growthPerMs);

export function parseCashout(value: unknown, field = 'autoCashout'): number {
  const c = Number(value);
  if (!Number.isFinite(c) || Math.abs(c * 100 - Math.round(c * 100)) > 1e-6) {
    throw new GameParamError(`${field} debe tener hasta 2 decimales`);
  }
  if (c < CONFIG.minCashout || c > CONFIG.maxCashout) throw new GameParamError(`${field} debe estar entre 1.01 y 10000`);
  return Math.round(c * 100) / 100;
}

export const nymfoCrash: OriginalGameMath<CrashConfig, CrashOutcome> = {
  id: 'nymfo-crash',
  name: 'Abyss Crash',
  kind: 'original',
  rtpTarget: 0.99,
  rtpRange: { min: 0.96, max: 0.99 },
  volatility: 'very_high',
  maxWinMultiplier: CONFIG.maxCashout,
  config: CONFIG,
  validateParams(params) {
    parseCashout(params?.autoCashout ?? 2);
  },
  play(rng: Rng, opts?: PlayOptions): PlayResult<CrashOutcome> {
    const cashout = parseCashout(opts?.params?.autoCashout ?? 2);
    const rtp = resolveOriginalRtp(opts?.rtpProfile, this.rtpTarget, this.rtpRange);
    const crashPoint = crashPointFromRng(rng, rtp);
    const win = cashout <= crashPoint;
    return { multiplier: win ? cashout : 0, outcome: { crashPoint, cashout, win }, bonusTriggered: false };
  },
};

function crashView(s: CrashState, now: number): Record<string, unknown> {
  const done = s.status !== 'running';
  return {
    status: s.status,
    startedAt: s.startedAt,
    autoCashout: s.autoCashout,
    cashout: s.cashout,
    current: done ? (s.status === 'crashed' ? s.crashPoint : s.cashout) : crashMultiplierAt(now - s.startedAt),
    ...(done ? { crashPoint: s.crashPoint } : {}),
  };
}

function finish(s: CrashState, cashout: number | null): { state: CrashState; multiplier: number } {
  const win = cashout !== null && cashout <= s.crashPoint;
  const state: CrashState = { ...s, status: win ? 'cashed_out' : 'crashed', cashout: win ? cashout : null };
  return { state, multiplier: win ? (cashout as number) : 0 };
}

/** Resuelve la ronda según el reloj: auto-retiro alcanzado o crash ya ocurrido. Devuelve null si sigue en curso. */
function resolveByClock(s: CrashState, now: number): { state: CrashState; multiplier: number } | null {
  const m = crashMultiplierAt(now - s.startedAt);
  if (s.autoCashout !== null && s.autoCashout <= s.crashPoint && m >= s.autoCashout) return finish(s, s.autoCashout);
  if (m >= s.crashPoint) return finish(s, null);
  return null;
}

/** Crash en vivo de un jugador (start → cashout) con la curva medida por el reloj del servidor. */
export const nymfoCrashLive: InteractiveGame<CrashState> = {
  id: 'nymfo-crash',
  name: 'Abyss Crash',
  rtpTarget: nymfoCrash.rtpTarget,
  rtpRange: nymfoCrash.rtpRange,
  volatility: 'very_high',
  maxWinMultiplier: CONFIG.maxCashout,
  config: { ...CONFIG },
  validateParams(params) {
    if (params?.autoCashout !== undefined && params.autoCashout !== null) parseCashout(params.autoCashout);
  },
  start(rng, params, ctx) {
    const autoCashout = params?.autoCashout === undefined || params.autoCashout === null ? null : parseCashout(params.autoCashout);
    const state: CrashState = { crashPoint: crashPointFromRng(rng, ctx.rtp), startedAt: ctx.now, autoCashout, status: 'running', cashout: null };
    if (state.crashPoint < CONFIG.minCashout) {
      const r = finish(state, null);
      return { state: r.state, view: crashView(r.state, ctx.now), done: true, multiplier: 0 };
    }
    return { state, view: crashView(state, ctx.now), done: false, multiplier: 0 };
  },
  action(state, action, ctx) {
    if (state.status !== 'running') throw new GameActionError('La ronda ya terminó');
    const byClock = resolveByClock(state, ctx.now);
    if (byClock) return { state: byClock.state, view: crashView(byClock.state, ctx.now), done: true, multiplier: byClock.multiplier };
    if (action.type === 'check') return { state, view: crashView(state, ctx.now), done: false, multiplier: 0 };
    if (action.type !== 'cashout') throw new GameActionError(`Acción no soportada: ${action.type}`);
    const m = crashMultiplierAt(ctx.now - state.startedAt);
    if (m < CONFIG.minCashout) throw new GameActionError('Aún no se puede retirar (mínimo 1.01x)');
    const r = finish(state, m);
    return { state: r.state, view: crashView(r.state, ctx.now), done: true, multiplier: r.multiplier };
  },
  settle(state, ctx) {
    if (state.status !== 'running') {
      return { state, view: crashView(state, ctx.now), done: true, multiplier: state.status === 'cashed_out' ? (state.cashout as number) : 0 };
    }
    const byClock = resolveByClock(state, ctx.now);
    const m = crashMultiplierAt(ctx.now - state.startedAt);
    const r = byClock ?? finish(state, m >= CONFIG.minCashout ? m : null);
    return { state: r.state, view: crashView(r.state, ctx.now), done: true, multiplier: r.multiplier };
  },
  verify(rng, _params, ctx) {
    return { crashPoint: crashPointFromRng(rng, ctx.rtp) };
  },
};
