import type { DomainEvents } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import type { GameCatalogPort } from '../../shared/ports/GameCatalogPort';
import type { WalletPort } from '../../shared/ports/WalletPort';
import { Clock, PROMO_PROVIDER, PromoError, RandomSource } from '../domain/common';
import {
  decideTriggers,
  isBetEligible,
  Jackpot,
  JACKPOT_LEVEL_KEYS,
  JackpotLevel,
  JackpotLevelKey,
  JackpotWin,
  pickDropPoint,
  publicJackpot,
  splitContribution,
  totalContribution,
  validateLevels,
} from '../domain/jackpot';
import type { JackpotPatch, JackpotRepository } from './ports';

export interface JackpotEvents {
  onChanged?(operatorId: string): void;
  onWin?(win: JackpotWin): void;
}

export interface JackpotLevelInput {
  key: JackpotLevelKey;
  seedAmount: bigint;
  shareBps: number;
  triggerChancePpm: number;
  mustDropBy?: bigint | null;
}

export interface JackpotInput {
  operatorId: string;
  name: string;
  currency: string;
  contributionBps: number;
  minBet?: bigint;
  gameIds?: string[];
  categories?: string[];
  status?: 'ACTIVE' | 'PAUSED';
  levels: JackpotLevelInput[];
}

export const jackpotWinKey = (jackpotId: string, winId: string): string => `promo:jp:${jackpotId}:${winId}`;

/**
 * Jackpots progresivos mini/major/mega. Cada apuesta elegible contribuye contributionBps repartidos entre niveles
 * (residuo determinista), puede disparar por probabilidad o por "must drop by" y el pago es WalletPort.credit JACKPOT
 * idempotente. El pool vive en el ledger del módulo: contribuciones + seed funding − pagos = pools.
 */
export class JackpotService {
  constructor(
    private readonly d: {
      repo: JackpotRepository;
      wallet: WalletPort;
      clock: Clock;
      rng: RandomSource;
      logger: ModuleLogger;
      catalog?: GameCatalogPort;
      events?: JackpotEvents;
    },
  ) {}

  setEvents(events: JackpotEvents): void {
    this.d.events = events;
  }

  async create(input: JackpotInput): Promise<Jackpot> {
    if (!Number.isInteger(input.contributionBps) || input.contributionBps <= 0 || input.contributionBps > 2000) {
      throw new PromoError(400, 'BAD_REQUEST', 'contributionBps debe estar entre 1 y 2000');
    }
    const levels = input.levels.map((l) => ({ ...l, mustDropBy: l.mustDropBy ?? null }));
    validateLevels(levels);
    const ordered = [...levels].sort((a, b) => JACKPOT_LEVEL_KEYS.indexOf(a.key) - JACKPOT_LEVEL_KEYS.indexOf(b.key));
    return this.d.repo.create({
      operatorId: input.operatorId,
      name: input.name,
      currency: input.currency,
      contributionBps: input.contributionBps,
      minBet: input.minBet ?? 0n,
      gameIds: input.gameIds ?? [],
      categories: input.categories ?? [],
      status: input.status ?? 'ACTIVE',
      levels: ordered.map<JackpotLevel>((l, i) => ({
        key: l.key,
        seedAmount: l.seedAmount,
        shareBps: l.shareBps,
        triggerChancePpm: l.triggerChancePpm,
        mustDropBy: l.mustDropBy,
        dropPoint: pickDropPoint(l.seedAmount, l.mustDropBy, this.d.rng),
        currentAmount: l.seedAmount,
        sortOrder: i,
      })),
    });
  }

  async update(operatorId: string | undefined, id: string, patch: JackpotPatch): Promise<Jackpot> {
    const j = await this.getScoped(operatorId, id);
    if (patch.contributionBps !== undefined && (!Number.isInteger(patch.contributionBps) || patch.contributionBps <= 0 || patch.contributionBps > 2000)) {
      throw new PromoError(400, 'BAD_REQUEST', 'contributionBps debe estar entre 1 y 2000');
    }
    if (patch.levels) {
      if (patch.levels.length !== j.levels.length || patch.levels.some((l) => !j.levels.some((x) => x.key === l.key))) {
        throw new PromoError(400, 'BAD_REQUEST', 'Hay que enviar la configuración de todos los niveles existentes');
      }
      validateLevels(patch.levels);
    }
    const out = await this.d.repo.update(id, patch);
    if (!out) throw new PromoError(404, 'NOT_FOUND', 'Jackpot no encontrado');
    this.d.events?.onChanged?.(out.operatorId);
    return out;
  }

