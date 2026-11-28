import { HttpError } from '../../../shared/http/errors';
import type { DemoContext, LaunchContext, SignedRequest } from '../../domain/ProviderAdapter';
import type { GameDTO } from '../../domain/types';
import type { WalletAction, WalletErrorResponse, WalletOkResponse } from '../../domain/walletProtocol';
import { providerSecret, StandardProviderAdapter } from './StandardProviderAdapter';

/** Error uniforme para las partes que requieren la documentación del proveedor bajo contrato. */
export const contractRequired = (provider: string, what: string): HttpError =>
  new HttpError(501, 'PROVIDER_CONTRACT_REQUIRED', `${provider}: ${what} requiere la documentación de integración del proveedor (bajo contrato)`);

/**
 * Esqueleto de Pragmatic Play (slots y casino en vivo).
 *
 * Se activa solo si existen TODAS estas variables:
 * - HUB_PRAGMATIC_API_URL       URL base de la API de casino que entrega Pragmatic al firmar.
 * - HUB_PRAGMATIC_SECURE_LOGIN  identificador del operador en Pragmatic.
 * - HUB_PROVIDER_PRAGMATIC_PLAY_SECRET  clave secreta compartida para firmar/verificar.
 *
 * Pragmatic usa su propio protocolo seamless (nombres de campos, firma y códigos de error propios).
 * Aquí NO se inventan endpoints ni formatos privados: las funciones marcadas con TODO(contract)
 * deben completarse con la documentación oficial que entrega el proveedor tras el contrato.
 */
export class PragmaticPlayAdapter extends StandardProviderAdapter {
  readonly id = 'pragmatic-play';
  private readonly apiUrl?: string;
  private readonly secureLogin?: string;

  constructor(env: NodeJS.ProcessEnv) {
    super(providerSecret(env, 'pragmatic-play'));
    this.apiUrl = (env.HUB_PRAGMATIC_API_URL || '').replace(/\/$/, '');
    this.secureLogin = env.HUB_PRAGMATIC_SECURE_LOGIN || undefined;
  }

  get enabled(): boolean {
    return Boolean(this.secret && this.apiUrl);
  }

  /** Sesión real: el runner del proveedorPP apuesta contra el ledger con sessionToken. */
  async launchGame(ctx: LaunchContext): Promise<{ url: string }> {
    const q = new URLSearchParams({
      token: ctx.session.token,
      playerId: ctx.session.playerId,
      operatorId: ctx.session.operatorId,
      currency: ctx.session.currency,
      operator: this.secureLogin ?? '',
      language: ctx.language ?? 'es',
      mode: ctx.session.mode ?? 'real',
    });
    if (ctx.returnUrl) q.set('returnUrl', ctx.returnUrl);
    return { url: `${this.apiUrl}/real/${ctx.game.externalId}?${q.toString()}`, externalSessionId: ctx.session.id };
  }

  /** Cliente oficial de Pragmatic embebido (entretenimiento / fun mode). */
  async launchDemo(ctx: DemoContext): Promise<{ url: string }> {
    const q = new URLSearchParams({ language: ctx.language ?? 'es' });
    if (ctx.returnUrl) q.set('returnUrl', ctx.returnUrl);
    return { url: `${this.apiUrl}/jugar/${ctx.game.externalId}?${q.toString()}` };
  }

  /** Catálogo del proveedorPP (358+ slots con carátulas oficiales). */
  async syncCatalog(): Promise<GameDTO[]> {
    const r = await fetch(`${this.apiUrl}/api/abyss/catalogo`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`catalogo HTTP ${r.status}`);
    const body = (await r.json()) as { items?: Array<{ externalId: string; title: string; mechanic?: string; rtp?: number; images?: { thumb?: string; banner?: string } }> };
    return (body.items ?? []).map((it) => ({
      externalId: it.externalId,
      title: it.title,
      category: 'slots' as const,
      mechanic: it.mechanic,
      rtp: it.rtp,
      volatility: 'medium' as const,
      images: it.images,
      hasDemo: true,
    }));
  }

  // La wallet la maneja el propio proveedorPP llamando /hub/v1/wallet/* como cliente
  // (bet/win/rollback firmados); no recibimos callbacks suyos, así que la firma
  // entrante heredada basta y mapRequest/mapResponse quedan en passthrough estándar.
}

export class EvolutionAdapter extends StandardProviderAdapter {
  readonly id = 'evolution';
  private readonly apiUrl?: string;
  private readonly casinoKey?: string;
  private readonly apiToken?: string;

