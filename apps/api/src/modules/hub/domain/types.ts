import type { GameCategory } from '../../shared/events/EventBus';

/** Entidades del agregador Nymfo Hub. Montos en unidades mínimas (bigint). */

export type ProviderType = 'internal' | 'external' | 'aggregator';
export type ProviderStatus = 'active' | 'disabled';
export type GameStatus = 'active' | 'disabled';
export type Volatility = 'low' | 'medium' | 'high' | 'very_high';

export const GAME_CATEGORIES: readonly GameCategory[] = ['slots', 'originals', 'live', 'table', 'other'];

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  status: ProviderStatus;
  /** Configuración pública (logo, color, jurisdicciones…). Nunca secretos: esos van por env. */
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GameImages {
  thumb: string;
  banner: string;
}

export interface Game {
  id: string;
  providerId: string;
  /** Id del juego en el sistema del proveedor (por defecto igual a id). */
  externalId: string;
  title: string;
  category: GameCategory;
  mechanic: string;
  /** RTP teórico en porcentaje, p. ej. 96.5. */
  rtp: number;
  volatility: Volatility;
  images: GameImages;
  tags: string[];
  /** Mercados ISO-3166 permitidos; vacío = todos. */
  allowedMarkets: string[];
  status: GameStatus;
  hasDemo: boolean;
  releasedAt: Date;
  /** Puntuación de popularidad (mayor = más popular). */
  popularity: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Activación y orden de un juego para un operador. Sin fila → activo con orden por popularidad. */
export interface OperatorGame {
  operatorId: string;
  gameId: string;
  enabled: boolean;
  sortOrder: number;
}

export type SessionMode = 'real' | 'demo';
/** local = billetera del operador Nymfo (WalletPort); remote = billetera de un casino externo (lado saliente). */
export type WalletKind = 'local' | 'remote' | 'demo';

export interface HubSession {
  id: string;
  /** Token opaco que viaja en la URL de juego y en las llamadas del proveedor. */
  token: string;
  operatorId: string;
  playerId: string;
  providerId: string;
  gameId: string;
  currency: string;
  mode: SessionMode;
  walletKind: WalletKind;
  /** Solo walletKind=remote: id del RemoteOperator. */
  remoteOperatorId?: string;
  expiresAt: Date;
  createdAt: Date;
}

export type RoundStatus = 'open' | 'settled' | 'rolled_back';

export interface HubRound {
  id: string;
  providerId: string;
  /** Id de ronda que envía el proveedor. */
  providerRoundId: string;
  operatorId: string;
  playerId: string;
  gameId: string;
  currency: string;
  sessionId: string;
  betAmount: bigint;
  winAmount: bigint;
  status: RoundStatus;
  createdAt: Date;
  settledAt?: Date;
}

export type HubTxType = 'BET' | 'WIN' | 'ROLLBACK' | 'TOMBSTONE';
export type HubTxStatus = 'ok' | 'rolled_back' | 'tombstone';

export interface HubTransaction {
  id: string;
  providerId: string;
  /** transactionId del proveedor (clave de idempotencia junto con providerId). */
  providerTxId: string;
  type: HubTxType;
  status: HubTxStatus;
  operatorId: string;
  playerId: string;
  currency: string;
  amount: bigint;
  providerRoundId?: string;
  gameId?: string;
  sessionId?: string;
  /** ROLLBACK/TOMBSTONE: transactionId del proveedor anulado. */
  referenceTxId?: string;
  walletTxId?: string;
  /** Huella del payload: el mismo transactionId con otro payload es DUPLICATE. */
  fingerprint: string;
  /** Respuesta devuelta (para reintentos idempotentes). */
  response?: Record<string, unknown>;
  createdAt: Date;
}

export interface RemoteOperator {
  id: string;
  name: string;
  /** Base URL de la billetera del casino remoto: se llama a {url}/balance|bet|win|rollback. */
  walletCallbackUrl: string;
  status: 'active' | 'disabled';
  currencies: string[];
  createdAt: Date;
}

/** Juego tal como lo entrega un proveedor en la sincronización del catálogo. */
export interface GameDTO {
  externalId: string;
  title: string;
  category: GameCategory;
  mechanic?: string;
  rtp?: number;
  volatility?: Volatility;
  images?: Partial<GameImages>;
  tags?: string[];
  allowedMarkets?: string[];
  hasDemo?: boolean;
  releasedAt?: string;
}

/** Normaliza un id externo a un id de catálogo estable: `<providerId>-<externalId>` en minúsculas. */
export function catalogGameId(providerId: string, externalId: string): string {
  const slug = externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.startsWith(`${providerId}-`) ? slug : `${providerId}-${slug}`;
}

/** Nombre de variable de entorno a partir de un id: `mock-provider` → `MOCK_PROVIDER`. */
export function envKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}
