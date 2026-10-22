import type { PrismaClient } from '@prisma/client';
import type { IResponsibleGamingPolicy, PlayerAuth } from '../../../domain/contracts';
import { AppError } from '../../../domain/errors/AppError';
import { loadRgSettings } from '../../../application/responsible-gaming/ResponsibleGamingPolicy';
import type { BetCheckRequest, BetCheckResult, BetGuardPort } from '../../../modules/shared/ports/BetGuardPort';
import type { PlayerCompliancePort, PlayerComplianceStatus } from '../../../modules/shared/ports/PlayerCompliancePort';

export interface Phase1ComplianceOptions {
  now?: () => Date;
}

/** Estado para jugadores inexistentes o de otro operador: excluido y sin verificar (fail-closed). */
const UNKNOWN_PLAYER: PlayerComplianceStatus = {
  selfExcluded: true,
  hasActiveLimits: false,
  ageVerified: false,
  isMinor: false,
};

/**
 * PlayerCompliancePort real sobre la Fase 1 (User.status, kycStatus y ResponsibleGamingSettings).
 *
 * - selfExcluded: autoexclusión temporal o permanente, cool-off vigente, o cuenta SUSPENDED/CLOSED.
 *   Marketing y CRM no contactan a estos jugadores y el betGuard les impide apostar.
 * - hasActiveLimits: cualquier límite de depósito, pérdida o tiempo de sesión configurado.
 * - ageVerified: KYC verificado (la verificación de identidad incluye la mayoría de edad).
 * - isMinor: la Fase 1 no registra menores (el registro exige mayoría de edad), siempre false.
 */
export class Phase1PlayerCompliance implements PlayerCompliancePort {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    opts: Phase1ComplianceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  async getStatus(operatorId: string, playerId: string): Promise<PlayerComplianceStatus> {
    if (!isUuid(operatorId) || !isUuid(playerId)) return { ...UNKNOWN_PLAYER };
    const user = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { operatorId: true, status: true, kycStatus: true, email: true },
    });
    if (!user || user.operatorId !== operatorId) return { ...UNKNOWN_PLAYER };

    const now = this.now();
    const s = await loadRgSettings(this.prisma, playerId, now);
    const excludedByRg = Boolean(
      s &&
        (s.selfExclusionPermanent ||
          (s.selfExcludedUntil && s.selfExcludedUntil > now) ||
          (s.coolOffUntil && s.coolOffUntil > now)),
    );
    const hasActiveLimits = Boolean(
      s &&
        [
          s.depositLimitDaily,
          s.depositLimitWeekly,
          s.depositLimitMonthly,
          s.lossLimitDaily,
          s.lossLimitWeekly,
          s.lossLimitMonthly,
          s.sessionTimeLimitMinutes,
        ].some((v) => v !== null && v !== undefined),
    );
    return {
      selfExcluded: excludedByRg || user.status !== 'ACTIVE',
      hasActiveLimits,
      ageVerified: user.kycStatus === 'VERIFIED',
      isMinor: false,
      email: user.email,
    };
  }
}

/**
 * BetGuardPort de la Fase 1 para las apuestas de los módulos (Hub y Studios): aplica
 * ResponsibleGamingPolicy.assertCanBet (autoexclusión, cool-off, límites de pérdida y de sesión)
 * y rechaza cuentas inexistentes, de otro operador o no ACTIVE.
 */
export class Phase1BetGuard implements BetGuardPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly policy: IResponsibleGamingPolicy,
  ) {}

  async checkBet(req: BetCheckRequest): Promise<BetCheckResult> {
    if (!isUuid(req.operatorId) || !isUuid(req.playerId)) return { allowed: false, reason: 'PLAYER_NOT_FOUND' };
    const user = await this.prisma.user.findUnique({
      where: { id: req.playerId },
      select: { id: true, operatorId: true, status: true, currency: true, isDemo: true },
    });
    if (!user || user.operatorId !== req.operatorId) return { allowed: false, reason: 'PLAYER_NOT_FOUND' };
    if (user.status !== 'ACTIVE') return { allowed: false, reason: 'ACCOUNT_NOT_ACTIVE' };
    const ctx: PlayerAuth = {
      kind: 'player',
      userId: user.id,
      operatorId: user.operatorId,
      currency: req.currency || user.currency,
      isDemo: user.isDemo,
    };
    try {
      await this.policy.assertCanBet(ctx, req.amount);
      return { allowed: true };
    } catch (e) {
      if (e instanceof AppError) return { allowed: false, reason: e.code };
      throw e;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
