import type { DemoContext, LaunchContext, ProviderAdapter, SignedRequest } from '../../domain/ProviderAdapter';
import type { GameDTO } from '../../domain/types';
import type { WalletAction, WalletErrorResponse, WalletOkResponse } from '../../domain/walletProtocol';

export const STUDIO_PROVIDER_ID = 'nymfo-studios';

/**
 * Proveedor interno (Nymfo Studios). Sus juegos corren en apps/web y cobran con
 * services.walletForSession(token): no usan la API seamless entrante, así que verifySignature falla cerrado.
 */
export class NymfoStudiosAdapter implements ProviderAdapter {
  readonly id = STUDIO_PROVIDER_ID;
  readonly enabled = true;

  constructor(private readonly launchPath: string = '/studio') {}

  /** URL de juego de Studios: `${WEB_URL}${launchPath}/<gameId>?mode=...&session=...`. */
  studioUrl(webUrl: string, gameId: string, mode: 'real' | 'demo', token: string, returnUrl?: string): string {
    const q = new URLSearchParams({ mode, session: token });
    if (returnUrl) q.set('returnUrl', returnUrl);
    return `${webUrl}${this.launchPath}/${encodeURIComponent(gameId)}?${q}`;
  }

  async launchGame(ctx: LaunchContext): Promise<{ url: string }> {
    return { url: this.studioUrl(ctx.webUrl, ctx.game.id, ctx.session.mode, ctx.session.token, ctx.returnUrl) };
  }

  async launchDemo(ctx: DemoContext): Promise<{ url: string }> {
    // Studios siempre necesita sesión (también demo): LaunchService usa launchGame con una sesión demo.
    return { url: `${ctx.webUrl}${this.launchPath}/${encodeURIComponent(ctx.game.id)}?mode=demo` };
  }

  async syncCatalog(): Promise<GameDTO[]> {
    return [];
  }

  verifySignature(_req: SignedRequest): boolean {
    return false;
  }

  mapRequest(_action: WalletAction, body: unknown): unknown {
    return body;
  }

  mapResponse(_action: WalletAction, res: WalletOkResponse): unknown {
    return res;
  }

  mapError(_action: WalletAction, err: WalletErrorResponse): { status: number; body: unknown } {
    return { status: err.status, body: { status: 'ERROR', error: { code: err.code, message: err.message } } };
  }

  allowsWinWithoutBet(): boolean {
    return false;
  }
}
