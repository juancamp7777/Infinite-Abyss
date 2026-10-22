import type { DomainEvents, EventBus } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import type { GameCatalogPort } from '../../shared/ports/GameCatalogPort';
import { BetFeed, FeedBet, FeedConfig, FeedKind } from '../domain/BetFeed';
import { pseudonym } from '../domain/pseudonym';

/** Recibe cada apuesta nueva con las listas en las que entró (lo implementa el socket). */
export interface FeedNotifier {
  bet(operatorId: string, playerId: string, bet: FeedBet, kinds: FeedKind[]): void;
}

export interface FeedServiceDeps {
  bus: EventBus;
  catalog?: GameCatalogPort;
  logger: ModuleLogger;
  config: FeedConfig;
  pseudonymSecret: string;
  pseudonymPrefix?: string;
}

const MAX_TITLES = 5_000;

/** Proyecta `bet.settled` (Hub y Studios) al feed en memoria y avisa al notificador. */
export class FeedService {
  readonly feed: BetFeed;
  private notifier?: FeedNotifier;
  private unsubscribe?: () => void;
  private readonly titles = new Map<string, string>();

  constructor(private readonly d: FeedServiceDeps) {
    this.feed = new BetFeed(d.config);
  }

  setNotifier(n: FeedNotifier): void {
    this.notifier = n;
  }

  start(): void {
    this.unsubscribe ??= this.d.bus.subscribe('bet.settled', (e) => this.onSettled(e));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  alias(operatorId: string, playerId: string): string {
    return pseudonym(this.d.pseudonymSecret, operatorId, playerId, this.d.pseudonymPrefix);
  }

  /** Nunca lanza: un fallo del feed no puede afectar a quien publica la apuesta. */
  async onSettled(e: DomainEvents['bet.settled']): Promise<void> {
    try {
      const bet: FeedBet = {
        id: `${e.provider}:${e.roundId}`,
        gameId: e.gameId,
        gameTitle: await this.title(e.gameId),
        provider: e.provider,
        category: String(e.category),
        player: this.alias(e.operatorId, e.playerId),
        currency: e.currency,
        amount: e.amount,
        win: e.win,
        multiplier: Number.isFinite(e.multiplier) ? e.multiplier : 0,
        at: e.at,
      };
      const kinds = this.feed.add(e.operatorId, e.playerId, bet);
      if (kinds) this.notifier?.bet(e.operatorId, e.playerId, bet, kinds);
    } catch (err) {
      this.d.logger.warn('feed: no se pudo registrar la apuesta', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async title(gameId: string): Promise<string> {
    const cached = this.titles.get(gameId);
    if (cached) return cached;
    let title: string | undefined;
    try {
      title = (await this.d.catalog?.getGame(gameId))?.title || undefined;
    } catch {
      /* catálogo caído: se reintenta en la próxima apuesta */
    }
    // Solo se cachea lo encontrado; mientras tanto se muestra el id del juego.
    if (!title) return gameId;
    if (this.titles.size >= MAX_TITLES) this.titles.delete(this.titles.keys().next().value!);
    this.titles.set(gameId, title);
    return title;
  }
}
