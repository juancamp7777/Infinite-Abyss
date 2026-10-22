import type { Game, GameDTO, HubSession } from './types';
import type { WalletAction, WalletErrorResponse, WalletOkResponse, WinRequest } from './walletProtocol';

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

/**
 * Adaptador de un proveedor de juegos (lado entrante: proveedor externo → Nymfo).
 * Cada proveedor traduce su protocolo propio al protocolo seamless estándar de Nymfo (walletProtocol.ts).
 */
export interface ProviderAdapter {
  readonly id: string;
  /** true si tiene las credenciales necesarias en el entorno. Los adaptadores sin credenciales no se registran. */
  readonly enabled: boolean;
  launchGame(ctx: LaunchContext): Promise<{ url: string }>;
  launchDemo(ctx: DemoContext): Promise<{ url: string }>;
  syncCatalog(): Promise<GameDTO[]>;
  verifySignature(req: SignedRequest): boolean;
  /** Formato del proveedor → cuerpo estándar Nymfo (se valida después con zod). */
  mapRequest(action: WalletAction, body: unknown): unknown;
  /** Respuesta estándar Nymfo → formato del proveedor. */
  mapResponse(action: WalletAction, res: WalletOkResponse): unknown;
  /** Error estándar → status + cuerpo en formato del proveedor. */
  mapError(action: WalletAction, err: WalletErrorResponse): { status: number; body: unknown };
  /** ¿Se acepta un win sin apuesta previa en la ronda? (giros gratis/premios de bonus del proveedor). */
  allowsWinWithoutBet(req: WinRequest): boolean;
}
