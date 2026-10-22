import type { Application } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { ModuleDeps, NymfoModule } from '../shared/module';
import { BonusFundsPort, WalletBonusFunds } from './application/BonusFunds';
import { BonusService, GrantCashbackOptions } from './application/BonusService';
import { DropsService } from './application/DropsService';
import { JackpotLedgerPort, withJackpotLedger } from './application/JackpotLedger';
import { JackpotService } from './application/JackpotService';
import type { BonusRepository, DropRepository, JackpotRepository } from './application/ports';
import { Clock, cryptoRandom, RandomSource, systemClock } from './domain/common';
import { DropRoller, hmacDropRoller } from './domain/drops';
import { buildPromotionsRouter } from './infrastructure/http/routes';
import { InMemoryBonusRepository } from './infrastructure/memory/InMemoryBonusRepository';
import { InMemoryDropRepository } from './infrastructure/memory/InMemoryDropRepository';
import { InMemoryJackpotRepository } from './infrastructure/memory/InMemoryJackpotRepository';
import { PrismaBonusRepository } from './infrastructure/prisma/PrismaBonusRepository';
import { PrismaDropRepository } from './infrastructure/prisma/PrismaDropRepository';
import { PrismaJackpotRepository } from './infrastructure/prisma/PrismaJackpotRepository';
import { JackpotBroadcaster } from './infrastructure/socket/JackpotBroadcaster';

export interface PromotionsOptions {
  clock?: Clock;
  rng?: RandomSource;
  dropRoller?: DropRoller;
  /** Intervalo del job tick (expiraciones y reintentos). 0 = desactivado. Por defecto env PROMO_TICK_INTERVAL_MS o 60000. */
  tickIntervalMs?: number;
  throttleMs?: number;
  repos?: { bonuses?: BonusRepository; jackpots?: JackpotRepository; drops?: DropRepository };
}

/** Envuelve el repositorio de jackpots con el ledger de la plataforma si está publicado (services['wallet.jackpotLedger']). */
function withOptionalJackpotLedger(repo: JackpotRepository, ledger: JackpotLedgerPort | undefined, logger: ModuleDeps['logger']): JackpotRepository {
  return ledger ? withJackpotLedger(repo, ledger, logger) : repo;
}

/** Servicio publicado en services.promotions (lo usan marketing, Studio/Hub y el backoffice). */
export interface PromotionsFacade {
  /** Cashback idempotente por (operatorId, playerId, reason). Sin wagering → crédito CASHBACK en cash. */
  grantCashback(operatorId: string, playerId: string, amount: bigint, reason: string, opts?: GrantCashbackOptions): ReturnType<BonusService['grantCashback']>;
  betGuard: BonusService;
  bonuses: BonusService;
  jackpots: JackpotService;
  drops: DropsService;
  freeSpins: PromotionsFreeSpins;
  tick(now?: Date): Promise<{ bonuses: { expired: number; retried: number }; jackpots: { retried: number }; drops: { retried: number } }>;
  stop(): void;
}

export interface PromotionsFreeSpins {
  available: BonusService['availableFreeSpins'];
  consume: BonusService['consumeFreeSpin'];
  recordWin: BonusService['recordFreeSpinWin'];
}

