import { HttpError } from '../../shared/http/errors';
import type { DomainEvents } from '../../shared/events/EventBus';
import { COL, GamiContext, eventTime, loadSettings, payCredit, playerCurrency } from './context';
import type { RewardService } from './rewards';
import { VipLevel, VipPlayer, defaultLevels } from '../domain/types';
import { periodKey } from '../domain/periods';

const RB_DIV = 100_000_000n; // bps (1e4) × bps (1e4)

export function levelFor(levels: VipLevel[], points: bigint): VipLevel {
  let cur = levels[0];
  for (const l of levels) if (points >= l.pointsRequired) cur = l;
  return cur;
}

const emptyVip = (playerId: string, levelId: string): VipPlayer => ({
  playerId,
  points: 0n,
  wagered: 0n,
  levelId,
  remainders: {},
  rakebackPending: 0n,
  rakebackFrac: 0n,
});

/**
 * VIP: puntos por apuesta (units por punto por categoría), niveles y rakeback.
 * Rakeback = apuesta × houseEdgeBps[categoría] × rakebackBps[nivel] / 1e8
 * (el jugador recupera ese % de la ventaja teórica de la casa). El nivel se toma al momento de la apuesta.
 */
export class VipService {
  constructor(private readonly ctx: GamiContext, private readonly rewards: () => RewardService) {}

  async levels(op: string): Promise<VipLevel[]> {
    const stored = await this.ctx.store.list<VipLevel>(COL.level, op);
    const l = stored.length > 0 ? stored : defaultLevels(op, (await loadSettings(this.ctx, op)).currency);
    return [...l].sort((a, b) => (a.pointsRequired < b.pointsRequired ? -1 : a.pointsRequired > b.pointsRequired ? 1 : 0));
  }

  async state(op: string, player: string) {
    const levels = await this.levels(op);
    const doc = (await this.ctx.store.get<VipPlayer>(COL.vip, op, player)) ?? emptyVip(player, levels[0].id);
    const cur = levelFor(levels, doc.points);
    const next = levels.find((l) => l.pointsRequired > doc.points) ?? null;
    let progressPct = 100;
    if (next) {
      const span = next.pointsRequired - cur.pointsRequired;
      progressPct = span > 0n ? Number(((doc.points - cur.pointsRequired) * 10000n) / span) / 100 : 100;
    }
    const settings = await loadSettings(this.ctx, op);
    const period = periodKey(settings.rakebackPeriod, this.ctx.clock(), settings.timezone);
    return {
      level: { id: cur.id, name: cur.name, rakebackBps: cur.rakebackBps, benefits: cur.benefits },
      points: doc.points,
      wagered: doc.wagered,
      next: next ? { id: next.id, name: next.name, pointsRequired: next.pointsRequired, benefits: next.benefits } : null,
      pointsToNext: next ? next.pointsRequired - doc.points : 0n,
      progressPct,
      rakeback: {
        pending: doc.rakebackPending,
        period,
        claimedThisPeriod: doc.lastRakebackPeriod === period,
        claimable: doc.lastRakebackPeriod !== period && (doc.rakebackPending > 0n || !!doc.rakebackIntent),
      },
    };
  }

  /** Suma puntos de forma idempotente por sourceKey (recompensas de misiones, rueda, etc.). */
  async addPoints(op: string, player: string, points: bigint, sourceKey: string): Promise<void> {
    if (points <= 0n) return;
    await this.mutate(op, player, sourceKey, (doc) => {
      doc.points += points;
    });
  }

