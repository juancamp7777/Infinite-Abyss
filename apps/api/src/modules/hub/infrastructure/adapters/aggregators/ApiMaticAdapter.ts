import { randomBytes } from 'crypto';
import type { BlockList } from 'net';
import { z } from 'zod';
import { HttpError } from '../../../../shared/http/errors';
import type { ModuleLogger } from '../../../../shared/module';
import { decimalToMinor, DecimalAmountError, minorToDecimal } from '../../../domain/decimalMoney';
import type { CallbackRequest, CallbackResponse, DemoContext, HubWalletFacade, LaunchContext, LaunchResult, ProviderAdapter, SignedRequest } from '../../../domain/ProviderAdapter';
import { parseUnixSeconds, withinWindow, type NonceStore } from '../../../domain/replayGuard';
import type { GameDTO, HubSession } from '../../../domain/types';
import type { WalletAction, WalletErrorResponse, WalletOkResponse, WinRequest } from '../../../domain/walletProtocol';
import { ipAllowed, parseAllowlist } from '../../net/ipAllowlist';
import { errorCode, findOriginal, providerError, readLimited, txKey, withRoundFallback } from './aggregatorSupport';
import { apiMaticKey, apiMaticSign, apiMaticVerify } from './apiMaticSign';

export const API_MATIC_ID = 'api-matic';
export const API_MATIC_HOSTS = { produccion: 'https://api.api-matic.com', sandbox: 'https://sandbox-api.api-matic.com' } as const;
export type ApiMaticEnvironment = keyof typeof API_MATIC_HOSTS;

/** Contrato de API-Matic: ventana de ±300 s para X-Timestamp; el nonce se recuerda 10 min. */
const WINDOW_SEC = 300;
const NONCE_TTL_MS = 600_000;
const MAX_NONCE = 128;

