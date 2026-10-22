import type { Operator, PrismaClient } from '@prisma/client';
import type { OperatorLimits, TenantContext } from '../../domain/contracts';
import type { TenantRepository } from '../../application/tenancy/TenantResolver';

export function toTenantContext(op: Operator): TenantContext {
  return {
    operatorId: op.id,
    slug: op.slug,
    status: op.status,
    currencies: op.currencies,
    defaultCurrency: op.defaultCurrency,
    chipsEnabled: op.chipsEnabled,
    chipMinorUnitsPerChip: op.chipMinorUnitsPerChip,
    limits: (op.limits && typeof op.limits === 'object' ? op.limits : {}) as OperatorLimits,
  };
}

export class PrismaTenantRepository implements TenantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findBySlug(slug: string): Promise<TenantContext | null> {
    const op = await this.prisma.operator.findUnique({ where: { slug } });
    return op ? toTenantContext(op) : null;
  }

  async findByHost(host: string): Promise<TenantContext | null> {
    const d = await this.prisma.operatorDomain.findUnique({ where: { host }, include: { operator: true } });
    return d ? toTenantContext(d.operator) : null;
  }
}
