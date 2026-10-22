import { randomUUID } from 'crypto';
import type { DropAward, DropCampaign, DropPrize } from '../../domain/drops';
import type { DropCampaignPatch, DropRepository, NewDropCampaign } from '../../application/ports';
import { KeyedMutex } from '../KeyedMutex';

const clone = <T>(v: T): T => structuredClone(v);

/** Drops & wins en memoria. El stock de cada campaña se serializa por campaignId. */
export class InMemoryDropRepository implements DropRepository {
  private readonly campaigns = new Map<string, DropCampaign>();
  private readonly awards = new Map<string, DropAward>();
  private readonly awardKeys = new Set<string>();
  private readonly mutex = new KeyedMutex();

  async create(c: NewDropCampaign): Promise<DropCampaign> {
    const camp: DropCampaign = {
      ...clone(c),
      id: randomUUID(),
      createdAt: new Date(),
      prizes: c.prizes.map((p, i) => ({ id: randomUUID(), amount: p.amount, quantity: p.quantity, awarded: 0, sortOrder: i })),
    };
    this.campaigns.set(camp.id, camp);
    return clone(camp);
  }

  async update(id: string, patch: DropCampaignPatch): Promise<DropCampaign | null> {
    const c = this.campaigns.get(id);
    if (!c) return null;
    Object.assign(c, clone(patch));
    return clone(c);
  }

  async get(id: string): Promise<DropCampaign | null> {
    const c = this.campaigns.get(id);
    return c ? clone(c) : null;
  }

  async list(operatorId?: string): Promise<DropCampaign[]> {
    return [...this.campaigns.values()]
      .filter((c) => !operatorId || c.operatorId === operatorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(clone);
  }

  async award(
    input: { campaignId: string; operatorId: string; playerId: string; currency: string; roundId: string },
    pick: (prizes: DropPrize[]) => DropPrize | null,
  ): Promise<{ award: DropAward | null; duplicate: boolean }> {
    return this.mutex.run(input.campaignId, () => {
      const c = this.campaigns.get(input.campaignId);
      if (!c) return { award: null, duplicate: false };
      const key = `${input.campaignId}\u0000${input.roundId}`;
      if (this.awardKeys.has(key)) return { award: null, duplicate: true };
      const chosen = pick(clone(c.prizes));
      const prize = chosen ? c.prizes.find((p) => p.id === chosen.id) : undefined;
      if (!prize || prize.awarded >= prize.quantity) return { award: null, duplicate: false };
      prize.awarded += 1;
      this.awardKeys.add(key);
      const award: DropAward = {
        id: randomUUID(),
        campaignId: c.id,
        prizeId: prize.id,
        operatorId: input.operatorId,
        playerId: input.playerId,
        currency: input.currency,
        roundId: input.roundId,
        amount: prize.amount,
        status: 'PENDING',
        txId: null,
        createdAt: new Date(),
      };
      this.awards.set(award.id, award);
      return { award: clone(award), duplicate: false };
    });
  }

  async markAwardPaid(awardId: string, txId: string): Promise<DropAward | null> {
    const a = this.awards.get(awardId);
    if (!a) return null;
    if (a.status !== 'PAID') Object.assign(a, { status: 'PAID', txId });
    return clone(a);
  }

  async listPendingAwards(limit: number): Promise<DropAward[]> {
    return [...this.awards.values()].filter((a) => a.status === 'PENDING').slice(0, limit).map(clone);
  }

  async listAwards(campaignId: string, limit: number): Promise<DropAward[]> {
    return [...this.awards.values()]
      .filter((a) => a.campaignId === campaignId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }
}