export interface ApiMaticConfig {
  apiKey: string;
  secretHex: string;
  /** Base de la API (sin barra final). Con key de producción (ukp_) siempre es la de producción. */
  host?: string;
  /** Moneda con que se pide el catálogo (obligatoria para sincronizar). */
  catalogCurrency?: string;
  /** Moneda del ledger → código de API-Matic (p. ej. ARS → ARS_PA). Sin entrada se envía igual. */
  currencyMap?: Record<string, string>;
  /** Ruta exacta que API-Matic llama y firma (si un proxy la reescribe antes de llegar aquí). */
  callbackPath?: string;
  allowlist?: BlockList | null;
  nonces: NonceStore;
  logger: ModuleLogger;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const zDecimal = z.string().regex(/^\d{1,30}(\.\d{1,18})?$/);
const zPostback = z.object({
  action: z.enum(['balance', 'bet', 'win', 'refund', 'rollback']),
  session_id: z.string().min(1).max(256),
  transaction_id: z.string().max(256).optional(),
  amount: zDecimal.optional(),
  currency: z.string().max(16).optional(),
  game_uuid: z.string().max(128).optional(),
  round_id: z.string().max(256).optional().nullable(),
  bet_transaction_id: z.string().max(256).optional().nullable(),
  rollback_transactions: z.array(z.object({ transaction_id: z.string().max(256).optional().nullable(), type: z.string().max(16).optional().nullable() })).optional(),
}).superRefine((p, ctx) => {
  const needsAmount = p.action === 'bet' || p.action === 'win' || p.action === 'refund';
  if ((needsAmount || p.action === 'rollback') && !p.transaction_id) ctx.addIssue({ code: 'custom', message: 'transaction_id requerido', path: ['transaction_id'] });
  if (needsAmount && p.amount === undefined) ctx.addIssue({ code: 'custom', message: 'amount requerido', path: ['amount'] });
  if (p.action === 'rollback' && !p.rollback_transactions?.length) ctx.addIssue({ code: 'custom', message: 'rollback_transactions requerido', path: ['rollback_transactions'] });
});
type Postback = z.infer<typeof zPostback>;

const zGamesPage = z.object({
  data: z.array(z.object({
    uuid: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    provider: z.string().max(120).optional().nullable(),
    images: z.array(z.object({ role: z.string().optional().nullable(), url: z.string().url() })).optional().nullable(),
  }).passthrough()).optional(),
  meta: z.object({ page: z.number().optional(), last_page: z.number().optional() }).partial().optional(),
}).passthrough();

const zLaunch = z.object({ success: z.boolean().optional(), data: z.object({ link: z.string().url(), vendor_session_id: z.string().min(1).max(256) }).passthrough() }).passthrough();

const json = (status: number, body: Record<string, unknown>): CallbackResponse => ({ status, body: JSON.stringify(body) });
const reject = (code: string, status = 200) => json(status, { error_code: code });

/**
 * API-Matic (agregador): catálogo y lanzamiento firmados, y postbacks seamless (balance/bet/win/refund/rollback)
 * en un único endpoint /hub/v1/providers/api-matic/callback/<entorno>.
 *
 * Contrato de respuestas (docs de API-Matic): aceptado = 200 + `balance` como NÚMERO JSON y sin `error_code`.
 * En bet, un `error_code` rechaza la apuesta; en win/refund/rollback significa "no entregado" y API-Matic reintenta
 * (50 veces en ~43 h), así que lo que decidimos no aplicar se responde 200 con el saldo. Fallos nuestros → 503.
 */
export class ApiMaticAdapter implements ProviderAdapter {
  readonly id = API_MATIC_ID;
  readonly enabled = true;
  readonly environment: ApiMaticEnvironment;
  private readonly key: Buffer;
  private readonly host: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ApiMaticConfig) {
    this.key = apiMaticKey(cfg.secretHex);
    this.environment = cfg.apiKey.startsWith('ukp_') ? 'produccion' : 'sandbox';
    // Una key de producción nunca sale hacia otro host (evita mandar credenciales reales a un sandbox o a un tercero).
    this.host = (this.environment === 'produccion' ? API_MATIC_HOSTS.produccion : cfg.host || API_MATIC_HOSTS.sandbox).replace(/\/+$/, '');
    this.now = cfg.now ?? Date.now;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Construye el adaptador desde HUB_APIMATIC_*; null si no está configurado. Configuración parcial = error de arranque. */
  static fromEnv(env: NodeJS.ProcessEnv, deps: { nonces: NonceStore; logger: ModuleLogger }): ApiMaticAdapter | null {
    const apiKey = env.HUB_APIMATIC_API_KEY?.trim();
    const secretHex = env.HUB_APIMATIC_SECRET_KEY?.trim();
    if (!apiKey && !secretHex) return null;
    if (!apiKey || !secretHex) throw new Error('API-Matic: HUB_APIMATIC_API_KEY y HUB_APIMATIC_SECRET_KEY van juntas');
    return new ApiMaticAdapter({
      apiKey,
      secretHex,
      host: env.HUB_APIMATIC_HOST?.trim() || undefined,
      catalogCurrency: env.HUB_APIMATIC_CATALOG_CURRENCY?.trim() || undefined,
      currencyMap: parseCurrencyMap(env.HUB_APIMATIC_CURRENCY_MAP),
      callbackPath: env.HUB_APIMATIC_CALLBACK_PATH?.trim() || undefined,
      allowlist: parseAllowlist(env.HUB_APIMATIC_ALLOWED_IPS),
      ...deps,
    });
  }

  get apiHost(): string {
    return this.host;
  }

  // ------------------------------------------------------------------ saliente

  private async request(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; timeoutMs: number }): Promise<unknown> {
    const body = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const ts = String(Math.floor(this.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.host}${path}${qs}`, {
        method,
        headers: {
          'X-API-Key': this.cfg.apiKey,
          'X-Timestamp': ts,
          'X-Nonce': nonce,
          'X-Sign': apiMaticSign(this.key, ts, nonce, method, path, body),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      throw providerError('API-Matic', e instanceof Error ? e.message : String(e), [this.cfg.apiKey]);
    }
    const text = await readLimited(res, 8 * 1024 * 1024).catch((e: Error) => { throw providerError('API-Matic', e.message); });
    if (res.status !== 200) throw providerError('API-Matic', `HTTP ${res.status}: ${text.slice(0, 256)}`, [this.cfg.apiKey]);
    try {
      return JSON.parse(text);
    } catch {
      throw providerError('API-Matic', 'respuesta no es JSON');
    }
  }

  async syncCatalog(): Promise<GameDTO[]> {
    if (!this.cfg.catalogCurrency) throw new HttpError(400, 'PROVIDER_CONFIG', 'API-Matic: define HUB_APIMATIC_CATALOG_CURRENCY para sincronizar el catálogo');
    const out: GameDTO[] = [];
    for (let page = 1; page <= 1000; page++) {
      const raw = await this.request('GET', '/api/v1/games', { query: { currency: this.cfg.catalogCurrency, page: String(page), per_page: '100' }, timeoutMs: 30_000 });
      const parsed = zGamesPage.safeParse(raw);
      if (!parsed.success) throw providerError('API-Matic', 'catálogo con formato inesperado');
      const data = parsed.data.data ?? [];
      for (const g of data) {
        const img = g.images?.find((i) => i.role === 'default') ?? g.images?.[0];
        out.push({
          externalId: g.uuid,
          title: g.name,
          category: 'slots',
          hasDemo: false,
          ...(img ? { images: { thumb: img.url, banner: img.url } } : {}),
          tags: ['aggregator:api-matic', ...(g.provider ? [`studio:${g.provider}`] : [])],
        });
      }
      const last = parsed.data.meta?.last_page;
      if (data.length === 0 || last === undefined || last <= page) break;
    }
    return out;
  }

  async launchGame(ctx: LaunchContext): Promise<LaunchResult> {
    const s = ctx.session;
    const raw = await this.request('POST', '/api/v1/game/launch', {
      headers: { 'X-Game-UUID': ctx.game.externalId },
      // El contrato rechaza campos desconocidos: solo player_id, currency y lang (RTP y giros gratis no van).
      body: { player_id: s.playerId, currency: this.mapCurrency(s.currency), ...(ctx.language ? { lang: ctx.language } : {}) },
      timeoutMs: 10_000,
    });
    const parsed = zLaunch.safeParse(raw);
    if (!parsed.success) throw providerError('API-Matic', 'lanzamiento sin link o vendor_session_id');
    return { url: parsed.data.data.link, externalSessionId: parsed.data.data.vendor_session_id };
  }

  async launchDemo(_ctx: DemoContext): Promise<{ url: string }> {
    throw new HttpError(403, 'GAME_UNAVAILABLE', 'API-Matic: modo demo no habilitado');
  }

  private mapCurrency(c: string): string {
    return this.cfg.currencyMap?.[c.toUpperCase()] ?? c.toUpperCase();
  }

  // ------------------------------------------------------------------ entrante (protocolo estándar: no se usa)

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
    return { status: err.status, body: { error_code: err.code } };
  }
  /** API-Matic es autoritativo sobre sus rondas (puede pagar sin apuesta en la ronda, p. ej. bonus del proveedor). */
  allowsWinWithoutBet(_req: WinRequest): boolean {
    return true;
  }

  // ------------------------------------------------------------------ postbacks

  async handleCallback(req: CallbackRequest, wallet: HubWalletFacade): Promise<CallbackResponse> {
    if (req.variant !== this.environment) return reject('NOT_CONFIGURED', 503);
    if (!ipAllowed(this.cfg.allowlist ?? null, req.ip)) return reject('FORBIDDEN', 403);
    if (!(await this.verifyEdge(req))) return reject('INVALID_SIGNATURE', 401);

    const parsed = zPostback.safeParse(req.body);
    if (!parsed.success) {
      this.cfg.logger.warn('api-matic: postback inválido', { issues: parsed.error.issues.map((i) => i.message) });
      return reject('BAD_REQUEST', 400);
    }
    const p = parsed.data;
    const session = await wallet.sessionByExternalId(p.session_id);
    if (!session) return reject('UNKNOWN_SESSION');

    try {
      switch (p.action) {
        case 'balance':
          return this.accept(wallet, session, await wallet.balance(session));
        case 'bet':
          return await this.bet(wallet, session, p);
        case 'win':
          return await this.win(wallet, session, p);
        case 'refund':
          return await this.refund(wallet, session, p);
        case 'rollback':
          return await this.rollback(wallet, session, p);
      }
    } catch (e) {
      return this.fail(e, p);
    }
  }

  /** Cabeceras, firma (método + ruta + cuerpo crudo), ventana ±300 s y nonce de un solo uso (solo si la firma es válida). */
  private async verifyEdge(req: CallbackRequest): Promise<boolean> {
    const h = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    const ts = h('x-timestamp');
    const nonce = h('x-nonce');
    const sign = h('x-sign');
    if (!ts || !nonce || !sign || nonce.length > MAX_NONCE) return false;
    const tsSec = parseUnixSeconds(ts);
    if (tsSec === null) return false;
    const path = this.cfg.callbackPath ?? req.path;
    if (!apiMaticVerify(this.key, sign, ts, nonce, req.method.toUpperCase(), path, req.rawBody)) return false;
    if (!withinWindow(tsSec, this.now(), WINDOW_SEC)) return false;
    return this.cfg.nonces.claim(`api-matic:${nonce}`, NONCE_TTL_MS);
  }

  private amount(p: Postback, session: HubSession, wallet: HubWalletFacade): bigint {
    return decimalToMinor(p.amount ?? '0', wallet.decimals(session.currency));
  }

  private async bet(wallet: HubWalletFacade, s: HubSession, p: Postback): Promise<CallbackResponse> {
    const amount = this.amount(p, s, wallet);
    if (amount <= 0n) return reject('BAD_REQUEST', 400);
    const tx = txKey('bet', p.transaction_id!);
    const res = await withRoundFallback(p.round_id || `tx:${p.transaction_id}`, p.transaction_id!, (roundId) =>
      wallet.bet(s, { transactionId: tx, roundId, amount, ...(p.game_uuid ? { gameId: p.game_uuid } : {}) }),
    );
    return this.accept(wallet, s, res, p.transaction_id);
  }

  private async win(wallet: HubWalletFacade, s: HubSession, p: Postback): Promise<CallbackResponse> {
    const amount = this.amount(p, s, wallet);
    const tx = txKey('win', p.transaction_id!);
    try {
      const res = await withRoundFallback(p.round_id || `tx:${p.transaction_id}`, p.transaction_id!, (roundId) =>
        wallet.win(s, { transactionId: tx, roundId, amount, roundClosed: true, ...(p.game_uuid ? { gameId: p.game_uuid } : {}) }),
      );
      return this.accept(wallet, s, res, p.transaction_id);
    } catch (e) {
      // Ya revertido antes de llegar (rollback anticipado): no se acredita, pero se confirma la entrega.
      if (errorCode(e) === 'BET_ROLLED_BACK') return this.accept(wallet, s, await wallet.balance(s));
      throw e;
    }
  }

  /** refund: anula una apuesta nombrada (bet_transaction_id). El monto sale de nuestro registro, no del postback. */
  private async refund(wallet: HubWalletFacade, s: HubSession, p: Postback): Promise<CallbackResponse> {
    if (!p.bet_transaction_id) return this.accept(wallet, s, await wallet.balance(s));
    const res = await wallet.rollback(s, { transactionId: txKey('refund', p.transaction_id!), referenceTransactionId: txKey('bet', p.bet_transaction_id), ...(p.round_id ? { roundId: p.round_id } : {}) });
    return this.accept(wallet, s, res, p.transaction_id);
  }

  /**
   * rollback: revierte una lista de transacciones (bet, win o refund). Cada item se resuelve contra nuestros registros;
   * lo desconocido queda como tombstone (si llega después, no se aplica) y lo que no se puede revertir (p. ej. un win
   * ya gastado) se registra y se sigue: el saldo nunca queda negativo.
   */
  private async rollback(wallet: HubWalletFacade, s: HubSession, p: Postback): Promise<CallbackResponse> {
    let last: WalletOkResponse | null = null;
    for (const item of p.rollback_transactions ?? []) {
      if (!item.transaction_id) continue;
      const declared = item.type ?? undefined;
      const ref = (await findOriginal(wallet, item.transaction_id, declared)) ?? txKey(declared === 'win' || declared === 'refund' ? declared : 'bet', item.transaction_id);
      const own = `rollback:${p.transaction_id}:${ref}`;
      try {
        last = await wallet.rollback(s, { transactionId: own, referenceTransactionId: ref, ...(p.round_id ? { roundId: p.round_id } : {}) });
      } catch (e) {
        const code = errorCode(e);
        // INSUFFICIENT_FUNDS: win ya gastado. DUPLICATE: el original es a su vez una reversión (refund).
        if (code !== 'INSUFFICIENT_FUNDS' && code !== 'DUPLICATE') throw e;
        this.cfg.logger.warn('api-matic: reversión no aplicada', { rollback: p.transaction_id, item: item.transaction_id, ref, code });
      }
    }
    return this.accept(wallet, s, last ?? (await wallet.balance(s)), p.transaction_id);
  }

  /** 200 + saldo como número JSON exacto (texto decimal, nunca float) + nuestro id de operación. */
  private accept(wallet: HubWalletFacade, s: HubSession, res: WalletOkResponse, providerTx?: string): CallbackResponse {
    const balance = minorToDecimal(res.balance, wallet.decimals(s.currency));
    const tx = res.transactionId ?? providerTx;
    return { status: 200, body: `{"balance":${balance}${tx ? `,"transaction_id":${JSON.stringify(tx)}` : ''}}` };
  }

  private fail(e: unknown, p: Postback): CallbackResponse {
    if (e instanceof DecimalAmountError) return reject('BAD_REQUEST', 400);
    switch (errorCode(e)) {
      case 'INSUFFICIENT_FUNDS':
        return reject('INSUFFICIENT_FUNDS');
      case 'BET_REJECTED':
        return reject('PLAYER_BLOCKED');
      case 'BET_ROLLED_BACK':
        return reject('BET_ALREADY_REFUNDED');
      case 'UNKNOWN_SESSION':
      case 'SESSION_EXPIRED':
      case 'SESSION_MISMATCH':
        return reject('UNKNOWN_SESSION');
      case 'CURRENCY_MISMATCH':
        return reject('CURRENCY_MISMATCH');
      case 'GAME_NOT_FOUND':
      case 'GAME_UNAVAILABLE':
        return reject('GAME_UNAVAILABLE');
      case 'DUPLICATE':
        this.cfg.logger.error('api-matic: transaction_id reutilizado con otro contenido', { action: p.action, transaction_id: p.transaction_id });
        return reject('DUPLICATE_TRANSACTION');
      default:
        this.cfg.logger.error('api-matic: fallo procesando postback', { action: p.action, error: e instanceof Error ? e.message : String(e) });
        return reject('TEMPORARILY_UNAVAILABLE', 503);
    }
  }
}

/** "ARS:ARS_PA,COP:COP" → { ARS: 'ARS_PA', COP: 'COP' }. */
export function parseCurrencyMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{3,10}):([A-Za-z0-9_]{2,16})$/.exec(part);
    if (!m) throw new Error(`HUB_APIMATIC_CURRENCY_MAP inválido: "${part}" (formato MONEDA:CODIGO)`);
    out[m[1].toUpperCase()] = m[2].toUpperCase();
  }
  return out;
}
