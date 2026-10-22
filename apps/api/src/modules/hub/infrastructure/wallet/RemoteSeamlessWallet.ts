import { signHmacSha256 } from '../../../shared/crypto/hmac';
import { HttpError } from '../../../shared/http/errors';
import { bigintReplacer, parseAmount } from '../../../shared/money';
import {
  CreditRequest,
  DebitRequest,
  RollbackRequest,
  WalletBalance,
  WalletError,
  WalletErrorCode,
  WalletPort,
  WalletResult,
} from '../../../shared/ports/WalletPort';
import type { RemoteOperator } from '../../domain/types';
import { STUDIO_PROVIDER_ID } from '../adapters/NymfoStudiosAdapter';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface RemoteWalletOptions {
  /** Token de sesión que se reenvía al casino remoto (le permite validar la sesión del jugador). */
  sessionToken?: string;
  fetch?: FetchLike;
  /** Reintentos ante red caída, timeout o 5xx (por defecto 3). */
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  /** Id con el que nos presentamos (cabecera X-Provider-Id). */
  providerId?: string;
}

/** Códigos del protocolo estándar → códigos de WalletPort. */
const REMOTE_TO_WALLET: Record<string, WalletErrorCode> = {
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  DUPLICATE: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  UNKNOWN_TRANSACTION: 'UNKNOWN_TRANSACTION',
  ALREADY_ROLLED_BACK: 'ALREADY_ROLLED_BACK',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
};

class RetryableError extends Error {}

/**
 * WalletPort que cobra/paga en la billetera de un casino remoto (lado saliente: Nymfo como proveedor).
 * Habla el mismo protocolo seamless estándar de Nymfo: POST {walletCallbackUrl}/balance|bet|win|rollback,
 * firmado con HMAC-SHA256 del cuerpo (X-Signature) usando HUB_REMOTE_<ID>_SECRET.
 *
 * - La idempotencyKey viaja como transactionId: los reintentos son seguros en ambos lados.
 * - Reintenta ante red caída/timeout/5xx con backoff lineal; los 4xx se traducen a WalletError.
 * - Si una apuesta no se confirma tras los reintentos, envía un rollback (best effort) y falla con REMOTE_WALLET_ERROR.
 * - Cachea los resultados exitosos por idempotencyKey (no repite llamadas ya confirmadas).
 */
export class RemoteSeamlessWallet implements WalletPort {
  private readonly fetchImpl: FetchLike;
  private readonly done = new Map<string, { fp: string; result: WalletResult }>();

