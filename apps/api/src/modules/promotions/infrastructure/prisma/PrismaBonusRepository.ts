import type { BonusPhase, BonusStatus, BonusTemplate, PlayerBonus } from '../../domain/bonus';
import type {
  BonusListFilter,
  BonusRepository,
  BonusTemplatePatch,
  NewBonusTemplate,
  NewPlayerBonus,
  PlayerNetResult,
  SettledRoundInput,
} from '../../application/ports';

/** Cliente Prisma generado con el schema fusionado (prisma/modules/promotions.prisma). Se tipa laxo para no depender del generate. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrismaLike = any;

export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTemplate(r: any): BonusTemplate {
  return { ...r, contributionBps: (r.contributionBps ?? {}) as Record<string, number>, excludedGameIds: r.excludedGameIds ?? [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBonus(r: any): PlayerBonus {
  const { rounds: _rounds, ...rest } = r;
  return { ...rest, contributionBps: (r.contributionBps ?? {}) as Record<string, number>, excludedGameIds: r.excludedGameIds ?? [] };
}

/** Repositorio de bonos sobre PostgreSQL. Las secciones críticas bloquean la fila con SELECT … FOR UPDATE. */
export class PrismaBonusRepository implements BonusRepository {
  constructor(private readonly db: PrismaLike) {}

  async createTemplate(t: NewBonusTemplate): Promise<BonusTemplate> {
    return toTemplate(await this.db.promoBonusTemplate.create({ data: t }));
  }

  async updateTemplate(id: string, patch: BonusTemplatePatch): Promise<BonusTemplate | null> {
    try {
      return toTemplate(await this.db.promoBonusTemplate.update({ where: { id }, data: patch }));
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2025') return null;
      throw e;
    }
  }

  async deleteTemplate(id: string): Promise<boolean> {
    const r = await this.db.promoBonusTemplate.deleteMany({ where: { id } });
    return r.count > 0;
  }

  async getTemplate(id: string): Promise<BonusTemplate | null> {
    const r = await this.db.promoBonusTemplate.findUnique({ where: { id } });
    return r ? toTemplate(r) : null;
  }

  async listTemplates(operatorId?: string): Promise<BonusTemplate[]> {
    const rows = await this.db.promoBonusTemplate.findMany({ where: operatorId ? { operatorId } : {}, orderBy: { createdAt: 'desc' } });
    return rows.map(toTemplate);
  }

  async findTemplateByCode(operatorId: string, code: string): Promise<BonusTemplate | null> {
    const r = await this.db.promoBonusTemplate.findUnique({ where: { operatorId_code: { operatorId, code } } });
    return r ? toTemplate(r) : null;
  }

