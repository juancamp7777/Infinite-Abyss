import { randomUUID } from 'node:crypto';
import type { PaymentProviderCode, PrismaClient, Withdrawal } from '@prisma/client';
import type { IAuditLogger, IResponsibleGamingPolicy, IWalletService, PlayerAuth, TenantContext } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';

export interface RequestWithdrawalDeps {
  prisma: PrismaClient;
  wallet: IWalletService;
  responsibleGaming: IResponsibleGamingPolicy;
  audit: IAuditLogger;
}

export interface RequestWithdrawalInput {
  auth: PlayerAuth;
  tenant: TenantContext;
  provider: PaymentProviderCode;
  amount: bigint;
  currency: string;
  destination: Record<string, unknown>;
  ip?: string | null;
}

/** El jugador solicita un retiro: valida, reserva saldo CASH (nunca bono) y queda REQUESTED. */
export class RequestWithdrawalUseCase {
  constructor(private readonly deps: RequestWithdrawalDeps) {}

  async execute(input: RequestWithdrawalInput): Promise<Withdrawal> {
    const { prisma, wallet, responsibleGaming, audit } = this.deps;
    const { auth, tenant } = input;

    if (auth.operatorId !== tenant.operatorId) throw AppError.forbidden();
    if (auth.isDemo) throw AppError.forbidden('Las cuentas demo no pueden retirar');
    if (input.currency !== auth.currency) throw AppError.validation('Moneda no soportada para esta cuenta');

    const user = await prisma.user.findFirst({
      where: { id: auth.userId, operatorId: auth.operatorId },
      select: { isDemo: true },
    });
    if (!user) throw AppError.notFound('Jugador no encontrado');
    if (user.isDemo) throw AppError.forbidden('Las cuentas demo no pueden retirar');

    await responsibleGaming.assertCanWithdraw(auth); // KYC VERIFIED, sin autoexclusión

    const { minWithdrawal, maxWithdrawal, maxDailyWithdrawal } = tenant.limits;
    if (minWithdrawal && input.amount < BigInt(minWithdrawal)) throw AppError.limitExceeded('El monto está por debajo del retiro mínimo');
    if (maxWithdrawal && input.amount > BigInt(maxWithdrawal)) throw AppError.limitExceeded('El monto supera el retiro máximo');
    if (maxDailyWithdrawal) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const agg = await prisma.withdrawal.aggregate({
        _sum: { amount: true },
        where: {
          userId: auth.userId,
          createdAt: { gte: startOfDay },
          status: { notIn: ['REJECTED', 'FAILED'] },
        },
      });
      if ((agg._sum.amount ?? 0n) + input.amount > BigInt(maxDailyWithdrawal)) {
        throw AppError.limitExceeded('Se superó el límite diario de retiros');
      }
    }

    // Solo saldo CASH: el bono jamás es retirable.
    const balances = await wallet.getBalances({ operatorId: auth.operatorId, userId: auth.userId });
    if (balances.cash < input.amount) throw AppError.insufficientFunds();

    const id = randomUUID();
    const reserve = await wallet.reserveWithdrawal({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: input.currency,
      amount: input.amount,
      withdrawalId: id,
      idempotencyKey: `wd-reserve:${id}`,
    });

    let withdrawal: Withdrawal;
    try {
      withdrawal = await prisma.withdrawal.create({
        data: {
          id,
          operatorId: auth.operatorId,
          userId: auth.userId,
          provider: input.provider,
          status: 'REQUESTED',
          amount: input.amount,
          currency: input.currency,
          destination: input.destination as object,
          reserveLedgerTxId: reserve.ledgerTransactionId,
        },
      });
    } catch (err) {
      // Compensación: no dejar saldo reservado sin retiro.
      await wallet.releaseWithdrawal({
        operatorId: auth.operatorId,
        userId: auth.userId,
        currency: input.currency,
        amount: input.amount,
        withdrawalId: id,
        idempotencyKey: `wd-release:${id}`,
      });
      throw err;
    }

    await audit.log({
      operatorId: auth.operatorId,
      actorType: 'PLAYER',
      actorId: auth.userId,
      action: 'withdrawal.requested',
      targetType: 'Withdrawal',
      targetId: withdrawal.id,
      after: { status: 'REQUESTED', amount: input.amount.toString(), currency: input.currency },
      ip: input.ip ?? null,
    });
    return withdrawal;
  }
}
