import { createHmac } from 'node:crypto';
import type {
  CreateDepositInput,
  CreateDepositResult,
  PaymentProvider,
  ProviderEventStatus,
  ProviderStatusResult,
  RequestPayoutInput,
  RequestPayoutResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
} from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import { currencyDecimals } from '../../domain/money';
import { safeEqualHex, sha256Hex } from '../../domain/payments/signature';
import { FetchLike, defaultFetch, headerValue, parseJsonObject, str } from './types';

/** Llaves del Botón de pagos de Bold (Integraciones → Bold): la de identidad es pública, la secreta firma los webhooks. */
export interface BoldKeys {
  identityKey: string;
  secretKey: string;
}

export interface BoldDeps {
  /** Llaves del casino; null si no conectó Bold. */
  keys(operatorId: string): Promise<BoldKeys | null>;
  /** Depósito creado por nosotros con esa referencia (para saber de qué casino es y su link de pago). */
  deposit(providerReference: string): Promise<{ operatorId: string; externalId: string | null } | null>;
  /** Adónde vuelve el jugador tras pagar (https). */
  returnUrl?: string;
  baseUrl?: string;
}

const BASE = 'https://integrations.api.bold.co';

/**
 * Bold (Colombia): link de pago con PSE, Nequi, Botón Bancolombia y tarjetas.
 * - Depósito: POST /online/link/v1 (monto cerrado en COP) → el jugador paga en el checkout de Bold.
 * - Webhook: x-bold-signature = HMAC-SHA256 en hex, con la llave secreta, sobre el cuerpo en Base64.
 * - Antes de acreditar, la caja confirma el estado del link (GET /online/link/v1/{id} = PAID).
 * Las llaves son de cada casino (Integraciones), así que no hay que reiniciar nada al conectarlo.
 */
export class BoldProvider implements PaymentProvider {
  readonly code = 'BOLD' as const;

  constructor(
    private readonly deps: BoldDeps,
    private readonly fetchFn: FetchLike = defaultFetch,
  ) {}

  /** El adaptador existe; si un casino tiene llaves lo dice `isEnabledFor`. */
  isEnabled(): boolean {
    return true;
  }

  async isEnabledFor(operatorId: string): Promise<boolean> {
    return !!(await this.deps.keys(operatorId).catch(() => null))?.identityKey;
  }

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const keys = await this.deps.keys(input.operatorId);
    if (!keys?.identityKey) throw new AppError('Bold no está conectado', 503, true, 'PROVIDER_DISABLED');
    if (input.currency !== 'COP') throw AppError.validation('Bold solo recibe pagos en pesos colombianos (COP)');
    const unit = 10n ** BigInt(currencyDecimals(input.currency));
    if (input.amount % unit !== 0n) throw AppError.validation('Bold recibe montos en pesos enteros');
    const ret = input.returnUrl ?? this.deps.returnUrl;
    const body = {
      amount_type: 'CLOSE',
      amount: { currency: 'COP', total_amount: Number(input.amount / unit), tip_amount: 0, taxes: [] },
      reference: input.providerReference,
      description: 'Recarga de saldo',
      ...(ret && /^https:\/\//.test(ret) ? { callback_url: ret } : {}),
    };
    const parsed = await this.call(keys, 'POST', '/online/link/v1', JSON.stringify(body));
    const payload = parsed.payload as { payment_link?: unknown; url?: unknown } | undefined;
    const link = str(payload?.payment_link);
    const url = str(payload?.url);
    if (!link || !url || !/^https:\/\//.test(url)) throw new AppError('Bold no devolvió el link de pago', 502, true, 'PROVIDER_ERROR');
    return { providerReference: input.providerReference, externalId: link, redirectUrl: url, raw: { link } };
  }

  async verifyWebhook(input: WebhookVerificationInput): Promise<WebhookVerificationResult> {
    const invalid: WebhookVerificationResult = { valid: false, dedupeKey: null };
    const signature = headerValue(input.headers, 'x-bold-signature');
    const body = parseJsonObject(input.rawBody);
    if (!signature || !body) return invalid;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const reference = str((data.metadata as { reference?: unknown } | undefined)?.reference);
    // La llave sale del casino dueño del depósito (la referencia la generamos nosotros).
    const dep = reference ? await this.deps.deposit(reference) : null;
    const keys = dep ? await this.deps.keys(dep.operatorId).catch(() => null) : null;
    if (!keys?.secretKey) return invalid;
    const expected = createHmac('sha256', keys.secretKey).update(Buffer.from(input.rawBody, 'utf8').toString('base64')).digest('hex');
    if (!safeEqualHex(expected, signature)) return invalid;

    const type = str(body.type);
    const paymentId = str(data.payment_id);
    const status: ProviderEventStatus | null = type === 'SALE_APPROVED' ? 'CONFIRMED' : type === 'SALE_REJECTED' ? 'FAILED' : null;
    if (!status || !paymentId || !reference) return { valid: true, dedupeKey: `ignored:${sha256Hex(input.rawBody)}` };
    const amount = data.amount as { total?: unknown; currency?: unknown } | undefined;
    const total = typeof amount?.total === 'number' ? amount.total : Number(str(amount?.total));
    const currency = str(amount?.currency) ?? 'COP';
    return {
      valid: true,
      dedupeKey: `${paymentId}:${type}`,
      event: {
        kind: 'DEPOSIT',
        providerReference: reference,
        externalId: paymentId,
        status,
        ...(Number.isFinite(total) && Number.isInteger(total) ? { amount: BigInt(total) * 10n ** BigInt(currencyDecimals(currency)), currency } : {}),
      },
    };
  }

  async requestPayout(_input: RequestPayoutInput): Promise<RequestPayoutResult> {
    throw new AppError('Bold no hace pagos a jugadores desde la API', 501, true, 'PAYOUT_UNSUPPORTED');
  }

  /** Estado del link de pago del depósito: PAID = confirmado; rechazado, cancelado o vencido = fallido. */
  async getStatus(ref: { providerReference?: string; externalId?: string }): Promise<ProviderStatusResult> {
    const dep = ref.providerReference ? await this.deps.deposit(ref.providerReference) : null;
    const link = dep?.externalId && dep.externalId.startsWith('LNK_') ? dep.externalId : null;
    const keys = dep ? await this.deps.keys(dep.operatorId) : null;
    if (!dep || !link || !keys?.identityKey) throw new AppError('Depósito de Bold desconocido', 404, true, 'NOT_FOUND');
    const parsed = await this.call(keys, 'GET', `/online/link/v1/${encodeURIComponent(link)}`);
    const st = String(parsed.status ?? (parsed.payload as { status?: unknown } | undefined)?.status ?? '').toUpperCase();
    const status: ProviderEventStatus = st === 'PAID' ? 'CONFIRMED' : ['REJECTED', 'CANCELLED', 'EXPIRED'].includes(st) ? 'FAILED' : 'PENDING';
    return { status, externalId: link, raw: { status: st } };
  }

  private async call(keys: BoldKeys, method: 'GET' | 'POST', path: string, body?: string): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await this.fetchFn(`${this.deps.baseUrl ?? BASE}${path}`, {
        method,
        headers: { Authorization: `x-api-key ${keys.identityKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body } : {}),
      });
    } catch {
      throw new AppError('Bold no responde', 502, true, 'PROVIDER_ERROR');
    }
    const parsed = parseJsonObject(await res.text());
    if (!res.ok || !parsed) throw new AppError(`Bold respondió ${res.status}`, 502, true, 'PROVIDER_ERROR');
    return parsed;
  }
}
