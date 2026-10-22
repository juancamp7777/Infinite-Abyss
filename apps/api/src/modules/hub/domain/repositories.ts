import type { GameCategory } from '../../shared/events/EventBus';
import type {
  Game,
  HubRound,
  HubSession,
  HubTransaction,
  OperatorGame,
  Provider,
  RemoteOperator,
} from './types';

export interface CatalogRepository {
  listProviders(): Promise<Provider[]>;
  getProvider(id: string): Promise<Provider | null>;
  saveProvider(p: Provider): Promise<Provider>;
  deleteProvider(id: string): Promise<boolean>;

  /** Todos los juegos (el filtrado fino lo hace CatalogService; el catálogo cabe en memoria). */
  listGames(filter?: { providerId?: string; category?: GameCategory }): Promise<Game[]>;
  getGame(id: string): Promise<Game | null>;
  saveGame(g: Game): Promise<Game>;
  deleteGame(id: string): Promise<boolean>;

  listOperatorGames(operatorId: string): Promise<OperatorGame[]>;
  saveOperatorGame(og: OperatorGame): Promise<OperatorGame>;
}

export interface SessionRepository {
  create(s: HubSession): Promise<HubSession>;
  findByToken(token: string): Promise<HubSession | null>;
  findById(id: string): Promise<HubSession | null>;
  /** Extiende la expiración (sesión deslizante). */
  touch(id: string, expiresAt: Date): Promise<void>;
  /** Guarda el id de sesión que asignó el proveedor al lanzar (los agregadores lo usan en sus callbacks). */
  setExternalSessionId(id: string, externalSessionId: string): Promise<void>;
  /** Sesión por (proveedor, id de sesión del proveedor). */
  findByExternalId(providerId: string, externalSessionId: string): Promise<HubSession | null>;
}

/** Error lanzado al insertar una transacción con (providerId, providerTxId) ya existente. */
export class DuplicateTransactionError extends Error {
  constructor() {
    super('Transacción duplicada');
    this.name = 'DuplicateTransactionError';
  }
}

export interface ReportFilter {
  from?: Date;
  to?: Date;
  operatorId?: string;
  providerId?: string;
}

export interface ReportRow {
  providerId: string;
  gameId: string;
  bets: bigint;
  wins: bigint;
  rounds: number;
  openRounds: number;
}

export interface WalletTxRepository {
  findTx(providerId: string, providerTxId: string): Promise<HubTransaction | null>;
  /** Inserta; lanza DuplicateTransactionError si ya existe la clave (providerId, providerTxId). */
  insertTx(tx: HubTransaction): Promise<HubTransaction>;
  updateTx(id: string, patch: Partial<Pick<HubTransaction, 'status' | 'response' | 'walletTxId'>>): Promise<void>;

  findRound(providerId: string, providerRoundId: string): Promise<HubRound | null>;
  /** Inserta o reemplaza por (providerId, providerRoundId). */
  saveRound(r: HubRound): Promise<HubRound>;

  /** Agregado por proveedor y juego de las rondas creadas en el rango. */
  aggregate(filter: ReportFilter): Promise<ReportRow[]>;
}

export interface RemoteOperatorRepository {
  list(): Promise<RemoteOperator[]>;
  get(id: string): Promise<RemoteOperator | null>;
  save(r: RemoteOperator): Promise<RemoteOperator>;
}

export interface HubRepositories {
  catalog: CatalogRepository;
  sessions: SessionRepository;
  txs: WalletTxRepository;
  remoteOperators: RemoteOperatorRepository;
}
