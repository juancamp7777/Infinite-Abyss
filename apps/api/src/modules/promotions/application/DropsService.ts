import type { DomainEvents } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import type { WalletPort } from '../../shared/ports/WalletPort';
import { Clock, PROMO_PROVIDER, PromoError, RandomSource } from '../domain/common';
import { DropAward, DropCampaign, DropRoller, isDropActive, isDropEligible, pickPrize, remainingStock } from '../domain/drops';
import type { DropCampaignPatch, DropRepository, NewDropCampaign } from './ports';

export const dropAwardKey = (campaignId: string, awardId: string): string => `promo:drop:${campaignId}:${awardId}`;

/**
 * Drops & wins: cada apuesta elegible tiene dropChancePpm de ganar un premio del pozo (stock limitado por premio).
 * La tirada es determinista por (campaña, ronda) y el stock se descuenta de forma atómica. Pago con
 * WalletPort.credit TOURNAMENT_PRIZE (premio promocional a cargo de marketing), idempotente.
 */
export class DropsService {
  constructor(
    private readonly d: {
      repo: DropRepository;
      wallet: WalletPort;
      clock: Clock;
      rng: RandomSource;
      roller: DropRoller;
      logger: ModuleLogger;
      onAward?: (a: DropAward) => void;
    },
  ) {}

  setOnAward(fn: (a: DropAward) => void): void {
    this.d.onAward = fn;
  }

  async create(input: NewDropCampaign): Promise<DropCampaign> {
    this.validate(input);
    return this.d.repo.create(input);
  }

  async update(operatorId: string | undefined, id: string, patch: DropCampaignPatch): Promise<DropCampaign> {
    const c = await this.getScoped(operatorId, id);
    this.validate({ ...c, ...patch });
    const out = await this.d.repo.update(id, patch);
    if (!out) throw new PromoError(404, 'NOT_FOUND', 'Campaña no encontrada');
    return out;
  }

  async getScoped(operatorId: string | undefined, id: string): Promise<DropCampaign> {
    const c = await this.d.repo.get(id);
    if (!c || (operatorId && c.operatorId !== operatorId)) throw new PromoError(404, 'NOT_FOUND', 'Campaña no encontrada');
    return c;
  }

  list(operatorId?: string): Promise<DropCampaign[]> {
    return this.d.repo.list(operatorId);
  }

  listAwards(campaignId: string, limit = 100): Promise<DropAward[]> {
    return this.d.repo.listAwards(campaignId, limit);
  }

  /** Campañas activas con stock (vista pública). */
  async activeCampaigns(operatorId: string) {
    const now = this.d.clock();
    return (await this.d.repo.list(operatorId))
      .filter((c) => isDropActive(c, now))
      .map((c) => ({
        id: c.id,
        name: c.name,
        currency: c.currency,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        minBet: c.minBet,
        gameIds: c.gameIds,
        remaining: remainingStock(c),
        prizes: c.prizes.map((p) => ({ amount: p.amount, quantity: p.quantity, remaining: p.quantity - p.awarded })),
      }));
  }

  async onBetPlaced(e: DomainEvents['bet.placed']): Promise<DropAward[]> {
    const now = this.d.clock();
    const out: DropAward[] = [];
    for (const c of await this.d.repo.list(e.operatorId)) {
      if (!isDropEligible(c, { currency: e.currency, amount: e.amount, gameId: e.gameId }, now)) continue;
      if (this.d.roller(c.id, e.roundId) >= c.dropChancePpm) continue;
      const { award } = await this.d.repo.award(
        { campaignId: c.id, operatorId: e.operatorId, playerId: e.playerId, currency: e.currency, roundId: e.roundId },
        (prizes) => pickPrize(prizes, this.d.rng),
      );
      if (!award) continue;
      const paid = await this.pay(award);
      out.push(paid ?? award);
    }
    return out;
  }

  async pay(a: DropAward): Promise<DropAward | null> {
    if (a.status === 'PAID') return a;
    try {
      const { txId } = await this.d.wallet.credit({
        operatorId: a.operatorId,
        playerId: a.playerId,
        currency: a.currency,
        amount: a.amount,
        reason: 'TOURNAMENT_PRIZE',
        idempotencyKey: dropAwardKey(a.campaignId, a.id),
        ref: { provider: PROMO_PROVIDER, gameId: `drops:${a.campaignId}`, roundId: a.roundId },
      });
      const done = await this.d.repo.markAwardPaid(a.id, txId);
      if (done) this.d.onAward?.(done);
      return done;
    } catch (e) {
      this.d.logger.error('promotions: fallo al pagar drop (se reintentará en tick)', { awardId: a.id, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  async tick(): Promise<{ retried: number }> {
    const pending = await this.d.repo.listPendingAwards(200);
    for (const a of pending) await this.pay(a);
    return { retried: pending.length };
  }

  private validate(c: Pick<DropCampaign, 'startsAt' | 'endsAt' | 'dropChancePpm'> & { prizes?: Array<{ amount: bigint; quantity: number }> }): void {
    const bad = (m: string) => new PromoError(400, 'BAD_REQUEST', m);
    if (c.startsAt >= c.endsAt) throw bad('startsAt debe ser anterior a endsAt');
    if (!Number.isInteger(c.dropChancePpm) || c.dropChancePpm <= 0 || c.dropChancePpm > 1_000_000) throw bad('dropChancePpm debe estar entre 1 y 1000000');
    if (c.prizes) {
      if (c.prizes.length === 0) throw bad('La campaña necesita premios');
      for (const p of c.prizes) {
        if (p.amount <= 0n || !Number.isInteger(p.quantity) || p.quantity <= 0) throw bad('Cada premio necesita amount > 0 y quantity entera > 0');
      }
    }
  }
}