  async listAutoDepositTemplates(operatorId: string, currency: string): Promise<BonusTemplate[]> {
    const rows = await this.db.promoBonusTemplate.findMany({
      where: { operatorId, currency, status: 'ACTIVE', type: 'deposit_match', autoOnDeposit: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toTemplate);
  }

  countBonusesByTemplate(templateId: string): Promise<number> {
    return this.db.promoPlayerBonus.count({ where: { templateId } });
  }

  async reserveCodeUse(templateId: string, playerId: string): Promise<'OK' | 'TOTAL_LIMIT' | 'PLAYER_LIMIT'> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      await tx.$queryRaw`SELECT id FROM promo_bonus_templates WHERE id = ${templateId}::uuid FOR UPDATE`;
      const t = await tx.promoBonusTemplate.findUnique({ where: { id: templateId } });
      if (!t) return 'TOTAL_LIMIT';
      if (t.maxUsesTotal != null && t.usesCount >= t.maxUsesTotal) return 'TOTAL_LIMIT';
      if (t.maxUsesPerPlayer != null) {
        const mine = await tx.promoCodeRedemption.count({ where: { templateId, playerId } });
        if (mine >= t.maxUsesPerPlayer) return 'PLAYER_LIMIT';
      }
      await tx.promoBonusTemplate.update({ where: { id: templateId }, data: { usesCount: { increment: 1 } } });
      await tx.promoCodeRedemption.create({ data: { templateId, playerId } });
      return 'OK';
    }, TX_OPTIONS);
  }

  async releaseCodeUse(templateId: string, playerId: string): Promise<void> {
    await this.db.$transaction(async (tx: PrismaLike) => {
      const r = await tx.promoCodeRedemption.findFirst({ where: { templateId, playerId }, orderBy: { createdAt: 'desc' } });
      if (!r) return;
      await tx.promoCodeRedemption.delete({ where: { id: r.id } });
      await tx.promoBonusTemplate.updateMany({ where: { id: templateId, usesCount: { gt: 0 } }, data: { usesCount: { decrement: 1 } } });
    }, TX_OPTIONS);
  }

  async createBonus(b: NewPlayerBonus): Promise<{ bonus: PlayerBonus; created: boolean }> {
    try {
      return { bonus: toBonus(await this.db.promoPlayerBonus.create({ data: b })), created: true };
    } catch (e) {
      if (isUniqueViolation(e) && b.sourceRef) {
        const existing = await this.findBySourceRef(b.operatorId, b.sourceRef);
        if (existing) return { bonus: existing, created: false };
      }
      throw e;
    }
  }

  async getBonus(id: string): Promise<PlayerBonus | null> {
    const r = await this.db.promoPlayerBonus.findUnique({ where: { id } });
    return r ? toBonus(r) : null;
  }

  async findBySourceRef(operatorId: string, sourceRef: string): Promise<PlayerBonus | null> {
    const r = await this.db.promoPlayerBonus.findUnique({ where: { operatorId_sourceRef: { operatorId, sourceRef } } });
    return r ? toBonus(r) : null;
  }

  async listBonuses(f: BonusListFilter): Promise<PlayerBonus[]> {
    const rows = await this.db.promoPlayerBonus.findMany({
      where: {
        ...(f.operatorId ? { operatorId: f.operatorId } : {}),
        ...(f.playerId ? { playerId: f.playerId } : {}),
        ...(f.status ? { status: { in: f.status } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: f.limit ?? 50,
      skip: f.offset ?? 0,
    });
    return rows.map(toBonus);
  }

  async findOpenBonuses(operatorId: string, playerId: string): Promise<PlayerBonus[]> {
    const rows = await this.db.promoPlayerBonus.findMany({
      where: { operatorId, playerId, status: { in: ['PENDING', 'ACTIVE'] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toBonus);
  }

  async listExpired(now: Date, limit: number): Promise<PlayerBonus[]> {
    const rows = await this.db.promoPlayerBonus.findMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, expiresAt: { lte: now } },
      take: limit,
    });
    return rows.map(toBonus);
  }

  async listUnsettled(limit: number): Promise<PlayerBonus[]> {
    const rows = await this.db.promoPlayerBonus.findMany({
      where: {
        OR: [
          { status: 'ACTIVE', phase: 'WAGERING', amount: { gt: 0n }, grantTxId: null },
          { status: { in: ['COMPLETED', 'FORFEITED', 'CANCELLED'] }, settlementAmount: { gt: 0n }, settlementTxId: null },
        ],
      },
      take: limit,
    });
    return rows.map(toBonus);
  }

  async updateIf(id: string, expect: { status?: BonusStatus[]; phase?: BonusPhase }, patch: Partial<PlayerBonus>): Promise<PlayerBonus | null> {
    const { id: _id, createdAt: _c, ...data } = patch;
    const r = await this.db.promoPlayerBonus.updateMany({
      where: { id, ...(expect.status ? { status: { in: expect.status } } : {}), ...(expect.phase ? { phase: expect.phase } : {}) },
      data,
    });
    return r.count > 0 ? this.getBonus(id) : null;
  }

  async addWagering(bonusId: string, roundId: string, contribution: bigint): Promise<PlayerBonus | null> {
    return this.withLockedBonus(bonusId, async (tx, b) => {
      if (b.status !== 'ACTIVE' || b.phase !== 'WAGERING') return null;
      if (!(await this.insertRound(tx, bonusId, `w:${roundId}`, contribution))) return null;
      return toBonus(await tx.promoPlayerBonus.update({ where: { id: bonusId }, data: { wageringProgress: { increment: contribution } } }));
    });
  }

  async consumeFreeSpin(bonusId: string, roundId: string): Promise<PlayerBonus | null> {
    return this.withLockedBonus(bonusId, async (tx, b) => {
      if (b.status !== 'ACTIVE' || b.phase !== 'SPINS' || b.freeSpinsUsed >= b.freeSpinsTotal) return null;
      if (!(await this.insertRound(tx, bonusId, `fs:${roundId}`, 0n))) return null;
      return toBonus(await tx.promoPlayerBonus.update({ where: { id: bonusId }, data: { freeSpinsUsed: { increment: 1 } } }));
    });
  }

  async addFreeSpinWin(bonusId: string, roundId: string, win: bigint): Promise<PlayerBonus | null> {
    return this.withLockedBonus(bonusId, async (tx, b) => {
      if (b.status !== 'ACTIVE' || b.phase !== 'SPINS') return null;
      const spun = await tx.promoBonusRound.findUnique({ where: { bonusId_key: { bonusId, key: `fs:${roundId}` } } });
      if (!spun) return null;
      if (!(await this.insertRound(tx, bonusId, `fsw:${roundId}`, win))) return null;
      return toBonus(
        await tx.promoPlayerBonus.update({ where: { id: bonusId }, data: { freeSpinWin: { increment: win }, freeSpinsSettled: { increment: 1 } } }),
      );
    });
  }

  async recordSettledRound(r: SettledRoundInput): Promise<boolean> {
    const res = await this.db.promoSettledRound.createMany({
      data: [{ operatorId: r.operatorId, roundId: r.roundId, playerId: r.playerId, currency: r.currency, amount: r.amount, win: r.win, settledAt: r.at }],
      skipDuplicates: true,
    });
    return res.count > 0;
  }

  async netResults(operatorId: string, currency: string, from: Date, to: Date): Promise<PlayerNetResult[]> {
    const rows = await this.db.promoSettledRound.groupBy({
      by: ['playerId'],
      where: { operatorId, currency, settledAt: { gte: from, lt: to } },
      _sum: { amount: true, win: true },
      orderBy: { playerId: 'asc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ playerId: r.playerId, wagered: BigInt(r._sum.amount ?? 0), won: BigInt(r._sum.win ?? 0) }));
  }

  private withLockedBonus<T>(bonusId: string, fn: (tx: PrismaLike, b: PlayerBonus) => Promise<T | null>): Promise<T | null> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      await tx.$queryRaw`SELECT id FROM promo_player_bonuses WHERE id = ${bonusId}::uuid FOR UPDATE`;
      const row = await tx.promoPlayerBonus.findUnique({ where: { id: bonusId } });
      return row ? fn(tx, toBonus(row)) : null;
    }, TX_OPTIONS);
  }

  /** Inserta la marca de ronda; false si ya existía (no aborta la transacción gracias a skipDuplicates). */
  private async insertRound(tx: PrismaLike, bonusId: string, key: string, contribution: bigint): Promise<boolean> {
    const r = await tx.promoBonusRound.createMany({ data: [{ bonusId, key, contribution }], skipDuplicates: true });
    return r.count > 0;
  }
}
