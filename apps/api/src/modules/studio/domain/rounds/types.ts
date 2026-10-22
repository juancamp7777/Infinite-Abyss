/**
 * Entidades y puertos de persistencia de Nymfo Studios (rondas, semillas provably fair y config por operador).
 * Montos en bigint (unidades mínimas). Los estados JSON son serializables (sin clases).
 */

export type RoundStatus = 'OPEN' | 'SETTLED' | 'ROLLED_BACK' | 'FAILED';
export type RoundMode = 'real' | 'demo';

export interface StudioRound {
  id: string;
  operatorId: string;
  playerId: string;
  gameId: string;
  /** Apuesta total cobrada (incluye compra de bonus, dobles y splits). */
  bet: bigint;
  /** Apuesta base sobre la que se aplica el multiplicador. */
  baseBet: bigint;
  win: bigint;
  multiplier: number;
  currency: string;
  /** Resultado público (para animar y auditar). */
  outcome: unknown;
  /** Estado interno de juegos interactivos (oculto al jugador mientras la ronda está abierta). */
  state: unknown;
  params: Record<string, unknown>;
  /** RTP efectivo (fracción) con el que se jugó. */
  rtp: number;
  rtpProfile: string | null;
  bonusBuy: boolean;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  /** Id del par de semillas (para revelar el serverSeed tras la rotación). */
  seedPairId: string;
  status: RoundStatus;
  mode: RoundMode;
  /** Cantidad de cobros realizados (apuesta base + dobles/splits) para las claves de idempotencia. */
  debits: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoundFilter {
  operatorId: string;
  playerId: string;
  gameId?: string;
  mode?: RoundMode;
  limit: number;
  offset: number;
}

export interface RoundRepository {
  /** Lanza RoundExistsError si el id ya existe. */
  create(round: StudioRound): Promise<void>;
  get(id: string): Promise<StudioRound | null>;
  /** Actualiza solo si la versión guardada es expectedVersion (concurrencia optimista); devuelve false si no. */
  update(round: StudioRound, expectedVersion: number): Promise<boolean>;
  list(filter: RoundFilter): Promise<StudioRound[]>;
  findOpen(operatorId: string, playerId: string, gameId: string, mode: RoundMode): Promise<StudioRound | null>;
  countOpen(operatorId: string, playerId: string): Promise<number>;
}

export class RoundExistsError extends Error {
  constructor(id: string) {
    super(`La ronda ${id} ya existe`);
    this.name = 'RoundExistsError';
  }
}

export interface StudioSeedPair {
  id: string;
  operatorId: string;
  playerId: string;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** Próximo nonce a usar. */
  nonce: number;
  active: boolean;
  createdAt: Date;
  revealedAt: Date | null;
}

export interface SeedPairRepository {
  getActive(operatorId: string, playerId: string): Promise<StudioSeedPair | null>;
  create(pair: StudioSeedPair): Promise<StudioSeedPair>;
  /** Devuelve el nonce consumido (atómico) o null si el par ya no está activo. */
  consumeNonce(id: string): Promise<number | null>;
  setClientSeed(id: string, clientSeed: string): Promise<void>;
  /** Desactiva el par y marca revealedAt. */
  deactivate(id: string, at: Date): Promise<void>;
  get(id: string): Promise<StudioSeedPair | null>;
}

export interface StudioOperatorConfig {
  operatorId: string;
  gameId: string;
  /** RTP elegido (fracción) para originals de RTP continuo; null = por defecto. */
  rtp: number | null;
  /** Perfil discreto de slots (porcentaje como string); null = por defecto. */
  rtpProfile: string | null;
  minBet: bigint | null;
  maxBet: bigint | null;
  enabled: boolean;
  updatedAt: Date;
}

export interface OperatorConfigRepository {
  get(operatorId: string, gameId: string): Promise<StudioOperatorConfig | null>;
  list(operatorId: string): Promise<StudioOperatorConfig[]>;
  upsert(config: StudioOperatorConfig): Promise<StudioOperatorConfig>;
}
