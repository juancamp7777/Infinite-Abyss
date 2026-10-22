import type { PrismaClient, ResponsibleGamingSettings } from '@prisma/client';
import type { IResponsibleGamingPolicy, PlayerAuth } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import {
  LIMIT_FIELDS,
  PERIOD_MS,
  parsePending,
  type LimitField,
} from '../../domain/accounts/limits';

export interface PolicyOptions {
  now?: () => Date;
}

/**
 * Carga los ajustes del jugador aplicando (y persistiendo) las subidas de límite
 * cuyo periodo de espera de 24 h ya venció.
 */
export async function loadRgSettings(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<ResponsibleGamingSettings | null> {
  const s = await prisma.responsibleGamingSettings.findUnique({ where: { userId } });
  if (!s) return null;
  const pending = parsePending(s.pendingLimitIncrease);
  const keys = Object.keys(pending) as LimitField[];
  const due = keys.filter((k) => new Date(pending[k]!.effectiveAt).getTime() <= now.getTime());
  if (due.length === 0) return s;

  const data: Record<string, unknown> = {};
  for (const k of due) {
    const v = pending[k]!.value;
    data[k] = k === 'sessionTimeLimitMinutes' ? (v === null ? null : Number(v)) : v === null ? null : BigInt(v);
    delete pending[k];
  }
  data.pendingLimitIncrease = Object.keys(pending).length ? pending : null;
  return prisma.responsibleGamingSettings.update({ where: { userId }, data: data as never });
}

export class ResponsibleGamingPolicy implements IResponsibleGamingPolicy {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    opts: PolicyOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async assertCanBet(ctx: PlayerAuth, amount: bigint): Promise<void> {
    const now = this.now();
    const s = await loadRgSettings(this.prisma, ctx.userId, now);
    if (!s) return;
    this.assertNotExcluded(s, now);

    const periods: Array<[keyof typeof PERIOD_MS, bigint | null]> = [
      ['daily', s.lossLimitDaily],
      ['weekly', s.lossLimitWeekly],
      ['monthly', s.lossLimitMonthly],
    ];
    for (const [period, limit] of periods) {
      if (limit === null) continue;
      const loss = await this.netLoss(ctx, new Date(now.getTime() - PERIOD_MS[period]));
      if (loss + amount > limit) throw AppError.limitExceeded(`Límite de pérdida ${period} alcanzado`);
    }

    if (s.sessionTimeLimitMinutes !== null) {
      const session = await this.prisma.playerSession.findFirst({
        where: { userId: ctx.userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (session && now.getTime() - session.startedAt.getTime() >= s.sessionTimeLimitMinutes * 60_000) {
        throw AppError.limitExceeded('Se alcanzó el límite de tiempo de sesión');
      }
    }
  }

  async assertCanDeposit(ctx: PlayerAuth, amount: bigint): Promise<void> {
    const now = this.now();
    const s = await loadRgSettings(this.prisma, ctx.userId, now);
    if (!s) return;
    this.assertNotExcluded(s, now);

    const periods: Array<[keyof typeof PERIOD_MS, bigint | null]> = [
      ['daily', s.depositLimitDaily],
      ['weekly', s.depositLimitWeekly],
      ['monthly', s.depositLimitMonthly],
    ];
    for (const [period, limit] of periods) {
      if (limit === null) continue;
      const agg = await this.prisma.deposit.aggregate({
        _sum: { amount: true },
        where: {
          userId: ctx.userId,
          currency: ctx.currency,
          status: 'CONFIRMED',
          confirmedAt: { gte: new Date(now.getTime() - PERIOD_MS[period]) },
        },
      });
      if ((agg._sum.amount ?? 0n) + amount > limit) throw AppError.limitExceeded(`Límite de depósito ${period} alcanzado`);
    }
  }

  async assertCanWithdraw(ctx: PlayerAuth): Promise<void> {
    const u = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { operatorId: true, kycStatus: true, isDemo: true },
    });
    if (!u || u.operatorId !== ctx.operatorId) throw AppError.forbidden();
    if (u.isDemo) throw AppError.forbidden('Las cuentas demo no pueden retirar');
    if (u.kycStatus !== 'VERIFIED') throw AppError.kycRequired();
  }

  private assertNotExcluded(s: ResponsibleGamingSettings, now: Date): void {
    if (s.selfExclusionPermanent) throw AppError.selfExcluded();
    if (s.selfExcludedUntil && s.selfExcludedUntil > now) throw AppError.selfExcluded();
    if (s.coolOffUntil && s.coolOffUntil > now) throw AppError.selfExcluded('El jugador está en periodo de enfriamiento');
  }

  /** Pérdida neta del periodo = −Σ entradas PLAYER_CASH de BET/WIN/ROLLBACK (ventana móvil). */
  private async netLoss(ctx: PlayerAuth, since: Date): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(e."amount"), 0)::bigint AS total
      FROM "LedgerEntry" e
      JOIN "LedgerAccount" a ON a."id" = e."accountId"
      JOIN "LedgerTransaction" t ON t."id" = e."transactionId"
      WHERE a."userId" = ${ctx.userId}::uuid
        AND a."type" = 'PLAYER_CASH'
        AND a."currency" = ${ctx.currency}
        AND t."type" IN ('BET', 'WIN', 'ROLLBACK')
        AND t."createdAt" >= ${since}`;
    const net = -(rows[0]?.total ?? 0n);
    return net > 0n ? net : 0n;
  }
}

export { LIMIT_FIELDS };