  constructor(env: NodeJS.ProcessEnv) {
    super(providerSecret(env, 'evolution'));
    this.apiUrl = env.HUB_EVOLUTION_API_URL || undefined;
    this.casinoKey = env.HUB_EVOLUTION_CASINO_KEY || undefined;
    this.apiToken = env.HUB_EVOLUTION_API_TOKEN || undefined;
  }

  get enabled(): boolean {
    return Boolean(this.secret && this.apiUrl && this.casinoKey && this.apiToken);
  }

  async launchGame(_ctx: LaunchContext): Promise<{ url: string }> {
    // TODO(contract): petición de autenticación de usuario (datos del jugador, sesión, mesa/categoría)
    // que devuelve la URL de entrada a la mesa en vivo.
    throw contractRequired('Evolution', 'launchGame');
  }

  async launchDemo(_ctx: DemoContext): Promise<{ url: string }> {
    // El casino en vivo normalmente no tiene demo con dinero ficticio.
    throw contractRequired('Evolution', 'launchDemo');
  }

  async syncCatalog(): Promise<GameDTO[]> {
    // TODO(contract): listado de mesas/juegos disponibles para el casino key.
    throw contractRequired('Evolution', 'syncCatalog');
  }

  verifySignature(_req: SignedRequest): boolean {
    // TODO(contract): Evolution autentica callbacks con token propio (no HMAC del cuerpo). Falla cerrado.
    return false;
  }

  mapRequest(_action: WalletAction, _body: unknown): unknown {
    // TODO(contract): mapear sus callbacks (balance, debit, credit, cancel) al protocolo estándar.
    throw contractRequired('Evolution', 'mapRequest');
  }

  mapResponse(_action: WalletAction, _res: WalletOkResponse): unknown {
    // TODO(contract): formato de respuesta (status y saldo) de Evolution.
    throw contractRequired('Evolution', 'mapResponse');
  }
}

/**
 * Agregador genérico (modelo común a SoftSwiss, Slotegrator, Hub88 y similares).
 *
 * Variables:
 * - HUB_AGGREGATOR_ID            id del proveedor en el catálogo (p. ej. 'hub88'); por defecto 'aggregator'.
 * - HUB_AGGREGATOR_API_URL       URL base del agregador.
 * - HUB_AGGREGATOR_OPERATOR_ID   id del operador en el agregador.
 * - HUB_PROVIDER_<ID>_SECRET     secreto de firma (con ID = HUB_AGGREGATOR_ID en mayúsculas).
 *
 * Mapea solo el modelo genérico que comparten: callbacks firmados con HMAC del cuerpo y operaciones
 * balance/bet/win/rollback idempotentes por transactionId. Si el agregador elegido usa firma RSA o
 * nombres distintos, se ajusta en mapRequest/verifySignature con su documentación.
 */
export class GenericAggregatorAdapter extends StandardProviderAdapter {
  readonly id: string;
  private readonly apiUrl?: string;
  private readonly operatorRef?: string;

  constructor(env: NodeJS.ProcessEnv) {
    const id = env.HUB_AGGREGATOR_ID || 'aggregator';
    super(providerSecret(env, id));
    this.id = id;
    this.apiUrl = env.HUB_AGGREGATOR_API_URL || undefined;
    this.operatorRef = env.HUB_AGGREGATOR_OPERATOR_ID || undefined;
  }

  get enabled(): boolean {
    return Boolean(this.secret && this.apiUrl && this.operatorRef);
  }

  async launchGame(_ctx: LaunchContext): Promise<{ url: string }> {
    // TODO(contract): endpoint de "game launch"/"game url" del agregador con operatorRef, token de
    // sesión, id de juego, moneda, idioma y returnUrl, firmado según su manual.
    throw contractRequired(this.id, 'launchGame');
  }

  async launchDemo(_ctx: DemoContext): Promise<{ url: string }> {
    // TODO(contract): variante demo del endpoint de lanzamiento.
    throw contractRequired(this.id, 'launchDemo');
  }

  async syncCatalog(): Promise<GameDTO[]> {
    // TODO(contract): endpoint de listado de juegos (normalmente paginado) y mapeo de sus campos a GameDTO.
    throw contractRequired(this.id, 'syncCatalog');
  }

  // verifySignature/mapRequest/mapResponse heredan el modelo genérico HMAC + protocolo estándar.
  // TODO(contract): ajustar nombres de campos y cabecera de firma del agregador elegido.
}
