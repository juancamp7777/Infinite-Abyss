import type { PrismaClient, ResponsibleGamingSettings, KycStatus } from '@prisma/client';
import type { BackofficeAuth, IAuditLogger } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import {
  LIMIT_FIELDS,
  LIMIT_INCREASE_COOLDOWN_MS,
  isIncrease,
  parsePending,
  type LimitField,
  type PendingIncreaseMap,
} from '../../domain/accounts/limits';
import { loadRgSettings } from './ResponsibleGamingPolicy';

/** Valor entrante: string de dígitos (unidades mínimas), número entero (minutos) o null (quitar). */
export type LimitInput = Partial<Record<LimitField, string | number | null>>;

export interface LimitsView {
  limits: Record<LimitField, string | number | null>;
  pendingIncreases: PendingIncreaseMap;
  selfExcludedUntil: string | null;
  selfExclusionPermanent: boolean;
  coolOffUntil: string | null;
}

export class ResponsibleGamingService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit?: IAuditLogger,
    opts: { now?: () => Date } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private async ensure(userId: string, operatorId: string): Promise<ResponsibleGamingSettings> {
    const now = this.now();
    const s = await loadRgSettings(this.prisma, userId, now);
    if (s) return s;
    return this.prisma.responsibleGamingSettings.upsert({
      where: { userId },
      create: { userId, operatorId },
      update: {},
    });
  }

  private view(s: ResponsibleGamingSettings): LimitsView {
    const limits = {} as Record<LimitField, string | number | null>;
    for (const f of LIMIT_FIELDS) {
      const v = s[f];
      limits[f] = v === null ? null : typeof v === 'bigint' ? v.toString() : v;
    }
    return {
      limits,
      pendingIncreases: parsePending(s.pendingLimitIncrease),
      selfExcludedUntil: s.selfExcludedUntil?.toISOString() ?? null,
      selfExclusionPermanent: s.selfExclusionPermanent,
      coolOffUntil: s.coolOffUntil?.toISOString() ?? null,
    };
  }

  async getLimits(userId: string, operatorId: string): Promise<LimitsView> {
    return this.view(await this.ensure(userId, operatorId));
  }

  /**
   * Bajadas (o fijar un límite donde no había) → inmediatas.
   * Subidas o retirada del límite → quedan pendientes 24 h (pendingLimitIncrease).
   */
  async updateLimits(userId: string, operatorId: string, input: LimitInput): Promise<LimitsView> {
    const s = await this.ensure(userId, operatorId);
    const now = this.now();
    const pending = parsePending(s.pendingLimitIncrease);
    const data: Record<string, unknown> = {};

    for (const field of LIMIT_FIELDS) {
      if (!(field in input)) continue;
      const raw = input[field];
      const isMinutes = field === 'sessionTimeLimitMinutes';
      const next: bigint | null = raw === null || raw === undefined ? null : BigInt(raw);
      if (next !== null && next <= 0n) throw AppError.validation(`${field} debe ser positivo`);
      const cur = s[field];
      const current: bigint | null = cur === null ? null : BigInt(cur);

      if (isIncrease(current, next)) {
        pending[field] = {
          value: next === null ? null : next.toString(),
          effectiveAt: new Date(now.getTime() + LIMIT_INCREASE_COOLDOWN_MS).toISOString(),
        };
      } else {
        // Bajada (o igual): inmediata y cancela cualquier subida pendiente del mismo campo.
        data[field] = next === null ? null : isMinutes ? Number(next) : next;
        delete pending[field];
      }
    }
    data.pendingLimitIncrease = Object.keys(pending).length ? pending : null;
    const updated = await this.prisma.responsibleGamingSettings.update({
      where: { userId },
      data: data as never,
    });
    return this.view(updated);
  }

  /** Autoexclusión: solo se puede extender, nunca acortar ni revertir. */
  async selfExclude(
    userId: string,
    operatorId: string,
    input: { days?: number; permanent?: boolean },
  ): Promise<LimitsView> {
    const s = await this.ensure(userId, operatorId);
    const now = this.now();
    let data: Record<string, unknown>;
    if (input.permanent) {
      data = { selfExclusionPermanent: true };
    } else if (input.days) {
      const until = new Date(now.getTime() + input.days * 86_400_000);
      data = { selfExcludedUntil: s.selfExcludedUntil && s.selfExcludedUntil > until ? s.selfExcludedUntil : until };
    } else {
      throw AppError.validation('Indica los días o marca la exclusión permanente');
    }
    const updated = await this.prisma.responsibleGamingSettings.update({ where: { userId }, data: data as never });
    await this.prisma.playerSession.updateMany({ where: { userId, endedAt: null }, data: { endedAt: now } });
    await this.audit?.log({
      operatorId,
      actorType: 'PLAYER',
      actorId: userId,
      action: 'player.self_exclusion',
      targetType: 'User',
      targetId: userId,
      after: { days: input.days ?? null, permanent: !!input.permanent },
    });
    return this.view(updated);
  }

  async coolOff(userId: string, operatorId: string, hours: number): Promise<LimitsView> {
    const s = await this.ensure(userId, operatorId);
    const until = new Date(this.now().getTime() + hours * 3_600_000);
    const keep = s.coolOffUntil && s.coolOffUntil > until ? s.coolOffUntil : until;
    const updated = await this.prisma.responsibleGamingSettings.update({
      where: { userId },
      data: { coolOffUntil: keep },
    });
    return this.view(updated);
  }

  /** Jugador: NONE → PENDING. */
  async submitKyc(userId: string, operatorId: string): Promise<{ kycStatus: KycStatus }> {
    const res = await this.prisma.user.updateMany({
      where: { id: userId, operatorId, kycStatus: 'NONE' },
      data: { kycStatus: 'PENDING' },
    });
    if (res.count === 0) throw AppError.conflict('La verificación KYC ya fue enviada o aprobada');
    await this.audit?.log({
      operatorId,
      actorType: 'PLAYER',
      actorId: userId,
      action: 'player.kyc.submit',
      targetType: 'User',
      targetId: userId,
      before: { kycStatus: 'NONE' },
      after: { kycStatus: 'PENDING' },
    });
    return { kycStatus: 'PENDING' };
  }

  /** Backoffice: cambia el KYC de un jugador, acotado a su operador (PLATFORM_ADMIN cruza). */
  async reviewKyc(
    actor: BackofficeAuth,
    playerId: string,
    status: KycStatus,
    reason: string | undefined,
    ip?: string | null,
  ): Promise<{ id: string; kycStatus: KycStatus }> {
    const user = await this.prisma.user.findUnique({
      where: { id: playerId },
      select: { id: true, operatorId: true, kycStatus: true },
    });
    if (!user) {
      // No se distingue "no existe" de "otro operador" para operadores, así no se enumeran IDs ajenos.
      if (actor.role === 'PLATFORM_ADMIN') throw AppError.notFound('Jugador no encontrado');
      throw AppError.forbidden();
    }
    if (actor.role !== 'PLATFORM_ADMIN' && user.operatorId !== actor.operatorId) throw AppError.forbidden();

    await this.prisma.user.update({ where: { id: user.id }, data: { kycStatus: status } });
    await this.audit?.log({
      operatorId: user.operatorId,
      actorType: 'BACKOFFICE_USER',
      actorId: actor.backofficeUserId,
      action: 'player.kyc.review',
      targetType: 'User',
      targetId: user.id,
      reason: reason ?? null,
      before: { kycStatus: user.kycStatus },
      after: { kycStatus: status },
      ip: ip ?? null,
    });
    return { id: user.id, kycStatus: status };
  }
}
