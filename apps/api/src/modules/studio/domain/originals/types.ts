import type { GameMath, Volatility } from '../GameMath';
import type { Rng } from '../fairness/Rng';

/** Error de parámetros del jugador (se traduce a HTTP 400). */
export class GameParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameParamError';
  }
}

/** Error de acción inválida sobre una ronda interactiva (se traduce a HTTP 409). */
export class GameActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameActionError';
  }
}

/** GameMath de un original: añade validación previa de parámetros (antes de cobrar la apuesta). */
export interface OriginalGameMath<Config = unknown, Outcome = unknown> extends GameMath<Config, Outcome> {
  /** Lanza GameParamError si los parámetros no son válidos. */
  validateParams(params: Record<string, unknown> | undefined): void;
  /** Si los parámetros fijan la apuesta total (p. ej. fichas de ruleta), la devuelve para cotejarla con amount. */
  expectedStake?(params: Record<string, unknown> | undefined): bigint | null;
}

export interface InteractiveContext {
  /** RTP efectivo (fracción) según la configuración del operador. */
  rtp: number;
  /** Reloj del servidor en ms (crash en vivo). */
  now: number;
}

export interface InteractiveStep<State> {
  state: State;
  /** Vista pública para el jugador (sin información oculta mientras la ronda no termine). */
  view: Record<string, unknown>;
  done: boolean;
  /** Retorno total en veces la apuesta base (solo cuando done). */
  multiplier: number;
  /** Apuesta adicional solicitada en veces la apuesta base (doblar/dividir en blackjack). */
  additionalBet?: number;
}

export interface InteractiveAction {
  type: string;
  [key: string]: unknown;
}

/**
 * Juego interactivo de varias acciones con estado serializable (JSON puro, sin clases).
 * start → action* → (done | settle forzado). Toda la aleatoriedad se fija en start con el Rng provably fair.
 */
export interface InteractiveGame<State = any> {
  id: string;
  name: string;
  rtpTarget: number;
  /** Ausente = RTP fijo por reglas. */
  rtpRange?: { min: number; max: number };
  volatility: Volatility;
  maxWinMultiplier: number;
  /** Reglas/datos documentados del juego. */
  config: Record<string, unknown>;
  validateParams(params: Record<string, unknown> | undefined): void;
  start(rng: Rng, params: Record<string, unknown> | undefined, ctx: InteractiveContext): InteractiveStep<State>;
  /** Lanza GameActionError si la acción no es válida en el estado actual. */
  action(state: State, action: InteractiveAction, ctx: InteractiveContext): InteractiveStep<State>;
  /** Cierra la ronda de forma forzada (abandono/timeout) con la jugada más favorable al jugador posible sin riesgo. */
  settle(state: State, ctx: InteractiveContext): InteractiveStep<State>;
  /** Recalcula lo que fija el RNG (minas, mazo, punto de crash) para la verificación pública. */
  verify(rng: Rng, params: Record<string, unknown> | undefined, ctx: { rtp: number }): Record<string, unknown>;
}

/** Interpreta opts.rtpProfile (porcentaje como string, p. ej. '98.5') dentro del rango; si no, el RTP por defecto. */
export function resolveOriginalRtp(
  profile: string | undefined,
  def: number,
  range?: { min: number; max: number },
): number {
  if (profile === undefined || profile === '') return def;
  const pct = Number(profile);
  if (!Number.isFinite(pct)) throw new GameParamError(`Perfil de RTP inválido: ${profile}`);
  const rtp = Math.round(pct * 100) / 10000;
  const min = range?.min ?? def;
  const max = range?.max ?? def;
  if (rtp < min - 1e-9 || rtp > max + 1e-9) throw new GameParamError(`RTP ${pct}% fuera de rango`);
  return rtp;
}

/** Convierte un RTP en fracción al perfil string que consumen los originals ('98.50'). */
export const rtpToProfile = (rtp: number): string => (Math.round(rtp * 10000) / 100).toFixed(2);

/** Floor a 4 decimales (precisión de applyMultiplier). */
export const floor4 = (x: number): number => Math.floor(x * 10000 + 1e-7) / 10000;

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