  constructor(
    private readonly remote: RemoteOperator,
    private readonly secret: string,
    private readonly opts: RemoteWalletOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async getBalance(_operatorId: string, playerId: string, currency: string): Promise<WalletBalance> {
    const r = await this.call('balance', { sessionToken: this.opts.sessionToken, playerId, currency });
    const balance = parseAmount(r.balance ?? '0', { allowZero: true });
    const cash = r.cash !== undefined ? parseAmount(r.cash, { allowZero: true }) : balance;
    const bonus = r.bonus !== undefined ? parseAmount(r.bonus, { allowZero: true }) : balance - cash;
    return { cash, bonus };
  }

  async debit(req: DebitRequest): Promise<WalletResult> {
    return this.movement('bet', req, async () => {
      // La apuesta pudo quedar aplicada en el remoto: se intenta anular para no dejar dinero en el limbo.
      try {
        await this.call('rollback', {
          sessionToken: this.opts.sessionToken,
          playerId: req.playerId,
          transactionId: `${req.idempotencyKey}:rb`,
          referenceTransactionId: req.idempotencyKey,
          roundId: req.ref.roundId,
        });
      } catch {
        /* best effort: el remoto reconciliará por transactionId */
      }
    });
  }

  async credit(req: CreditRequest): Promise<WalletResult> {
    return this.movement('win', req);
  }

  async rollback(req: RollbackRequest): Promise<WalletResult> {
    const fp = JSON.stringify(['rollback', req.playerId, req.originalIdempotencyKey]);
    const cached = this.cached(req.idempotencyKey, fp);
    if (cached) return cached;
    const r = await this.call('rollback', {
      sessionToken: this.opts.sessionToken,
      playerId: req.playerId,
      transactionId: req.idempotencyKey,
      referenceTransactionId: req.originalIdempotencyKey,
    });
    return this.remember(req.idempotencyKey, fp, r);
  }

  private async movement(
    action: 'bet' | 'win',
    req: DebitRequest | CreditRequest,
    onUncertain?: () => Promise<void>,
  ): Promise<WalletResult> {
    if (typeof req.amount !== 'bigint' || req.amount <= 0n) throw new WalletError('INVALID_AMOUNT');
    const fp = JSON.stringify([action, req.playerId, req.currency, req.amount.toString(), req.reason, req.ref]);
    const cached = this.cached(req.idempotencyKey, fp);
    if (cached) return cached;
    try {
      const r = await this.call(action, {
        sessionToken: this.opts.sessionToken,
        playerId: req.playerId,
        currency: req.currency,
        transactionId: req.idempotencyKey,
        roundId: req.ref.roundId ?? req.idempotencyKey,
        gameId: req.ref.gameId,
        amount: req.amount,
        reason: req.reason,
      });
      return this.remember(req.idempotencyKey, fp, r);
    } catch (e) {
      if (e instanceof HttpError && e.code === 'REMOTE_WALLET_ERROR' && onUncertain) await onUncertain();
      throw e;
    }
  }

  private cached(key: string, fp: string): WalletResult | undefined {
    const c = this.done.get(key);
    if (!c) return undefined;
    if (c.fp !== fp) throw new WalletError('IDEMPOTENCY_CONFLICT', 'idempotencyKey reutilizada con otro payload');
    return c.result;
  }

  private remember(key: string, fp: string, r: Record<string, unknown>): WalletResult {
    const result: WalletResult = {
      balance: parseAmount(r.balance ?? '0', { allowZero: true }),
      txId: typeof r.transactionId === 'string' && r.transactionId ? r.transactionId : key,
    };
    this.done.set(key, { fp, result });
    return result;
  }

  /** POST firmado con reintentos. Devuelve el cuerpo JSON de éxito o lanza WalletError/HttpError. */
  private async call(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload, bigintReplacer);
    const headers = {
      'Content-Type': 'application/json',
      'X-Provider-Id': this.opts.providerId ?? STUDIO_PROVIDER_ID,
      'X-Operator-Id': this.remote.id,
      'X-Signature': signHmacSha256(this.secret, body),
    };
    const url = `${this.remote.walletCallbackUrl.replace(/\/+$/, '')}/${action}`;
    const attempts = 1 + Math.max(0, this.opts.retries ?? 3);
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const backoffMs = this.opts.backoffMs ?? 200;
    let lastError = 'sin respuesta';

    for (let i = 0; i < attempts; i++) {
      if (i > 0 && backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs * i));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: ctrl.signal });
        const text = await res.text();
        let json: Record<string, unknown> = {};
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          json = {};
        }
        if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
        if (res.status >= 400 || json.status === 'ERROR') {
          const err = (json.error ?? {}) as { code?: string; message?: string };
          const mapped = err.code ? REMOTE_TO_WALLET[err.code] : undefined;
          if (mapped) throw new WalletError(mapped, err.message);
          throw new HttpError(502, 'REMOTE_WALLET_ERROR', `Billetera remota rechazó ${action}: ${err.code ?? res.status}`);
        }
        return json;
      } catch (e) {
        if (e instanceof WalletError || e instanceof HttpError) throw e;
        lastError = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HttpError(502, 'REMOTE_WALLET_ERROR', `Billetera remota no disponible (${action}): ${lastError}`);
  }
}
