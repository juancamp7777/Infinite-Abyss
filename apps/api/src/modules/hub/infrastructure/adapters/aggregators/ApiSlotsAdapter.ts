import { timingSafeEqual } from 'crypto';
import type { BlockList } from 'net';
import { z } from 'zod';
import { HttpError } from '../../../../shared/http/errors';
import type { ModuleLogger } from '../../../../shared/module';
import { decimalToMinor, DecimalAmountError, minorToDecimal } from '../../../domain/decimalMoney';
import type { CallbackRequest, CallbackResponse, DemoContext, HubWalletFacade, LaunchContext, LaunchResult, ProviderAdapter, SignedRequest } from '../../../domain/ProviderAdapter';
import type { GameDTO, HubSession } from '../../../domain/types';
import type { WalletAction, WalletErrorResponse, WalletOkResponse, WinRequest } from '../../../domain/walletProtocol';
import { ipAllowed, parseAllowlist } from '../../net/ipAllowlist';
import { errorCode, providerError, readLimited, txKey, withRoundFallback } from './aggregatorSupport';

export const API_SLOTS_ID = 'api-slots';
const DEFAULT_API_URL = 'https://api-slots.network';
const DEFAULT_CDN = 'https://cdn.api-slots.network';

export type GameType = 'official' | 'clone' | 'unknown';

export interface ApiSlotsConfig {
  apiUrl?: string;
  partnerId: string;
  apiKey: string;
  cdnBase?: string;
  /** Inventario por provider_code: tipo de licencia de sus juegos (el agregador no lo informa). */
  gameType?: Record<string, 'official' | 'clone'>;
  /** Juegos "clone" en el catálogo (riesgo de licencia): por defecto NO. */
  allowClones?: boolean;
  /** Juegos de proveedores sin clasificar en el inventario: por defecto NO (solo oficiales confirmados). */
  includeUnknown?: boolean;
  allowlist?: BlockList | null;
  logger: ModuleLogger;
  fetchImpl?: typeof fetch;
  /** Esperas entre reintentos del catálogo (ms). */
  retryDelaysMs?: number[];
}