  async getScoped(operatorId: string | undefined, id: string): Promise<Jackpot> {
    const j = await this.d.repo.get(id);
    if (!j || (operatorId && j.operatorId !== operatorId)) throw new PromoError(404, 'NOT_FOUND', 'Jackpot no encontrado');
    return j;
  }

  list(operatorId?: string): Promise<Jackpot[]> {
    return this.d.repo.list(operatorId);
  }

  /** Valores públicos (sin puntos de caída ocultos) de los jackpots activos del operador. */
  async publicList(operatorId: string) {
    return (await this.d.repo.list(operatorId)).filter((j) => j.status === 'ACTIVE').map(publicJackpot);
  }

  async report(operatorId: string | undefined, id: string) {
    await this.getScoped(operatorId, id);
    const r = await this.d.repo.report(id);
    if (!r) throw new PromoError(404, 'NOT_FOUND', 'Jackpot no encontrado');
    return { ...r, balanced: r.contributions + r.seedFunding - r.payouts === r.pools, recentWins: await this.d.repo.listWins(id, 20) };
  }

  /** Consume bet.placed: contribuye a cada jackpot elegible del operador y paga los disparos. */
  async onBetPlaced(e: DomainEvents['bet.placed']): Promise<JackpotWin[]> {
    const jackpots = await this.d.repo.list(e.operatorId);
    if (jackpots.length === 0) return [];
    const category = await this.resolveCategory(e.gameId, e.category);
    const paid: JackpotWin[] = [];
    for (const j of jackpots) {
      if (!isBetEligible(j, { currency: e.currency, amount: e.amount, gameId: e.gameId, category })) continue;
      const res = await this.d.repo.contribute(
        { jackpotId: j.id, operatorId: e.operatorId, playerId: e.playerId, currency: e.currency, roundId: e.roundId, gameId: e.gameId, betAmount: e.amount },
        {
          split: (locked) => {
            const total = totalContribution(e.amount, locked.contributionBps);
            return { total, perLevel: splitContribution(total, locked.levels) };
          },
          decide: (levels) => decideTriggers(levels, this.d.rng),
        },
      );
      if (!res.duplicate) this.d.events?.onChanged?.(e.operatorId);
      for (const w of res.wins) {
        const p = await this.payWin(w);
        if (p) paid.push(p);
      }
    }
    return paid;
  }

  /** Paga una ganancia pendiente (idempotente por la clave promo:jp:<jackpotId>:<winId>). */
  async payWin(w: JackpotWin): Promise<JackpotWin | null> {
    if (w.status === 'PAID') return w;
    try {
      const { txId } = await this.d.wallet.credit({
        operatorId: w.operatorId,
        playerId: w.playerId,
        currency: w.currency,
        amount: w.amount,
        reason: 'JACKPOT',
        idempotencyKey: jackpotWinKey(w.jackpotId, w.id),
        ref: { provider: PROMO_PROVIDER, gameId: w.gameId, roundId: w.roundId },
      });
      const done = await this.d.repo.markWinPaid(w.id, txId, this.d.clock());
      if (done) this.d.events?.onWin?.(done);
      return done;
    } catch (e) {
      this.d.logger.error('promotions: fallo al pagar jackpot (se reintentará en tick)', { winId: w.id, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Reintenta pagos pendientes. */
  async tick(): Promise<{ retried: number }> {
    const pending = await this.d.repo.listPendingWins(200);
    for (const w of pending) await this.payWin(w);
    return { retried: pending.length };
  }

  private async resolveCategory(gameId: string, fallback: string): Promise<string> {
    if (!this.d.catalog) return fallback;
    try {
      return (await this.d.catalog.getGame(gameId))?.category ?? fallback;
    } catch {
      return fallback;
    }
  }
}
