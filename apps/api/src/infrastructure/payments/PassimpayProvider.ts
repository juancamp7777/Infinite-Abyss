import type {
  CreateDepositInput,
  CreateDepositResult,
  PaymentProvider,
  ProviderEvent,
  ProviderEventStatus,
  ProviderStatusResult,
  RequestPayoutInput,
  RequestPayoutResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
} from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import { formatMinor } from '../../domain/money';
import { jsonEscapeSlash, passimpaySignature, safeEqualHex, sha256Hex } from '../../domain/payments/signature';
import { FetchLike, defaultFetch, headerValue, parseJsonObject, str } from './types';

export interface PassimpayConfig {
  platformId?: string;
  apiKey?: string;
  baseUrl: string;
  webhookIpAllowlist: string[];
}

/**
 * Adaptador de Passimpay (https://passimpay.gitbook.io/passimpay-api).
 *
 * Decisiones (ver también docs/architecture.md):
 *  - Firma: HMAC-SHA256 hex, clave = API key, sobre `${platformId};${body};${apiKey}`, cabecera `x-signature`.
 *    Las peticiones salientes se serializan UNA vez con '/' escapado como '\/' (como el ejemplo
 *    de la doc) y esa misma cadena es la que se firma y se envía.
 *  - Callbacks entrantes: no sabemos con certeza cómo serializó Passimpay el cuerpo, así que se
 *    recalcula la firma sobre (a) el body crudo recibido, (b) JSON.stringify(parseado) y (c) esa
 *    serialización con '/' escapado. Es válida si alguna coincide (comparación en tiempo constante).
 *    Esto no debilita la seguridad: todas requieren conocer la API key.
 *  - Depósito: Invoice Link en moneda fiat; orderId = Deposit.providerReference. Se acredita el monto
 *    del Deposit, jamás el monto en cripto del webhook, y solo tras confirmar con check-invoice.
 *  - BTC/LTC/DOGE/BCH/DASH pueden enviar 2 webhooks (1 y 2 confirmaciones): la dedupeKey no incluye
 *    las confirmaciones, por lo que el segundo es un duplicado.
 *  - Payouts: /v2/withdraw exige monto en cripto (`destination.cryptoAmount`, `destination.address`,
 *    `destination.currencyId`); la conversión fiat→cripto queda para una fase posterior.
 */
export class PassimpayProvider implements PaymentProvider {
  readonly code = 'PASSIMPAY' as const;

