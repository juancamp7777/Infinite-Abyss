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
import { currencyDecimals } from '../../domain/money';
import { safeEqualHex, sha256Hex, wompiIntegritySignature } from '../../domain/payments/signature';
import { FetchLike, defaultFetch, headerValue, parseJsonObject, str } from './types';

export interface WompiConfig {
  publicKey?: string;
  privateKey?: string;
  eventsSecret?: string;
  integritySecret?: string;
  baseUrl: string;
  /** URL del checkout web (por defecto el de Wompi). */
  checkoutUrl?: string;
  /** Adónde vuelve el jugador tras pagar. */
  redirectUrl?: string;
}

const DEFAULT_CHECKOUT = 'https://checkout.wompi.co/p/';

/**
 * Adaptador de Wompi: checkout web con firma de integridad y webhook de eventos.
 * Habilitado solo con WOMPI_PUBLIC_KEY, WOMPI_INTEGRITY_SECRET y WOMPI_EVENTS_SECRET.
 * Los payouts de Wompi son un producto aparte: no soportados en esta fase.
 */
export class WompiProvider implements PaymentProvider {
  readonly code = 'WOMPI' as const;

  constructor(
    private readonly config: WompiConfig,
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.config.publicKey && this.config.integritySecret && this.config.eventsSecret);
  }

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const { publicKey, integritySecret } = this.config;
    if (!this.isEnabled() || !publicKey || !integritySecret) {
      throw new AppError('Wompi is not configured', 503, true, 'PROVIDER_DISABLED');
    }
    // Wompi usa "centavos" (2 decimales). Solo monedas de 2 decimales (COP).
    if (currencyDecimals(input.currency) !== 2) {
      throw AppError.validation(`Wompi does not support ${input.currency}`);
    }
    const amountInCents = input.amount.toString();
    const params = new URLSearchParams({
      'public-key': publicKey,
      currency: input.currency,
      'amount-in-cents': amountInCents,
      reference: input.providerReference,
      'signature:integrity': wompiIntegritySignature(
        input.providerReference,
        amountInCents,
        input.currency,
        integritySecret,
      ),
    });
    const redirect = input.returnUrl ?? this.config.redirectUrl;
    if (redirect) params.set('redirect-url', redirect);
    if (input.customerEmail) params.set('customer-data:email', input.customerEmail);
    return {
      providerReference: input.providerReference,
      redirectUrl: `${this.config.checkoutUrl ?? DEFAULT_CHECKOUT}?${params.toString()}`,
      raw: { amountInCents, currency: input.currency },
    };
  }

  /**
   * checksum = SHA-256( valores de signature.properties (en orden, resueltos sobre `data`)
   *                     + timestamp + events secret ), comparado con signature.checksum
   * o la cabecera X-Event-Checksum.
   */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult {
    const invalid: WebhookVerificationResult = { valid: false, dedupeKey: null };
    const secret = this.config.eventsSecret;
    if (!this.isEnabled() || !secret) return invalid;
    const body = parseJsonObject(input.rawBody);
    if (!body) return invalid;

    const sig = body.signature as { properties?: unknown; checksum?: unknown } | undefined;
    const properties = Array.isArray(sig?.properties) ? (sig.properties as unknown[]) : null;
    const provided = headerValue(input.headers, 'x-event-checksum') ?? str(sig?.checksum);
    const timestamp = str(body.timestamp);
    if (!properties || !provided || !timestamp || !body.data) return invalid;

    let concat = '';
    for (const p of properties) {
      if (typeof p !== 'string') return invalid;
      const v = resolvePath(body.data, p);
      if (v === undefined || v === null) return invalid;
      concat += String(v);
    }
    const expected = sha256Hex(`${concat}${timestamp}${secret}`);
    if (!safeEqualHex(expected, provided)) return invalid;

    const event = parseEvent(body);
    const tx = (body.data as { transaction?: { id?: unknown; status?: unknown } }).transaction;
    const dedupeKey =
      event && tx ? `${str(tx.id)}:${str(tx.status)}` : `ignored:${sha256Hex(input.rawBody)}`;
    return { valid: true, dedupeKey, event };
  }

  async requestPayout(_input: RequestPayoutInput): Promise<RequestPayoutResult> {
    throw new AppError('Wompi payouts are not supported', 501, true, 'PAYOUT_UNSUPPORTED');
  }

  async getStatus(ref: { providerReference?: string; externalId?: string }): Promise<ProviderStatusResult> {
    const key = this.config.privateKey ?? this.config.publicKey;
    if (!this.isEnabled() || !key) throw new AppError('Wompi is not configured', 503, true, 'PROVIDER_DISABLED');
    const url = ref.externalId
      ? `${this.config.baseUrl}/transactions/${encodeURIComponent(ref.externalId)}`
      : ref.providerReference
        ? `${this.config.baseUrl}/transactions?reference=${encodeURIComponent(ref.providerReference)}`
        : null;
    if (!url) throw AppError.validation('providerReference or externalId required');
    let res;
    try {
      res = await this.fetchFn(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
    } catch {
      throw new AppError('Payment provider unreachable', 502, true, 'PROVIDER_ERROR');
    }
    const parsed = parseJsonObject(await res.text());
    if (!res.ok || !parsed) throw new AppError('Payment provider error', 502, true, 'PROVIDER_ERROR');
    const data = parsed.data;
    const tx = (Array.isArray(data) ? data[0] : data) as { id?: unknown; status?: unknown } | undefined;
    if (!tx) return { status: 'PENDING', raw: parsed };
    return { status: mapStatus(tx.status), externalId: str(tx.id), raw: parsed };
  }
}

function resolvePath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function mapStatus(s: unknown): ProviderEventStatus {
  switch (String(s ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'CONFIRMED';
    case 'DECLINED':
    case 'ERROR':
    case 'VOIDED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function parseEvent(body: Record<string, unknown>): ProviderEvent | undefined {
  if (body.event !== 'transaction.updated') return undefined;
  const tx = (body.data as { transaction?: Record<string, unknown> } | undefined)?.transaction;
  const id = str(tx?.id);
  const reference = str(tx?.reference);
  if (!tx || !id || !reference) return undefined;
  const cents = str(tx.amount_in_cents);
  return {
    kind: 'DEPOSIT',
    providerReference: reference,
    externalId: id,
    status: mapStatus(tx.status),
    amount: cents && /^[0-9]+$/.test(cents) ? BigInt(cents) : undefined,
    currency: str(tx.currency),
  };
}
