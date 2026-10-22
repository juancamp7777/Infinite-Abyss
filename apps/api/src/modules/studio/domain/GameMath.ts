import type { Rng } from './fairness/Rng';

export type Volatility = 'low' | 'medium' | 'high' | 'very_high';

export interface PlayOptions {
  /** Ronda comprada (bonus buy): la apuesta efectiva es bet * bonusBuy.costMultiplier. */
  bonusBuy?: boolean;
  /** Parámetros del jugador (p. ej. mines: { mines: 3, picks: [..] }, dice: { target, over }). */
  params?: Record<string, unknown>;
  /** Perfil de RTP elegido por el operador dentro de rtpRange (p. ej. '96.5', '94'). */
  rtpProfile?: string;
}

export interface PlayResult<Outcome> {
  /** Ganancia total en veces la apuesta base (0 = pierde). Con bonusBuy se expresa sobre la apuesta base, no sobre el coste. */
  multiplier: number;
  /** Detalle serializable (JSON) para que el frontend anime la ronda y para auditoría. */
  outcome: Outcome;
  bonusTriggered: boolean;
  freeSpins?: number;
}

/**
 * Matemática de un juego como datos + función pura. Server-authoritative: el servidor llama a play()
 * con un Rng provably fair; el simulador lo llama con SeededRng para medir RTP/volatilidad.
 * play() no debe usar Math.random ni estado global: toda aleatoriedad viene de `rng`.
 */
export interface GameMath<Config = unknown, Outcome = unknown> {
  id: string;
  name: string;
  kind: 'slot' | 'original';
  /** RTP objetivo como fracción (0.965 = 96.5 %). */
  rtpTarget: number;
  /** Rango permitido para configurar por operador (fracciones). */
  rtpRange?: { min: number; max: number };
  volatility: Volatility;
  maxWinMultiplier: number;
  /** Datos JSON: rodillos, tabla de pagos, funciones. */
  config: Config;
  play(rng: Rng, opts?: PlayOptions): PlayResult<Outcome>;
  /** Si existe, el juego admite compra de bonus a costMultiplier veces la apuesta. */
  bonusBuy?: { costMultiplier: number };
}
