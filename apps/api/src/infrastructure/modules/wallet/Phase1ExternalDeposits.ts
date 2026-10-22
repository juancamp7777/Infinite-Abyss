import { Prisma, type PrismaClient } from '@prisma/client';
import type { IResponsibleGamingPolicy } from '../../../domain/contracts';
import type { EventBus } from '../../../modules/shared/events/EventBus';
import type { ModuleLogger } from '../../../modules/shared/module';
import { ExternalDepositError, type ExternalDepositPort, type ExternalDepositRequest, type ExternalDepositResult } from '../../../modules/shared/ports/ExternalDepositPort';
import type { PrismaWalletService } from '../../ledger/PrismaWalletService';
import { publishSafe } from '../events/publishSafe';

/**
 * Depósitos de Pearl sobre el cajero de la Fase 1: Deposit (provider PEARL) + asiento DEPOSIT + deposit.completed.
 * - `providerReference` = referencia única → reintentos idempotentes.
 * - `externalId` = movimiento bancario; el índice único (provider, externalId) impide usar el mismo pago dos veces,
 *   y se fija ANTES de acreditar.
 * - Juego responsable (autoexclusión, límites) se valida antes de crear el depósito.
 */
export class Phase1ExternalDeposits implements ExternalDepositPort {
  constructor(
    private readonly deps: { prisma: PrismaClient; wallet: PrismaWalletService; rg: IResponsibleGamingPolicy; bus: EventBus; logger: ModuleLogger },
  ) {}

  async credit(req: ExternalDepositRequest): Promise<ExternalDepositResult> {
    const { prisma } = this.deps;
    const user = await prisma.user.findFirst({ where: { id: req.playerId, operatorId: req.operatorId }, select: { id: true, currency: true, isDemo: true } });
    if (!user) throw new ExternalDepositError('PLAYER_NOT_FOUND', 'Jugador no encontrado');
    if (user.isDemo) throw new ExternalDepositError('DEMO_ACCOUNT', 'Las cuentas demo no reciben depósitos');
    if (user.currency !== req.currency) throw new ExternalDepositError('CURRENCY_MISMATCH', `La cuenta opera en ${user.currency}`);

    let dep = await prisma.deposit.findUnique({ where: { providerReference: req.reference } });
    if (dep && (dep.userId !== req.playerId || dep.amount !== req.amount)) throw new Error('Referencia de depósito reutilizada con otros datos');
    if (dep?.status === 'CONFIRMED' && dep.ledgerTransactionId) return { depositId: dep.id, txId: dep.ledgerTransactionId, duplicate: true };

    if (!dep) {
      try {
        await this.deps.rg.assertCanDeposit({ kind: 'player', userId: user.id, operatorId: req.operatorId, currency: user.currency, isDemo: false }, req.amount);
      } catch (e) {
        throw new ExternalDepositError('RG_BLOCKED', (e as Error).message || 'Bloqueado por juego responsable');
      }
      try {
        dep = await prisma.deposit.create({
          data: { operatorId: req.operatorId, userId: user.id, provider: 'PEARL', status: 'PENDING', amount: req.amount, currency: req.currency, providerReference: req.reference, externalId: req.externalId ?? null },
        });
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
        // Carrera con la misma referencia → seguimos con la existente; con el mismo movimiento bancario → se rechaza.
        dep = await prisma.deposit.findUnique({ where: { providerReference: req.reference } });
        if (!dep) throw new Error('El movimiento bancario ya se usó en otro depósito');
      }
    }

    const credit = await this.deps.wallet.creditDeposit({
      operatorId: req.operatorId, userId: user.id, currency: req.currency, amount: req.amount, depositId: dep.id, provider: 'PEARL', idempotencyKey: `deposit:${dep.id}`,
    });
    const moved = await prisma.deposit.updateMany({
      where: { id: dep.id, status: { not: 'CONFIRMED' } },
      data: { status: 'CONFIRMED', ledgerTransactionId: credit.ledgerTransactionId, confirmedAt: new Date() },
    });
    if (moved.count === 1) {
      const confirmed = await prisma.deposit.count({ where: { userId: user.id, status: 'CONFIRMED' } });
      await publishSafe(this.deps.bus, 'deposit.completed', {
        operatorId: req.operatorId, playerId: user.id, at: new Date().toISOString(), amount: req.amount, currency: req.currency, isFirst: confirmed <= 1, txId: credit.ledgerTransactionId,
      }, this.deps.logger);
    }
    return { depositId: dep.id, txId: credit.ledgerTransactionId, duplicate: moved.count === 0 };
  }
}