  async onBetPlaced(ev: DomainEvents['bet.placed']): Promise<void> {
    if (ev.isBonusMoney || ev.amount <= 0n) return;
    const settings = await loadSettings(this.ctx, ev.operatorId);
    const cat = String(ev.category);
    const units = settings.unitsPerPoint[cat] ?? settings.unitsPerPoint.default ?? 100n;
    const edge = BigInt(settings.houseEdgeBps[cat] ?? settings.houseEdgeBps.default ?? 400);
    await this.mutate(ev.operatorId, ev.playerId, `bet:${ev.roundId}`, (doc, levels) => {
      const levelNow = levelFor(levels, doc.points);
      const rem = (doc.remainders[cat] ?? 0n) + ev.amount;
      doc.remainders[cat] = rem % units;
      doc.points += rem / units;
      doc.wagered += ev.amount;
      const num = doc.rakebackFrac + ev.amount * edge * BigInt(levelNow.rakebackBps);
      doc.rakebackPending += num / RB_DIV;
      doc.rakebackFrac = num % RB_DIV;
    });
  }

  private async mutate(op: string, player: string, sourceKey: string, fn: (doc: VipPlayer, levels: VipLevel[]) => void): Promise<void> {
    let crossed: VipLevel[] = [];
    let finalLevel: VipLevel | undefined;
    await this.ctx.locks.run(`vip:${op}:${player}`, async () => {
      const fresh = await this.ctx.store.putIfAbsent(COL.dedupe, op, `vip:${sourceKey}`, { at: this.ctx.clock() }, player);
      if (!fresh) return;
      const levels = await this.levels(op);
      const doc = (await this.ctx.store.get<VipPlayer>(COL.vip, op, player)) ?? emptyVip(player, levels[0].id);
      const before = levelFor(levels, doc.points);
      fn(doc, levels);
      const after = levelFor(levels, doc.points);
      doc.levelId = after.id;
      await this.ctx.store.put(COL.vip, op, player, doc, player);
      crossed = levels.filter((l) => l.pointsRequired > before.pointsRequired && l.pointsRequired <= doc.points);
      finalLevel = after;
    });
    for (const l of crossed) {
      if (l.levelUpBonus > 0n) {
        await this.rewards().pay(op, player, { type: 'bonus', amount: l.levelUpBonus }, `gami:levelup:${player}:${l.id}`, 'vip_levelup');
      }
      this.ctx.notifier.toPlayer(op, player, 'vip:levelup', {
        level: { id: l.id, name: l.name, rakebackBps: l.rakebackBps, benefits: l.benefits },
        bonus: l.levelUpBonus,
      });
    }
    void finalLevel;
  }

  /** Reclama el rakeback acumulado: una vez por periodo (idempotente; reanuda si un intento previo quedó a medias). */
  async claimRakeback(op: string, player: string): Promise<{ amount: bigint; period: string; currency: string }> {
    return this.ctx.locks.run(`vip:${op}:${player}`, async () => {
      const settings = await loadSettings(this.ctx, op);
      const levels = await this.levels(op);
      const doc = (await this.ctx.store.get<VipPlayer>(COL.vip, op, player)) ?? emptyVip(player, levels[0].id);
      const period = periodKey(settings.rakebackPeriod, this.ctx.clock(), settings.timezone);
      if (!doc.rakebackIntent) {
        if (doc.lastRakebackPeriod === period) throw new HttpError(409, 'RAKEBACK_ALREADY_CLAIMED', 'El rakeback de este periodo ya fue reclamado');
        if (doc.rakebackPending <= 0n) throw new HttpError(409, 'NOTHING_TO_CLAIM', 'No hay rakeback acumulado');
        doc.rakebackIntent = { period, amount: doc.rakebackPending };
        doc.rakebackPending = 0n;
        await this.ctx.store.put(COL.vip, op, player, doc, player);
      }
      const intent = doc.rakebackIntent;
      const currency = await playerCurrency(this.ctx, op, player, settings);
      await payCredit(this.ctx, {
        op,
        player,
        currency,
        amount: intent.amount,
        reason: 'CASHBACK',
        key: `gami:rakeback:${player}:${intent.period}`,
        type: 'rakeback',
      });
      doc.lastRakebackPeriod = intent.period;
      doc.rakebackIntent = undefined;
      await this.ctx.store.put(COL.vip, op, player, doc, player);
      return { amount: intent.amount, period: intent.period, currency };
    });
  }
}
