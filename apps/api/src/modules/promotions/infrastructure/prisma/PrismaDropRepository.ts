import type { DropAward, DropCampaign, DropPrize } from '../../domain/drops';
import type { DropCampaignPatch, DropRepository, NewDropCampaign } from '../../application/ports';
import { PrismaLike, TX_OPTIONS } from './PrismaBonusRepository';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toPrize = (r: Row): DropPrize => ({ id: r.id, amount: r.amount, quantity: r.quantity, awarded: r.awarded, sortOrder: r.sortOrder });
function toCampaign(r: Row): DropCampaign {
  const { prizes, ...rest } = r;
  return { ...(rest as Omit<DropCampaign, 'prizes'>), prizes: ((prizes ?? []) as Row[]).map(toPrize).sort((a, b) => a.sortOrder - b.sortOrder) };
}

/** Drops & wins sobre PostgreSQL: el stock se descuenta bloqueando los premios de la campaña y con UPDATE condicional. */
export class PrismaDropRepository implements DropRepository {
  constructor(private readonly db: PrismaLike) {}

  async create(c: NewDropCampaign): Promise<DropCampaign> {
    const { prizes, ...rest } = c;
    const row = await this.db.promoDropCampaign.create({
      data: { ...rest, prizes: { create: prizes.map((p, i) => ({ amount: p.amount, quantity: p.quantity, sortOrder: i })) } },
      include: { prizes: true },
    });
    return toCampaign(row);
  }

  async update(id: string, patch: DropCampaignPatch): Promise<DropCampaign | null> {
    const r = await this.db.promoDropCampaign.updateMany({ where: { id }, data: patch });
    return r.count > 0 ? this.get(id) : null;
  }

  async get(id: string): Promise<DropCampaign | null> {
    const r = await this.db.promoDropCampaign.findUnique({ where: { id }, include: { prizes: true } });
    return r ? toCampaign(r) : null;
  }

  async list(operatorId?: string): Promise<DropCampaign[]> {
    const rows = await this.db.promoDropCampaign.findMany({ where: operatorId ? { operatorId } : {}, include: { prizes: true }, orderBy: { createdAt: 'desc' } });
    return rows.map(toCampaign);
  }

  async award(
    input: { campaignId: string; operatorId: string; playerId: string; currency: string; roundId: string },
    pick: (prizes: DropPrize[]) => DropPrize | null,
  ): Promise<{ award: DropAward | null; duplicate: boolean }> {
    return this.db.$transaction(async (tx: PrismaLike) => {
      await tx.$queryRaw`SELECT id FROM promo_drop_prizes WHERE "campaignId" = ${input.campaignId}::uuid ORDER BY id FOR UPDATE`;
      const existing = await tx.promoDropAward.findUnique({ where: { campaignId_roundId: { campaignId: input.campaignId, roundId: input.roundId } } });
      if (existing) return { award: null, duplicate: true };
      const prizes = ((await tx.promoDropPrize.findMany({ where: { campaignId: input.campaignId } })) as Row[]).map(toPrize);
      const chosen = pick(prizes);
      if (!chosen) return { award: null, duplicate: false };
      const upd = await tx.$executeRaw`UPDATE promo_drop_prizes SET awarded = awarded + 1 WHERE id = ${chosen.id}::uuid AND awarded < quantity`;
      if (upd !== 1) return { award: null, duplicate: false };
      const award = await tx.promoDropAward.create({
        data: { campaignId: input.campaignId, prizeId: chosen.id, operatorId: input.operatorId, playerId: input.playerId, currency: input.currency, roundId: input.roundId, amount: chosen.amount },
      });
      return { award: award as DropAward, duplicate: false };
    }, TX_OPTIONS);
  }

  async markAwardPaid(awardId: string, txId: string): Promise<DropAward | null> {
    await this.db.promoDropAward.updateMany({ where: { id: awardId, status: 'PENDING' }, data: { status: 'PAID', txId } });
    return (await this.db.promoDropAward.findUnique({ where: { id: awardId } })) as DropAward | null;
  }

  async listPendingAwards(limit: number): Promise<DropAward[]> {
    return this.db.promoDropAward.findMany({ where: { status: 'PENDING' }, take: limit, orderBy: { createdAt: 'asc' } });
  }

  async listAwards(campaignId: string, limit: number): Promise<DropAward[]> {
    return this.db.promoDropAward.findMany({ where: { campaignId }, take: limit, orderBy: { createdAt: 'desc' } });
  }
}
