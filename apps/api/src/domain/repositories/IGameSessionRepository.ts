import { GameType, GameStatus } from '@prisma/client';

export interface GameSessionData {
  id: string;
  operatorId: string;
  userId: string;
  gameType: GameType;
  status: GameStatus;
  /** Unidades mínimas de `currency`. */
  betAmount: bigint;
  currency: string;
  state: any;
}

export interface CreateGameSessionInput {
  /** Opcional: permite reservar el id antes de cobrar (referencia del ledger). */
  id?: string;
  operatorId: string;
  userId: string;
  gameType: GameType;
  betAmount: bigint;
  currency: string;
  state: any;
  status?: GameStatus;
}

/** Alcance de lectura: una sesión solo es visible para su jugador y su operador. */
export interface GameSessionScope {
  operatorId: string;
  userId: string;
}

export interface IGameSessionRepository {
  createSession(input: CreateGameSessionInput): Promise<GameSessionData>;
  /** Devuelve null si la sesión no existe o pertenece a otro usuario/operador. */
  getSession(sessionId: string, scope: GameSessionScope): Promise<GameSessionData | null>;
  updateSessionState(sessionId: string, state: any, status?: GameStatus): Promise<GameSessionData>;
  /**
   * Cierra la sesión solo si sigue ACTIVE (UPDATE ... WHERE id AND status = ACTIVE).
   * Devuelve true si esta llamada la cerró; false si otra ya lo hizo (evita doble pago).
   */
  finishIfActive(sessionId: string, state: any): Promise<boolean>;
}
