import type { Deposit, PrismaClient, WebhookEvent } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { IWalletService, PaymentProvider, ProviderEvent } from '../../domain/contracts';
import type { PaymentProviderRegistry } from '../../infrastructure/payments/PaymentProviderRegistry';
import { publishSafe, type DomainEventSink } from '../../infrastructure/modules/events/publishSafe';
import type { ReviewWithdrawalUseCase } from './ReviewWithdrawalUseCase';

export interface HandleWebhookDeps {
  prisma: PrismaClient;
  registry: PaymentProviderRegistry;
  wallet: IWalletService;
  withdrawals: ReviewWithdrawalUseCase;
  logger?: { error(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Bus de eventos de dominio: deposit.completed tras confirmar (después del commit). */
  events?: DomainEventSink;
}

export interface WebhookRequest {
  provider: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  sourceIp?: string;
}

export interface WebhookResponse {
  status: number;
  body: { result: string };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDITABLE: Array<Deposit['status']> = ['CREATED', 'PENDING', 'FAILED', 'EXPIRED'];

/**
 * Procesa webhooks de PSP. Garantías:
 *  1. El payload crudo SIEMPRE se guarda (también con firma inválida).
 *  2. Firma inválida → 401 sin procesar.
 *  3. Dedupe por (provider, dedupeKey): un reenvío responde 200 sin efecto.
 *  4. Antes de acreditar se confirma el estado con el PSP (servidor a servidor).
 *  5. Doble protección contra doble acreditación: WebhookEvent único + idempotencyKey `deposit:<id>` del ledger
 *     + transición condicional por estado.
 */
export class HandleWebhookUseCase {
  constructor(private readonly deps: HandleWebhookDeps) {}

  async execute(req: WebhookRequest): Promise<WebhookResponse> {
    const { prisma, registry } = this.deps;
    const provider = registry.getEnabled(req.provider);
    if (!provider) return { status: 503, body: { result: 'provider_disabled' } };

    let verification;
    try {
      verification = await provider.verifyWebhook({ rawBody: req.rawBody, headers: req.headers, sourceIp: req.sourceIp });
    } catch {
      verification = { valid: false, dedupeKey: null };
    }

    const base = {
      provider: provider.code,
      headers: sanitizeHeaders(req.headers) as Prisma.InputJsonValue,
      rawBody: req.rawBody,
      sourceIp: req.sourceIp ?? null,
    };

    if (!verification.valid) {
      await prisma.webhookEvent.create({
        data: { ...base, signatureValid: false, dedupeKey: null, result: 'invalid_signature', processedAt: new Date() },
      });
      return { status: 401, body: { result: 'invalid_signature' } };
    }

    const parsed = safeParse(req.rawBody);
    let record: WebhookEvent;
    try {
      record = await prisma.webhookEvent.create({
        data: { ...base, signatureValid: true, dedupeKey: verification.dedupeKey, parsed },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      const existing = await prisma.webhookEvent.findFirst({
        where: { provider: provider.code, dedupeKey: verification.dedupeKey },
      });
      if (existing && existing.processedAt) {
        // Duplicado: se conserva el payload (sin dedupeKey) y se responde 200 sin efecto.
        await prisma.webhookEvent.create({
          data: { ...base, signatureValid: true, dedupeKey: null, parsed, result: 'duplicate', processedAt: new Date() },
        });
        return { status: 200, body: { result: 'duplicate' } };
      }
      if (!existing) throw err;
      record = existing; // intento previo sin terminar: se reintenta (todo es idempotente)
    }

    try {
      const outcome = verification.event
        ? await this.process(provider, verification.event)
        : { status: 200, result: 'ignored' };
      if (outcome.status === 200) {
        await prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date(), result: outcome.result, error: null },
        });
      } else {
        await prisma.webhookEvent.update({ where: { id: record.id }, data: { result: outcome.result } });
      }
      return { status: outcome.status, body: { result: outcome.result } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.error('Webhook processing failed', { provider: provider.code, error: message });
      await prisma.webhookEvent.update({ where: { id: record.id }, data: { error: message.slice(0, 500) } });
      return { status: 500, body: { result: 'processing_error' } }; // el PSP reintentará
    }
  }

  private async process(provider: PaymentProvider, event: ProviderEvent): Promise<{ status: number; result: string }> {
    return event.kind === 'DEPOSIT' ? this.processDeposit(provider, event) : this.processWithdrawal(provider, event);
  }

  private async processDeposit(provider: PaymentProvider, event: ProviderEvent) {
    const { prisma, wallet } = this.deps;
    const deposit = await prisma.deposit.findFirst({
      where: {
        provider: provider.code,
        OR: [
          ...(event.providerReference ? [{ providerReference: event.providerReference }] : []),
          { externalId: event.externalId },
        ],
      },
    });
    if (!deposit) {
      this.deps.logger?.warn('Webhook for unknown deposit', { provider: provider.code, ref: event.providerReference });
      return { status: 200, result: 'unknown_reference' };
    }

    if (event.status === 'PENDING') {
      await prisma.deposit.updateMany({ where: { id: deposit.id, status: 'CREATED' }, data: { status: 'PENDING' } });
      return { status: 200, result: 'pending' };
    }
    if (event.status === 'FAILED') {
      await prisma.deposit.updateMany({
        where: { id: deposit.id, status: { in: ['CREATED', 'PENDING'] } },
        data: { status: 'FAILED' },
      });
      return { status: 200, result: 'deposit_failed' };
    }

    // CONFIRMED
    if (deposit.status === 'CONFIRMED') return { status: 200, result: 'already_confirmed' };
    if (event.amount !== undefined && (event.amount !== deposit.amount || (event.currency && event.currency !== deposit.currency))) {
      this.deps.logger?.error('Webhook amount mismatch', { depositId: deposit.id });
      return { status: 200, result: 'amount_mismatch' };
    }

    // Confirmación servidor a servidor: no se confía solo en el webhook.
    const remote = await provider.getStatus({ providerReference: deposit.providerReference, externalId: event.externalId });
    if (remote.status !== 'CONFIRMED') return { status: 409, result: 'psp_not_confirmed' };

    // Se acredita el monto del Deposit (no el reportado por el PSP). Idempotente por `deposit:<id>`.
    const credit = await wallet.creditDeposit({
      operatorId: deposit.operatorId,
      userId: deposit.userId,
      currency: deposit.currency,
      amount: deposit.amount,
      depositId: deposit.id,
      provider: provider.code,
      idempotencyKey: `deposit:${deposit.id}`,
    });
    const moved = await prisma.deposit.updateMany({
      where: { id: deposit.id, status: { in: CREDITABLE } },
      data: { status: 'CONFIRMED', ledgerTransactionId: credit.ledgerTransactionId, confirmedAt: new Date() },
    });
    if (moved.count === 1) {
      // externalId es único por proveedor: mejor esfuerzo.
      await prisma.deposit
        .updateMany({ where: { id: deposit.id, externalId: null }, data: { externalId: event.externalId } })
        .catch(() => undefined);
      await this.emitDepositCompleted(deposit, credit.ledgerTransactionId);
    }
    return { status: 200, result: moved.count === 1 ? 'deposit_confirmed' : 'already_confirmed' };
  }

  /** Solo la transición efectiva a CONFIRMED emite (una vez por depósito). isFirst = único depósito confirmado. */
  private async emitDepositCompleted(deposit: Deposit, txId: string): Promise<void> {
    const { prisma, events } = this.deps;
    if (!events) return;
    try {
      const confirmed = await prisma.deposit.count({ where: { userId: deposit.userId, status: 'CONFIRMED' } });
      await publishSafe(
        events,
        'deposit.completed',
        {
          operatorId: deposit.operatorId,
          playerId: deposit.userId,
          at: new Date().toISOString(),
          amount: deposit.amount,
          currency: deposit.currency,
          isFirst: confirmed <= 1,
          txId,
        },
        this.deps.logger,
      );
    } catch (e) {
      this.deps.logger?.error('deposit.completed emit failed', { depositId: deposit.id, error: String(e) });
    }
  }

  private async processWithdrawal(provider: PaymentProvider, event: ProviderEvent) {
    const { prisma, withdrawals } = this.deps;
    const ref = event.providerReference;
    const withdrawal = await prisma.withdrawal.findFirst({
      where: {
        provider: provider.code,
        OR: [...(ref && UUID_RE.test(ref) ? [{ id: ref }] : []), { externalId: event.externalId }],
      },
    });
    if (!withdrawal) return { status: 200, result: 'unknown_reference' };
    if (event.status === 'PENDING') return { status: 200, result: 'pending' };

    if (event.status === 'CONFIRMED') {
      const remote = await provider.getStatus({ externalId: withdrawal.externalId ?? event.externalId });
      if (remote.status !== 'CONFIRMED') return { status: 409, result: 'psp_not_confirmed' };
    }
    const result = await withdrawals.applyProviderResult(withdrawal.id, event.status === 'CONFIRMED' ? 'PAID' : 'FAILED');
    return { status: 200, result };
  }
}

function safeParse(raw: string): Prisma.InputJsonValue | undefined {
  try {
    return JSON.parse(raw) as Prisma.InputJsonValue;
  } catch {
    return undefined;
  }
}

/** Se guardan las cabeceras para auditoría; se omiten credenciales de transporte. */
function sanitizeHeaders(h: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key === 'cookie') continue;
    out[key] = v ?? null;
  }
  return out;
}