const zMoney = z.union([z.string(), z.number()]);
const zCallback = z.object({
  method: z.string().min(1).max(32),
  api_key: z.string().max(256).optional(),
  player_id: z.string().max(128).optional(),
  amount: zMoney.optional(),
  session_id: z.string().max(256).optional(),
  status: z.string().max(32).optional(),
  meta: z.object({
    transaction: z.string().max(256).optional(),
    symbol: z.string().max(128).optional(),
    round_id: z.string().max(256).optional(),
    session_id: z.string().max(256).optional(),
    ref_transaction: z.string().max(256).optional(),
    original_transaction: z.string().max(256).optional(),
    is_freespins: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();
type Callback = z.infer<typeof zCallback>;

const zCatalog = z.object({
  slots: z.array(z.object({
    symbol: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    status: z.boolean().optional(),
    imageurl: z.string().max(1024).optional().nullable(),
    provider_code: z.object({ provider_code: z.string().min(1).max(120), provider_name: z.string().max(200).optional() }),
  }).passthrough()),
}).passthrough();

const URL_KEYS = ['url', 'gameUrl', 'game_url', 'launch_url', 'link'] as const;

/** Respuesta en el formato de API-Slots: claves en orden alfabético y salto de línea final. */
function reply(status: number, body: Record<string, string>): CallbackResponse {
  const sorted = Object.fromEntries(Object.keys(body).sort().map((k) => [k, body[k]]));
  return { status, body: `${JSON.stringify(sorted)}\n` };
}
const error = (status: number, message: string) => reply(status, { message, status: 'error' });

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * API-Slots (agregador): catálogo /api/allgamelist, lanzamiento /api/playGame.do y callbacks seamless en un único
 * endpoint (/hub/v1/providers/api-slots/callback) con la acción en `method`.
 * Autenticación: api_key del cuerpo (tiempo constante) + allowlist de IP + la sesión debe ser del jugador.
 */
export class ApiSlotsAdapter implements ProviderAdapter {
  readonly id = API_SLOTS_ID;
  readonly enabled = true;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ApiSlotsConfig) {
    this.apiUrl = (cfg.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv, deps: { logger: ModuleLogger }): ApiSlotsAdapter | null {
    const partnerId = env.HUB_APISLOTS_PARTNER_ID?.trim();
    const apiKey = env.HUB_APISLOTS_API_KEY?.trim();
    if (!partnerId && !apiKey) return null;
    if (!partnerId || !apiKey) throw new Error('API-Slots: HUB_APISLOTS_PARTNER_ID y HUB_APISLOTS_API_KEY van juntas');
    return new ApiSlotsAdapter({
      partnerId,
      apiKey,
      apiUrl: env.HUB_APISLOTS_API_URL?.trim() || undefined,
      cdnBase: env.HUB_APISLOTS_CDN_BASE?.trim() || undefined,
      gameType: parseInventory(env.HUB_APISLOTS_GAME_TYPES),
      allowClones: env.HUB_ALLOW_CLONE_GAMES === '1',
      includeUnknown: env.HUB_APISLOTS_INCLUDE_UNKNOWN === '1',
      allowlist: parseAllowlist(env.HUB_APISLOTS_ALLOWED_IPS),
      ...deps,
    });
  }

  // ------------------------------------------------------------------ saliente

  async syncCatalog(): Promise<GameDTO[]> {
    const raw = await this.getWithRetry(`${this.apiUrl}/api/allgamelist`);
    const parsed = zCatalog.safeParse(raw);
    if (!parsed.success) throw providerError('API-Slots', 'catálogo con formato inesperado');
    const cdn = (this.cfg.cdnBase || DEFAULT_CDN).replace(/\/+$/, '');
    const out: GameDTO[] = [];
    const skipped: Record<GameType, number> = { official: 0, clone: 0, unknown: 0 };
    for (const g of parsed.data.slots) {
      if (g.status === false) continue;
      const code = g.provider_code.provider_code;
      const type: GameType = this.cfg.gameType?.[code] ?? 'unknown';
      if ((type === 'clone' && !this.cfg.allowClones) || (type === 'unknown' && !this.cfg.includeUnknown)) {
        skipped[type] += 1;
        continue;
      }
      const img = g.imageurl ? (/^https?:\/\//i.test(g.imageurl) ? g.imageurl : `${cdn}/${g.imageurl.replace(/^\/+/, '')}`) : undefined;
      out.push({
        externalId: `${code}:${g.symbol}`,
        title: g.name,
        category: 'slots',
        hasDemo: false,
        ...(img ? { images: { thumb: img, banner: img } } : {}),
        tags: ['aggregator:api-slots', `studio:${g.provider_code.provider_name || code}`, `license:${type}`],
      });
    }
    if (skipped.clone || skipped.unknown) {
      this.cfg.logger.warn('api-slots: juegos excluidos del catálogo por licencia', { clone: skipped.clone, unknown: skipped.unknown });
    }
    return out;
  }

  /** GET con 3 intentos (espera 200 ms y 400 ms) ante 408/429/5xx o error de red; otros status fallan al instante. */
  private async getWithRetry(url: string): Promise<unknown> {
    const delays = this.cfg.retryDelaysMs ?? [200, 400];
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      let res: Response;
      try {
        res = await this.fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      if (res.status === 200) {
        const text = await readLimited(res, 8 * 1024 * 1024).catch((e: Error) => { throw providerError('API-Slots', e.message); });
        try {
          return JSON.parse(text);
        } catch {
          throw providerError('API-Slots', 'catálogo no es JSON');
        }
      }
      lastError = `HTTP ${res.status}`;
      if (![408, 429, 500, 502, 503, 504].includes(res.status)) break;
    }
    throw providerError('API-Slots', lastError);
  }

  async launchGame(ctx: LaunchContext): Promise<LaunchResult> {
    const sep = ctx.game.externalId.indexOf(':');
    if (sep <= 0) throw new HttpError(400, 'GAME_UNAVAILABLE', 'API-Slots: externalId sin provider_code');
    const body = {
      symbol: ctx.game.externalId.slice(sep + 1),
      provider: ctx.game.externalId.slice(0, sep),
      currency: ctx.session.currency,
      partner: this.cfg.partnerId,
      api_key: this.cfg.apiKey,
      player_id: ctx.session.playerId,
      lang: ctx.language || 'en',
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}/api/playGame.do`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw providerError('API-Slots', e instanceof Error ? e.message : String(e), [this.cfg.apiKey]);
    }
    const text = await readLimited(res, 1024 * 1024).catch((e: Error) => { throw providerError('API-Slots', e.message); });
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text);
    } catch { /* se informa abajo */ }
    if (res.status !== 200) {
      const msg = typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : `HTTP ${res.status}`;
      throw providerError('API-Slots', msg, [this.cfg.apiKey]);
    }
    const meta = (j.meta && typeof j.meta === 'object' ? j.meta : {}) as Record<string, unknown>;
    const url = [...URL_KEYS.map((k) => j[k]), ...URL_KEYS.slice(0, 4).map((k) => meta[k])].find((v): v is string => typeof v === 'string' && /^https?:\/\//i.test(v));
    if (!url) throw providerError('API-Slots', 'lanzamiento sin URL de juego');
    return { url, ...(typeof meta.session_id === 'string' && meta.session_id ? { externalSessionId: meta.session_id } : {}) };
  }

  async launchDemo(_ctx: DemoContext): Promise<{ url: string }> {
    throw new HttpError(403, 'GAME_UNAVAILABLE', 'API-Slots: modo demo no habilitado');
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
    return { status: err.status, body: { status: 'error', message: err.code } };
  }
  allowsWinWithoutBet(_req: WinRequest): boolean {
    return true;
  }

  // ------------------------------------------------------------------ callbacks

  async handleCallback(req: CallbackRequest, wallet: HubWalletFacade): Promise<CallbackResponse> {
    const parsed = zCallback.safeParse(req.body);
    if (!parsed.success) return error(400, 'invalid request');
    const c = parsed.data;
    if (!c.api_key || !sameSecret(c.api_key, this.cfg.apiKey) || !ipAllowed(this.cfg.allowlist ?? null, req.ip)) return error(403, 'forbidden');
    if (!c.player_id) return error(400, 'invalid player_id');

    const sessionId = c.session_id || c.meta?.session_id;
    const session = sessionId ? await wallet.sessionByExternalId(sessionId) : null;
    // La sesión debe existir y ser de ese jugador (nunca se confía en player_id solo).
    if (!session || session.playerId !== c.player_id) return error(403, 'forbidden');

    try {
      switch (c.method) {
        case 'session_info':
        case 'game_switch':
          return this.ok(wallet, session, await wallet.balance(session));
        case 'bet':
          return await this.bet(wallet, session, c);
        case 'win':
          return await this.win(wallet, session, c);
        case 'rollback':
          return await this.rollback(wallet, session, c);
        case 'round_info':
          if (!['start', 'started', 'finish', 'finished'].includes(c.status ?? '')) return error(400, 'invalid status');
          return this.ok(wallet, session, await wallet.balance(session));
        default:
          return error(400, 'unknown method');
      }
    } catch (e) {
      if (e instanceof DecimalAmountError) return error(400, /decimales/.test(e.message) ? 'amount has more than two decimals' : 'invalid amount');
      this.cfg.logger.error('api-slots: fallo procesando callback', { method: c.method, error: e instanceof Error ? e.message : String(e) });
      return error(500, c.method === 'win' ? 'credit failed' : c.method === 'bet' ? 'debit failed' : 'balance unavailable');
    }
  }

  private amount(c: Callback, s: HubSession, wallet: HubWalletFacade): bigint {
    return decimalToMinor(c.amount ?? '0', wallet.decimals(s.currency));
  }

  private async bet(wallet: HubWalletFacade, s: HubSession, c: Callback): Promise<CallbackResponse> {
    const tx = c.meta?.transaction;
    if (!tx) return error(400, 'missing transaction id');
    const amount = this.amount(c, s, wallet);
    if (amount <= 0n) return error(400, 'invalid amount');
    try {
      const res = await withRoundFallback(c.meta?.round_id || `tx:${tx}`, tx, (roundId) =>
        wallet.bet(s, { transactionId: txKey('bet', tx), roundId, amount, ...(c.meta?.symbol ? { gameId: c.meta.symbol } : {}) }),
      );
      return this.ok(wallet, s, res);
    } catch (e) {
      const code = errorCode(e);
      const refusal = code === 'INSUFFICIENT_FUNDS' ? 'INSUFFICIENT_FUNDS' : code === 'BET_REJECTED' ? 'PLAYER_EXCLUDED' : code === 'BET_ROLLED_BACK' ? 'TRANSACTION_ROLLED_BACK' : null;
      if (!refusal) throw e;
      const bal = await wallet.balance(s);
      return reply(200, { balance: this.text(wallet, s, bal), currency: s.currency, message: refusal, status: 'error' });
    }
  }

  private async win(wallet: HubWalletFacade, s: HubSession, c: Callback): Promise<CallbackResponse> {
    const tx = c.meta?.transaction;
    if (!tx) return error(400, 'missing transaction id');
    const amount = this.amount(c, s, wallet);
    if (amount <= 0n) return error(400, 'invalid amount');
    try {
      const res = await withRoundFallback(c.meta?.round_id || `tx:${tx}`, tx, (roundId) =>
        wallet.win(s, { transactionId: txKey('win', tx), roundId, amount, roundClosed: true, ...(c.meta?.symbol ? { gameId: c.meta.symbol } : {}) }),
      );
      return this.ok(wallet, s, res);
    } catch (e) {
      if (errorCode(e) === 'BET_ROLLED_BACK') return this.ok(wallet, s, await wallet.balance(s));
      throw e;
    }
  }

  /** Anula una apuesta (meta.ref_transaction o meta.original_transaction). Desconocida → tombstone y OK. */
  private async rollback(wallet: HubWalletFacade, s: HubSession, c: Callback): Promise<CallbackResponse> {
    const tx = c.meta?.transaction;
    if (!tx) return error(400, 'missing transaction id');
    const ref = c.meta?.ref_transaction || c.meta?.original_transaction;
    if (!ref) {
      this.cfg.logger.warn('api-slots: rollback sin referencia', { fields: Object.keys(c.meta ?? {}) });
      return error(400, 'missing original transaction reference');
    }
    const res = await wallet.rollback(s, { transactionId: txKey('rollback', tx), referenceTransactionId: txKey('bet', ref), ...(c.meta?.round_id ? { roundId: c.meta.round_id } : {}) });
    return this.ok(wallet, s, res);
  }

  private text(wallet: HubWalletFacade, s: HubSession, res: WalletOkResponse): string {
    return minorToDecimal(res.balance, wallet.decimals(s.currency));
  }

  private ok(wallet: HubWalletFacade, s: HubSession, res: WalletOkResponse): CallbackResponse {
    return reply(200, { balance: this.text(wallet, s, res), currency: s.currency, status: 'ok' });
  }
}

/** HUB_APISLOTS_GAME_TYPES: "PragmaticPlay:official,Hacksaw:official,FooClone:clone". */
export function parseInventory(raw: string | undefined): Record<string, 'official' | 'clone'> {
  const out: Record<string, 'official' | 'clone'> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9_.-]{1,120}):(official|clone)$/.exec(part);
    if (!m) throw new Error(`HUB_APISLOTS_GAME_TYPES inválido: "${part}" (formato provider_code:official|clone)`);
    out[m[1]] = m[2] as 'official' | 'clone';
  }
  return out;
}