export function createPromotionsModule(opts: PromotionsOptions = {}): NymfoModule {
  return {
    name: 'promotions',
    async register(app: Application, io: SocketIOServer | undefined, deps: ModuleDeps) {
      const clock = opts.clock ?? systemClock;
      const rng = opts.rng ?? cryptoRandom;
      const usePrisma = !!deps.prisma;
      const repos = {
        bonuses: opts.repos?.bonuses ?? (usePrisma ? new PrismaBonusRepository(deps.prisma) : new InMemoryBonusRepository()),
        jackpots: withOptionalJackpotLedger(
          opts.repos?.jackpots ?? (usePrisma ? new PrismaJackpotRepository(deps.prisma) : new InMemoryJackpotRepository()),
          deps.services['wallet.jackpotLedger'] as JackpotLedgerPort | undefined,
          deps.logger,
        ),
        drops: opts.repos?.drops ?? (usePrisma ? new PrismaDropRepository(deps.prisma) : new InMemoryDropRepository()),
      };
      if (!opts.dropRoller && !deps.env.PROMO_DROPS_SECRET) {
        deps.logger.warn('promotions: PROMO_DROPS_SECRET no definido; las tiradas de drops usan un secreto efímero por proceso');
      }
      const funds = (deps.services['wallet.bonusFunds'] as BonusFundsPort | undefined) ?? new WalletBonusFunds(deps.wallet);

      const bonuses = new BonusService({
        repo: repos.bonuses,
        funds,
        clock,
        logger: deps.logger,
        catalog: deps.catalog,
        compliance: deps.compliance,
        operators: deps.operators,
        // Solo respaldo del dev-server: en la plataforma la moneda sale del operador.
        defaultCurrency: deps.env.PROMO_DEFAULT_CURRENCY || undefined,
      });
      const jackpots = new JackpotService({ repo: repos.jackpots, wallet: deps.wallet, clock, rng, logger: deps.logger, catalog: deps.catalog });
      const drops = new DropsService({
        repo: repos.drops,
        wallet: deps.wallet,
        clock,
        rng,
        roller: opts.dropRoller ?? hmacDropRoller(deps.env.PROMO_DROPS_SECRET),
        logger: deps.logger,
      });

      const broadcaster = new JackpotBroadcaster(io, (op) => jackpots.publicList(op), opts.throttleMs ?? 1000);
      jackpots.setEvents({
        onChanged: (op) => broadcaster.markDirty(op),
        onWin: (w) => {
          broadcaster.emitWinner(w.operatorId, { jackpotId: w.jackpotId, level: w.levelKey, amount: w.amount, currency: w.currency, playerId: w.playerId, gameId: w.gameId, at: w.paidAt });
          broadcaster.markDirty(w.operatorId);
        },
      });
      drops.setOnAward((a) => broadcaster.emitDrop(a.operatorId, { campaignId: a.campaignId, amount: a.amount, currency: a.currency, playerId: a.playerId }));

      // Suscripciones separadas: un fallo en un consumidor no bloquea a los demás.
      const offs = [
        deps.bus.subscribe('bet.placed', (e) => bonuses.onBetPlaced(e)),
        deps.bus.subscribe('bet.placed', async (e) => void (await jackpots.onBetPlaced(e))),
        deps.bus.subscribe('bet.placed', async (e) => void (await drops.onBetPlaced(e))),
        deps.bus.subscribe('bet.settled', (e) => bonuses.onBetSettled(e)),
        deps.bus.subscribe('deposit.completed', (e) => bonuses.onDeposit(e)),
      ];

      app.use('/promo/v1', buildPromotionsRouter({ auth: deps.auth, bonuses, jackpots, drops, logger: deps.logger }));

      const tick: PromotionsFacade['tick'] = async (now = clock()) => ({
        bonuses: await bonuses.tick(now),
        jackpots: await jackpots.tick(),
        drops: await drops.tick(),
      });
      const intervalMs = opts.tickIntervalMs ?? Number(deps.env.PROMO_TICK_INTERVAL_MS ?? 60_000);
      let timer: NodeJS.Timeout | undefined;
      if (Number.isFinite(intervalMs) && intervalMs > 0) {
        timer = setInterval(() => {
          tick().catch((e) => deps.logger.error('promotions: fallo en tick', { error: e instanceof Error ? e.message : String(e) }));
        }, intervalMs);
        timer.unref?.();
      }

      const freeSpins: PromotionsFreeSpins = {
        available: (o, p, g) => bonuses.availableFreeSpins(o, p, g),
        consume: (o, p, g, r) => bonuses.consumeFreeSpin(o, p, g, r),
        recordWin: (b, r, w) => bonuses.recordFreeSpinWin(b, r, w),
      };
      const facade: PromotionsFacade = {
        grantCashback: (o, p, a, r, o2) => bonuses.grantCashback(o, p, a, r, o2),
        betGuard: bonuses,
        bonuses,
        jackpots,
        drops,
        freeSpins,
        tick,
        stop: () => {
          if (timer) clearInterval(timer);
          broadcaster.close();
          offs.forEach((off) => off());
        },
      };
      deps.logger.info('promotions: módulo montado en /promo/v1', { persistence: usePrisma ? 'prisma' : 'memory' });
      return { promotions: facade, 'promotions.betGuard': bonuses, 'promotions.freeSpins': freeSpins };
    },
  };
}

export const promotionsModule: NymfoModule = createPromotionsModule();

export { BonusService, JackpotService, DropsService, WalletBonusFunds };
export type { BonusFundsPort, GrantCashbackOptions };
