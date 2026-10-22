import type { Prisma, PrismaClient, Withdrawal, WithdrawalStatus } from '@prisma/client';
import type { BackofficeAuth, IAuditLogger, IWalletService } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import { publishSafe, type DomainEventSink, type ErrorLogger } from '../../infrastructure/modules/events/publishSafe';
import type { PaymentProviderRegistry } from '../../infrastructure/payments/PaymentProviderRegistry';

export interface ReviewWithdrawalDeps {
  prisma: PrismaClient;
  registry: PaymentProviderRegistry;
  wallet: IWalletService;
  audit: IAuditLogger;
  /** Bus de eventos de dominio: withdrawal.completed al pagar (después del commit del ledger). */
  events?: DomainEventSink;
  logger?: ErrorLogger;
}

export interface ReviewContext {
  ip?: string | null;
}

const FINANCE_ROLES = ['PLATFORM_ADMIN', 'OPERATOR_FINANCE'];
const REVIEW_ROLES = ['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_FINANCE'];

/** Acciones de backoffice sobre retiros + resultados asíncronos del PSP. */
export class ReviewWithdrawalUseCase {
  constructor(private readonly deps: ReviewWithdrawalDeps) {}

  async list(
    actor: BackofficeAuth,
    opts: { status?: WithdrawalStatus; cursor?: string; limit?: number; operatorId?: string },
  ): Promise<{ items: Withdrawal[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const operatorId = actor.operatorId ?? opts.operatorId;
    const rows = await this.deps.prisma.withdrawal.findMany({
      where: { ...(operatorId ? { operatorId } : {}), ...(opts.status ? { status: opts.status } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
  }

  async approve(actor: BackofficeAuth, id: string, ctx: ReviewContext = {}): Promise<Withdrawal> {
    const w = await this.load(actor, id, REVIEW_ROLES);
    const moved = await this.deps.prisma.withdrawal.updateMany({
      where: { id, status: 'REQUESTED' },
      data: { status: 'APPROVED', reviewedByBackofficeUserId: actor.backofficeUserId, reviewedAt: new Date() },
    });
    if (moved.count === 0) throw AppError.conflict('El retiro no está en estado solicitado');
    await this.audit(actor, 'withdrawal.approved', w, { status: 'REQUESTED' }, { status: 'APPROVED' }, null, ctx);

    const provider = this.deps.registry.getEnabled(w.provider);
    if (provider) {
      try {
        const res = await provider.requestPayout({
          operatorId: w.operatorId,
          withdrawalId: w.id,
          amount: w.amount,
          currency: w.currency,
          destination: (w.destination ?? {}) as Record<string, unknown>,
        });
        if (res.status === 'FAILED') {
          await this.fail(w.id, null, ctx);
        } else if (res.status === 'PAID') {
          await this.settle(w.id, null, ctx, ['APPROVED']);
        } else {
          await this.deps.prisma.withdrawal.updateMany({
            where: { id, status: 'APPROVED' },
            data: { status: 'PROCESSING', externalId: res.externalId },
          });
          await this.audit(actor, 'withdrawal.payout_requested', w, { status: 'APPROVED' }, { status: 'PROCESSING', externalId: res.externalId }, null, ctx);
        }
      } catch (err) {
        // Queda APPROVED: finanzas puede reintentar o marcar pagado manualmente.
        await this.audit(
          actor,
          'withdrawal.payout_failed_to_start',
          w,
          { status: 'APPROVED' },
          { status: 'APPROVED', error: err instanceof Error ? err.message : String(err) },
          null,
          ctx,
        );
      }
    }
    return this.reload(id);
  }

  async reject(actor: BackofficeAuth, id: string, reason: string, ctx: ReviewContext = {}): Promise<Withdrawal> {
    if (!reason || !reason.trim()) throw AppError.validation('Debes indicar el motivo del rechazo');
    const w = await this.load(actor, id, REVIEW_ROLES);
    const prev = await this.transition(id, ['REQUESTED', 'APPROVED'], {
      status: 'REJECTED',
      rejectionReason: reason.trim(),
      reviewedByBackofficeUserId: actor.backofficeUserId,
      reviewedAt: new Date(),
    });
    if (!prev) throw AppError.conflict('El retiro no se puede rechazar en su estado actual');
    await this.releaseOrRevert(w, prev, 'rejection');
    await this.audit(actor, 'withdrawal.rejected', w, { status: prev }, { status: 'REJECTED' }, reason.trim(), ctx);
    return this.reload(id);
  }

  /** Pago realizado fuera de la plataforma. Solo finanzas / admin de plataforma. */
  async markPaid(actor: BackofficeAuth, id: string, ctx: ReviewContext = {}): Promise<Withdrawal> {
    const w = await this.load(actor, id, FINANCE_ROLES);
    const prev = await this.settle(id, actor, ctx, ['APPROVED', 'PROCESSING']);
    if (!prev) throw AppError.conflict('El retiro debe estar aprobado o en proceso para marcarlo como pagado');
    return this.reload(w.id);
  }

  /** Resultado asíncrono del PSP (webhook o consulta de estado). */
  async applyProviderResult(withdrawalId: string, status: 'PAID' | 'FAILED', ctx: ReviewContext = {}): Promise<string> {
    if (status === 'PAID') {
      const prev = await this.settle(withdrawalId, null, ctx, ['APPROVED', 'PROCESSING']);
      return prev ? 'withdrawal_paid' : 'withdrawal_already_final';
    }
    const prev = await this.fail(withdrawalId, null, ctx);
    return prev ? 'withdrawal_failed' : 'withdrawal_already_final';
  }

  // ---------- internos ----------

  private async settle(
    id: string,
    actor: BackofficeAuth | null,
    ctx: ReviewContext,
    from: WithdrawalStatus[],
  ): Promise<WithdrawalStatus | null> {
    const w = await this.reload(id);
    const prev = await this.transition(id, from, { status: 'PAID' });
    if (!prev) return null;
    try {
      const res = await this.deps.wallet.completeWithdrawal(this.ledgerInput(w, 'wd-payout'));
      await this.deps.prisma.withdrawal.update({ where: { id }, data: { settleLedgerTxId: res.ledgerTransactionId } });
    } catch (err) {
      await this.deps.prisma.withdrawal.updateMany({ where: { id, status: 'PAID' }, data: { status: prev } });
      throw err;
    }
    await this.audit(actor, 'withdrawal.paid', w, { status: prev }, { status: 'PAID' }, null, ctx);
    await publishSafe(
      this.deps.events,
      'withdrawal.completed',
      { operatorId: w.operatorId, playerId: w.userId, at: new Date().toISOString(), amount: w.amount, currency: w.currency, txId: w.id },
      this.deps.logger,
    );
    return prev;
  }

  private async fail(id: string, actor: BackofficeAuth | null, ctx: ReviewContext): Promise<WithdrawalStatus | null> {
    const w = await this.reload(id);
    const prev = await this.transition(id, ['APPROVED', 'PROCESSING'], { status: 'FAILED' });
    if (!prev) return null;
    await this.releaseOrRevert(w, prev, 'payout failure');
    await this.audit(actor, 'withdrawal.failed', w, { status: prev }, { status: 'FAILED' }, null, ctx);
    return prev;
  }

  /** Libera la reserva; si el ledger falla revierte el estado para poder reintentar. */
  private async releaseOrRevert(w: Withdrawal, prev: WithdrawalStatus, _why: string): Promise<void> {
    try {
      await this.deps.wallet.releaseWithdrawal(this.ledgerInput(w, 'wd-release'));
    } catch (err) {
      await this.deps.prisma.withdrawal.updateMany({
        where: { id: w.id, status: { in: ['REJECTED', 'FAILED'] } },
        data: { status: prev },
      });
      throw err;
    }
  }

  /** Update condicional por estado. Devuelve el estado previo o null si no estaba en `from`. */
  private async transition(
    id: string,
    from: WithdrawalStatus[],
    data: Prisma.WithdrawalUpdateManyMutationInput,
  ): Promise<WithdrawalStatus | null> {
    const { prisma } = this.deps;
    // Se prueba estado por estado para conocer el previo de forma atómica.
    for (const s of from) {
      const r = await prisma.withdrawal.updateMany({ where: { id, status: s }, data });
      if (r.count === 1) return s;
    }
    return null;
  }

  private ledgerInput(w: Withdrawal, prefix: 'wd-reserve' | 'wd-release' | 'wd-payout') {
    return {
      operatorId: w.operatorId,
      userId: w.userId,
      currency: w.currency,
      amount: w.amount,
      withdrawalId: w.id,
      idempotencyKey: `${prefix}:${w.id}`,
    };
  }

  private async load(actor: BackofficeAuth, id: string, roles: string[]): Promise<Withdrawal> {
    if (!roles.includes(actor.role)) throw AppError.forbidden('Tu rol no puede realizar esta acción');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw AppError.notFound('Retiro no encontrado');
    const w = await this.deps.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw AppError.notFound('Retiro no encontrado');
    if (actor.operatorId !== null && actor.operatorId !== w.operatorId) throw AppError.forbidden();
    return w;
  }

  private async reload(id: string): Promise<Withdrawal> {
    const w = await this.deps.prisma.withdrawal.findUnique({ where: { id } });
    if (!w) throw AppError.notFound('Retiro no encontrado');
    return w;
  }

  private audit(
    actor: BackofficeAuth | null,
    action: string,
    w: Withdrawal,
    before: unknown,
    after: unknown,
    reason: string | null,
    ctx: ReviewContext,
  ): Promise<void> {
    return this.deps.audit.log({
      operatorId: w.operatorId,
      actorType: actor ? 'BACKOFFICE_USER' : 'SYSTEM',
      actorId: actor?.backofficeUserId ?? null,
      action,
      targetType: 'Withdrawal',
      targetId: w.id,
      reason,
      before,
      after,
      ip: ctx.ip ?? null,
    });
  }
}
