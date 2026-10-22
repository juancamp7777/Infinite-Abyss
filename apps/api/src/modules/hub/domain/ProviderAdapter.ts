import type { Game, GameDTO, HubSession, HubTxType } from './types';
import type { BetRequest, RollbackRequest, WalletAction, WalletErrorResponse, WalletOkResponse, WinRequest } from './walletProtocol';

export interface LaunchContext {
  session: HubSession;
  game: Game;
  returnUrl?: string;
  language?: string;
  /** URL pública de esta API (para callbacks y el servidor mock). */
  publicApiUrl: string;
  /** URL pública del frontend del jugador. */
  webUrl: string;
}

export interface DemoContext {
  game: Game;
  currency: string;
  returnUrl?: string;
  language?: string;
  publicApiUrl: string;
  webUrl: string;
}

export interface SignedRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

/** Resultado del lanzamiento. `externalSessionId` = id de sesión del proveedor si sus callbacks lo usan. */
export interface LaunchResult {
  url: string;
  externalSessionId?: string;
}

/** Callback con protocolo propio (un solo endpoint por proveedor, p. ej. agregadores). */
export interface CallbackRequest extends SignedRequest {
  method: string;
  /** Ruta tal como llegó (sin query): algunos proveedores la firman. */
  path: string;
  /** Segmento opcional de la URL (p. ej. entorno de API-Matic: sandbox | produccion). */
  variant?: string;
  body: unknown;
  /** IP del cliente según la configuración de proxies de confianza. */
  ip?: string;
}

/** Respuesta ya serializada en el formato del proveedor (algunos exigen números JSON exactos). */
export interface CallbackResponse {
  status: number;
  body: string;
}

/**
 * Operaciones de billetera del Hub para los adaptadores con callback propio. Reutiliza las reglas del protocolo
 * estándar (idempotencia, tombstones, rondas, eventos); el adaptador solo traduce formatos.
 */
export interface HubWalletFacade {
  sessionByExternalId(externalSessionId: string): Promise<HubSession | null>;
  balance(session: HubSession): Promise<WalletOkResponse>;
  bet(session: HubSession, req: Omit<BetRequest, 'sessionToken'>): Promise<WalletOkResponse>;
  win(session: HubSession, req: Omit<WinRequest, 'sessionToken'>): Promise<WalletOkResponse>;
  rollback(session: HubSession, req: Omit<RollbackRequest, 'sessionToken'>): Promise<WalletOkResponse>;
  /** Tipo y estado de una transacción ya registrada de este proveedor (para resolver reversiones). */
  findTx(providerTxId: string): Promise<{ type: HubTxType; status: string } | null>;
  /** Decimales de la moneda (unidades mínimas del ledger). */
  decimals(currency: string): number;
}

/**
 * Adaptador de un proveedor de juegos (lado entrante: proveedor externo → Infinite Abyss).
 * Cada proveedor traduce su protocolo propio al protocolo seamless estándar de Infinite Abyss (walletProtocol.ts).
 */
export interface ProviderAdapter {
  readonly id: string;
  /** true si tiene las credenciales necesarias en el entorno. Los adaptadores sin credenciales no se registran. */
  readonly enabled: boolean;
  launchGame(ctx: LaunchContext): Promise<LaunchResult>;
  launchDemo(ctx: DemoContext): Promise<{ url: string }>;
  syncCatalog(): Promise<GameDTO[]>;
  verifySignature(req: SignedRequest): boolean;
  /** Formato del proveedor → cuerpo estándar Infinite Abyss (se valida después con zod). */
  mapRequest(action: WalletAction, body: unknown): unknown;
  /** Respuesta estándar Infinite Abyss → formato del proveedor. */
  mapResponse(action: WalletAction, res: WalletOkResponse): unknown;
  /** Error estándar → status + cuerpo en formato del proveedor. */
  mapError(action: WalletAction, err: WalletErrorResponse): { status: number; body: unknown };
  /** ¿Se acepta un win sin apuesta previa en la ronda? (giros gratis/premios de bonus del proveedor). */
  allowsWinWithoutBet(req: WinRequest): boolean;
  /**
   * Opcional: proveedores con un único endpoint de callback y protocolo propio (/hub/v1/providers/:id/callback).
   * El adaptador verifica la autenticación (firma, nonce, IP…) y traduce a operaciones de la fachada.
   */
  handleCallback?(req: CallbackRequest, wallet: HubWalletFacade): Promise<CallbackResponse>;
}
