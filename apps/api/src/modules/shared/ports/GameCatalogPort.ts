import type { GameCategory } from '../events/EventBus';

export interface CatalogGameInfo {
  id: string;
  provider: string;
  category: GameCategory;
  title: string;
}

/** Consulta mínima del catálogo (la implementa el Hub; Studio/promociones la consumen). */
export interface GameCatalogPort {
  getGame(gameId: string): Promise<CatalogGameInfo | null>;
}

export class InMemoryGameCatalog implements GameCatalogPort {
  private readonly games = new Map<string, CatalogGameInfo>();

  constructor(games: CatalogGameInfo[] = []) {
    games.forEach((g) => this.games.set(g.id, g));
  }

  upsert(game: CatalogGameInfo): void {
    this.games.set(game.id, game);
  }

  async getGame(gameId: string): Promise<CatalogGameInfo | null> {
    return this.games.get(gameId) ?? null;
  }
}
