import type { EventBus } from '../../shared/events/EventBus';
import type { PlayerCompliancePort } from '../../shared/ports/PlayerCompliancePort';
import type { WalletPort } from '../../shared/ports/WalletPort';
import type { ModuleLogger } from '../../shared/module';
import type { OperatorCurrencyPort } from '../../shared/ports/OperatorCurrencyPort';
import type { DocStore } from '../infrastructure/DocStore';
import { COL, GamiContext, KeyedMutex, Notifier, PromotionsLike, Rng, cryptoRng, nullNotifier } from './context';
import { RewardService } from './rewards';
import { VipService } from './vip';
import { ProgressService } from './progress';
import { WheelService } from './wheel';
import { TournamentService } from './tournaments';

export interface GamificationOptions {
  store: DocStore;
  wallet: WalletPort;
  bus: EventBus;
  logger: ModuleLogger;
  compliance?: PlayerCompliancePort;
  promotions?: PromotionsLike;
  operators?: OperatorCurrencyPort;
  /** Respaldo de moneda SOLO para el dev-server sin operador real. */
  fallbackCurrency?: string;
  notifier?: Notifier;
  clock?: () => number;
  rng?: Rng;
}

/** Fachada: cablea servicios y se suscribe a los eventos del bus. */
export class GamificationService {
  readonly ctx: GamiContext;
  readonly rewards: RewardService;
  readonly vip: VipService;
  readonly progress: ProgressService;
  readonly wheel: WheelService;
  readonly tournaments: TournamentService;
  private unsubs: Array<() => void> = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly opts: GamificationOptions) {
    this.ctx = {
      store: opts.store,
      wallet: opts.wallet,
      compliance: opts.compliance,
      clock: opts.clock ?? Date.now,
      rng: opts.rng ?? cryptoRng,
      notifier: opts.notifier ?? nullNotifier,
      logger: opts.logger,
      locks: new KeyedMutex(),
      promotions: opts.promotions,
      operators: opts.operators,
      fallbackCurrency: opts.fallbackCurrency,
    };
    this.rewards = new RewardService(this.ctx, () => this.vip);
    this.vip = new VipService(this.ctx, () => this.rewards);
    this.progress = new ProgressService(this.ctx, this.rewards);
    this.wheel = new WheelService(this.ctx, this.rewards);
    this.tournaments = new TournamentService(this.ctx);
  }

  /** Cambia el notificador (el socket se crea después de los servicios). */
  setNotifier(n: Notifier): void {
    this.ctx.notifier = n;
  }

  private async touch(op: string, player: string, currency?: string): Promise<void> {
    if (!currency) return;
    const cur = await this.ctx.store.get<{ currency?: string }>(COL.player, op, player);
    if (cur?.currency !== currency) await this.ctx.store.put(COL.player, op, player, { currency }, player);
  }

  start(intervalMs = 5000): void {
    const bus = this.opts.bus;
    this.unsubs.push(
      bus.subscribe('bet.placed', async (ev) => {
        await this.touch(ev.operatorId, ev.playerId, ev.currency);
        await this.vip.onBetPlaced(ev);
        await this.progress.onBetPlaced(ev);
      }),
      bus.subscribe('bet.settled', async (ev) => {
        await this.touch(ev.operatorId, ev.playerId, ev.currency);
        await this.progress.onBetSettled(ev);
        await this.tournaments.onBetSettled(ev);
      }),
      bus.subscribe('deposit.completed', async (ev) => {
        await this.touch(ev.operatorId, ev.playerId, ev.currency);
        await this.progress.onDeposit(ev);
      }),
      bus.subscribe('login', (ev) => this.progress.onLogin(ev)),
    );
    if (intervalMs > 0) {
      this.timer = setInterval(() => {
        this.tournaments.tick().catch((e) => this.ctx.logger.error('gamification: fallo en tick de torneos', { error: e instanceof Error ? e.message : String(e) }));
      }, intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (this.timer) clearInterval(this.timer);
  }
}