  constructor(
    private readonly config: PassimpayConfig,
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.platformId && this.config.apiKey);
  }

  private creds(): { platformId: string; apiKey: string } {
    if (!this.config.platformId || !this.config.apiKey) {
      throw new AppError('Passimpay is not configured', 503, true, 'PROVIDER_DISABLED');
    }
    return { platformId: this.config.platformId, apiKey: this.config.apiKey };
  }

  /** POST firmado. Devuelve el JSON de respuesta; lanza AppError 502 si el PSP falla. */
  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { platformId, apiKey } = this.creds();
    const body = jsonEscapeSlash(JSON.stringify({ platformId, ...payload }));
    const signature = passimpaySignature(platformId, body, apiKey);
    let res;
    try {
      res = await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body,
      });
    } catch {
      throw new AppError('Payment provider unreachable', 502, true, 'PROVIDER_ERROR');
    }
    const parsed = parseJsonObject(await res.text());
    if (!res.ok || !parsed) {
      throw new AppError('Payment provider error', 502, true, 'PROVIDER_ERROR');
    }
    if (parsed.result !== undefined && Number(parsed.result) !== 1) {
      throw new AppError('Payment provider rejected the request', 502, true, 'PROVIDER_ERROR', {
        message: str(parsed.message) ?? str(parsed.error),
      });
    }
    return parsed;
  }

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const res = await this.post('/v2/createorder', {
      orderId: input.providerReference,
      amount: formatMinor(input.amount, input.currency),
      symbol: input.currency,
    });
    const url = str(res.url);
    if (!url) throw new AppError('Payment provider returned no invoice link', 502, true, 'PROVIDER_ERROR');
    return { providerReference: input.providerReference, redirectUrl: url, raw: res };
  }

  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
    const invalid: WebhookVerificationResult = { valid: false, dedupeKey: null };
    if (!this.isEnabled()) return invalid;
    const { platformId, apiKey } = this.creds();

    const allow = this.config.webhookIpAllowlist;
    if (allow.length > 0 && !(input.sourceIp && allow.includes(normalizeIp(input.sourceIp)))) return invalid;

    const signature = headerValue(input.headers, 'x-signature');
    if (!signature) return invalid;
    const body = parseJsonObject(input.rawBody);
    if (!body) return invalid;

    const canonical = JSON.stringify(body);
    const candidates = [input.rawBody, canonical, jsonEscapeSlash(canonical)];
    let ok = false;
    for (const c of candidates) {
      // no cortocircuitar: tiempo independiente de cuál candidato coincide
      if (safeEqualHex(signature, passimpaySignature(platformId, c, apiKey))) ok = true;
    }
    if (!ok) return invalid;

    const bodyPlatform = str(body.platform_id) ?? str(body.platformId);
    if (bodyPlatform && bodyPlatform !== platformId) return invalid;

    const event = parseEvent(body);
    const dedupeKey = event
      ? `${event.kind === 'DEPOSIT' ? 'deposit' : 'withdraw'}:${event.providerReference ?? event.externalId}:${event.status}:${
          str(body.txhash) ?? str(body.txid) ?? ''
        }`
      : `ignored:${sha256Hex(input.rawBody)}`;
    return { valid: true, dedupeKey, event };
  }

  async requestPayout(input: RequestPayoutInput): Promise<RequestPayoutResult> {
    const d = input.destination;
    const address = str(d.address);
    const currencyId = str(d.currencyId) ?? str(d.paymentId);
    const cryptoAmount = str(d.cryptoAmount);
    if (!address || !currencyId || !cryptoAmount) {
      throw AppError.validation('Passimpay payout requires destination.address, currencyId and cryptoAmount');
    }
    const res = await this.post('/v2/withdraw', {
      orderId: input.withdrawalId,
      paymentId: currencyId,
      amount: cryptoAmount,
      addressTo: address,
    });
    return {
      externalId: str(res.order_id) ?? str(res.orderId) ?? str(res.txhash) ?? input.withdrawalId,
      status: 'PROCESSING',
      raw: res,
    };
  }

  async getStatus(ref: { providerReference?: string; externalId?: string }): Promise<ProviderStatusResult> {
    if (ref.providerReference) {
      const res = await this.post('/v2/orderstatus', { orderId: ref.providerReference });
      return { status: mapStatus(res.status), raw: res };
    }
    if (ref.externalId) {
      const res = await this.post('/v2/withdrawstatus', { orderId: ref.externalId });
      return { status: mapStatus(res.status), externalId: ref.externalId, raw: res };
    }
    throw AppError.validation('providerReference or externalId required');
  }
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function mapStatus(s: unknown): ProviderEventStatus {
  const v = String(s ?? '').toLowerCase();
  if (['paid', 'success', 'completed', 'complete', 'confirmed'].includes(v)) return 'CONFIRMED';
  if (['error', 'failed', 'fail', 'expired', 'canceled', 'cancelled', 'rejected'].includes(v)) return 'FAILED';
  return 'PENDING';
}

function parseEvent(body: Record<string, unknown>): ProviderEvent | undefined {
  const type = String(body.type ?? '').toLowerCase();
  const isWithdraw = type.includes('withdraw');
  const orderId = str(body.order_id) ?? str(body.orderId);
  if (!orderId) return undefined;
  return {
    kind: isWithdraw ? 'WITHDRAWAL' : 'DEPOSIT',
    providerReference: orderId,
    externalId: str(body.txhash) ?? str(body.txid) ?? orderId,
    status: mapStatus(body.status),
  };
}
