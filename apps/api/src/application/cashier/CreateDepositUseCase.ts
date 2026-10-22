import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  IResponsibleGamingPolicy,
  PlayerAuth,
  TenantContext,
} from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import type { PaymentProviderRegistry } from '../../infrastructure/payments/PaymentProviderRegistry';

export interface CreateDepositDeps {
  prisma: PrismaClient;
  registry: PaymentProviderRegistry;
  responsibleGaming: IResponsibleGamingPolicy;
}

export interface CreateDepositInput {
  auth: PlayerAuth;
  tenant: TenantContext;
  provider: string;
  amount: bigint;
  currency: string;
  returnUrl?: string;
}

export interface CreateDepositOutput {
  depositId: string;
  status: 'PENDING';
  provider: string;
  providerReference: string;
  redirectUrl?: string;
  address?: string;
}

/** Crea la intención de depósito. NUNCA acredita: eso solo ocurre en HandleWebhookUseCase. */
export class CreateDepositUseCase {
  constructor(private readonly deps: CreateDepositDeps) {}

  async execute(input: CreateDepositInput): Promise<CreateDepositOutput> {
    const { prisma, registry, responsibleGaming } = this.deps;
    const { auth, tenant } = input;

    const provider = registry.getEnabled(input.provider);
    if (!provider) throw new AppError('Proveedor de pagos no disponible', 503, true, 'PROVIDER_DISABLED');

    if (auth.isDemo) throw AppError.forbidden('Las cuentas demo no pueden depositar');
    if (input.currency !== auth.currency || !tenant.currencies.includes(input.currency)) {
      throw AppError.validation('Moneda no soportada para esta cuenta');
    }
    if (auth.operatorId !== tenant.operatorId) throw AppError.forbidden();

    const { minDeposit, maxDeposit } = tenant.limits;
    if (minDeposit && input.amount < BigInt(minDeposit)) throw AppError.limitExceeded('El monto está por debajo del depósito mínimo');
    if (maxDeposit && input.amount > BigInt(maxDeposit)) throw AppError.limitExceeded('El monto supera el depósito máximo');
    await responsibleGaming.assertCanDeposit(auth, input.amount);

    const user = await prisma.user.findFirst({
      where: { id: auth.userId, operatorId: auth.operatorId },
      select: { email: true },
    });
    if (!user) throw AppError.notFound('Jugador no encontrado');

    const depositId = randomUUID();
    const providerReference = `dep_${randomUUID().replace(/-/g, '')}`;
    await prisma.deposit.create({
      data: {
        id: depositId,
        operatorId: auth.operatorId,
        userId: auth.userId,
        provider: provider.code,
        status: 'CREATED',
        amount: input.amount,
        currency: input.currency,
        providerReference,
      },
    });

    try {
      const res = await provider.createDeposit({
        operatorId: auth.operatorId,
        userId: auth.userId,
        depositId,
        providerReference,
        amount: input.amount,
        currency: input.currency,
        customerEmail: user.email,
        returnUrl: input.returnUrl,
      });
      await prisma.deposit.updateMany({
        where: { id: depositId, status: 'CREATED' },
        data: { status: 'PENDING', rawCreateResponse: toJson(res.raw) },
      });
      return {
        depositId,
        status: 'PENDING',
        provider: provider.code,
        providerReference,
        redirectUrl: res.redirectUrl,
        address: res.address,
      };
    } catch (err) {
      await prisma.deposit.updateMany({ where: { id: depositId, status: 'CREATED' }, data: { status: 'FAILED' } });
      throw err;
    }
  }
}

function toJson(v: unknown): object {
  return JSON.parse(JSON.stringify(v ?? null, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)) ?? 'null') ?? {};
}
