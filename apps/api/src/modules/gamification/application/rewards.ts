import { COL, GamiContext, loadSettings, payCredit, playerCurrency } from './context';
import type { RewardSpec } from '../domain/types';
import type { VipService } from './vip';

/** Entrega recompensas: puntos VIP, bono vía promociones (si existe) o credit BONUS_GRANT. Idempotente por `key`. */
export class RewardService {
  constructor(private readonly ctx: GamiContext, private readonly vip: () => VipService) {}

  async pay(op: string, player: string, reward: RewardSpec, key: string, type: string): Promise<void> {
    if (reward.type === 'points') {
      await this.vip().addPoints(op, player, reward.points, key);
      await this.ctx.store.putIfAbsent(
        COL.payout,
        op,
        key,
        { id: key, type, playerId: player, currency: 'POINTS', amount: reward.points, reason: 'POINTS', at: this.ctx.clock() },
        player,
      );
      return;
    }
    const settings = await loadSettings(this.ctx, op);
    const currency = await playerCurrency(this.ctx, op, player, settings);
    const promo = this.ctx.promotions;
    if (reward.promotionId && promo?.grantBonus) {
      await promo.grantBonus({
        operatorId: op,
        playerId: player,
        promotionId: reward.promotionId,
        amount: reward.amount,
        currency,
        idempotencyKey: key,
        source: 'gamification',
      });
      await this.ctx.store.putIfAbsent(
        COL.payout,
        op,
        key,
        { id: key, type, playerId: player, currency, amount: reward.amount, reason: 'PROMOTION', at: this.ctx.clock() },
        player,
      );
      return;
    }
    await payCredit(this.ctx, { op, player, currency, amount: reward.amount, reason: 'BONUS_GRANT', key, type });
  }
}
