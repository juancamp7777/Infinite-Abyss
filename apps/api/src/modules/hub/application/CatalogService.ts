import type { GameCategory } from '../../shared/events/EventBus';
import type { CatalogGameInfo, GameCatalogPort } from '../../shared/ports/GameCatalogPort';
import { hubError } from '../domain/errors';
import type { CatalogRepository } from '../domain/repositories';
import {
  catalogGameId,
  Game,
  GameDTO,
  GameImages,
  GameStatus,
  OperatorGame,
  Provider,
  ProviderStatus,
  ProviderType,
  Volatility,
} from '../domain/types';

export type CatalogSort = 'new' | 'popular' | 'az' | 'default';

export interface GameQuery {
  operatorId?: string;
  category?: GameCategory;
  provider?: string;
  q?: string;
  tag?: string;
  /** Mercado del jugador (ISO-3166 alpha-2). */
  market?: string;
  sort?: CatalogSort;
  page?: number;
  pageSize?: number;
  /** Solo admin: incluir juegos desactivados. */
  includeDisabled?: boolean;
}

export interface GameView extends Game {
  providerName: string;
  isNew: boolean;
  /** Orden del operador si lo configuró. */
  sortOrder?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProviderInput {
  id: string;
  name: string;
  type: ProviderType;
  status?: ProviderStatus;
  config?: Record<string, unknown>;
}

export interface GameInput {
  id?: string;
  providerId: string;
  externalId?: string;
  title: string;
  category: GameCategory;
  mechanic?: string;
  rtp?: number;
  volatility?: Volatility;
  images?: Partial<GameImages>;
  tags?: string[];
  allowedMarkets?: string[];
  status?: GameStatus;
  hasDemo?: boolean;
  releasedAt?: Date;
  popularity?: number;
}

const NEW_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** Imágenes por defecto: SVG propios generados por el Hub (infrastructure/http/assets.ts). */
export const defaultImages = (gameId: string): GameImages => ({
  thumb: `/hub/v1/assets/games/${encodeURIComponent(gameId)}/thumb.svg`,
  banner: `/hub/v1/assets/games/${encodeURIComponent(gameId)}/banner.svg`,
});

/**
 * Catálogo unificado de juegos propios y de terceros. Implementa GameCatalogPort para el resto de módulos.
 * Activación por operador: sin fila OperatorGame el juego está activo; con fila manda `enabled` y `sortOrder`.
 */
export class CatalogService implements GameCatalogPort {
  constructor(
    private readonly repo: CatalogRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- GameCatalogPort ----------
  async getGame(gameId: string): Promise<CatalogGameInfo | null> {
    const g = await this.repo.getGame(gameId);
    return g ? { id: g.id, provider: g.providerId, category: g.category, title: g.title } : null;
  }

  // ---------- Lectura pública ----------
  async listProviders(includeDisabled = false): Promise<Provider[]> {
    const all = await this.repo.listProviders();
    return all.filter((p) => includeDisabled || p.status === 'active').sort((a, b) => a.name.localeCompare(b.name));
  }

  async findGame(id: string): Promise<Game | null> {
    return this.repo.getGame(id);
  }

  /** Busca por id de catálogo o por id externo del proveedor. */
  async findProviderGame(providerId: string, gameIdOrExternal: string): Promise<Game | null> {
    const direct = await this.repo.getGame(gameIdOrExternal);
    if (direct && direct.providerId === providerId) return direct;
    const derived = await this.repo.getGame(catalogGameId(providerId, gameIdOrExternal));
    if (derived && derived.providerId === providerId) return derived;
    const list = await this.repo.listGames({ providerId });
    return list.find((g) => g.externalId === gameIdOrExternal) ?? null;
  }

  async getGameView(id: string, operatorId?: string, market?: string): Promise<GameView> {
    const game = await this.repo.getGame(id);
    if (!game) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
    const provider = await this.repo.getProvider(game.providerId);
    const og = operatorId ? (await this.repo.listOperatorGames(operatorId)).find((o) => o.gameId === id) : undefined;
    if (!this.isAvailable(game, provider, og, market)) throw hubError('GAME_NOT_FOUND', 'Juego no disponible');
    return this.view(game, provider, og);
  }

  /** Lanza GAME_UNAVAILABLE si el juego no se puede jugar para ese operador/mercado. */
  async assertPlayable(gameId: string, operatorId: string, market?: string): Promise<{ game: Game; provider: Provider }> {
    const game = await this.repo.getGame(gameId);
    if (!game) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
    const provider = await this.repo.getProvider(game.providerId);
    const og = (await this.repo.listOperatorGames(operatorId)).find((o) => o.gameId === gameId);
    if (!provider || !this.isAvailable(game, provider, og, market)) {
      throw hubError('GAME_UNAVAILABLE', 'Juego no disponible para este operador o mercado');
    }
    return { game, provider };
  }

  async listGames(query: GameQuery): Promise<Page<GameView>> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 24));
    const [games, providers, ogs] = await Promise.all([
      this.repo.listGames({ category: query.category }),
      this.repo.listProviders(),
      query.operatorId ? this.repo.listOperatorGames(query.operatorId) : Promise.resolve([] as OperatorGame[]),
    ]);
    const provById = new Map(providers.map((p) => [p.id, p]));
    const ogById = new Map(ogs.map((o) => [o.gameId, o]));
    const q = query.q?.trim().toLowerCase();
    const tag = query.tag?.toLowerCase();

    const filtered = games
      .filter((g) => {
        const p = provById.get(g.providerId);
        if (!query.includeDisabled && !this.isAvailable(g, p, ogById.get(g.id), query.market)) return false;
        if (query.provider && g.providerId !== query.provider) return false;
        if (tag && !g.tags.some((t) => t.toLowerCase() === tag)) return false;
        if (q) {
          const hay = `${g.title} ${g.id} ${g.mechanic} ${p?.name ?? ''} ${g.tags.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .map((g) => this.view(g, provById.get(g.providerId), ogById.get(g.id)));

    const sort = query.sort ?? 'default';
    filtered.sort((a, b) => {
      if (sort === 'new') return b.releasedAt.getTime() - a.releasedAt.getTime() || a.title.localeCompare(b.title);
      if (sort === 'popular') return b.popularity - a.popularity || a.title.localeCompare(b.title);
      if (sort === 'az') return a.title.localeCompare(b.title);
      const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || b.popularity - a.popularity || a.title.localeCompare(b.title);
    });

    const start = (page - 1) * pageSize;
    return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize };
  }

  // ---------- Administración ----------
  async upsertProvider(input: ProviderInput): Promise<Provider> {
    const existing = await this.repo.getProvider(input.id);
    const now = this.now();
    return this.repo.saveProvider({
      id: input.id,
      name: input.name,
      type: input.type,
      status: input.status ?? existing?.status ?? 'active',
      config: input.config ?? existing?.config ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async patchProvider(id: string, patch: Partial<Omit<ProviderInput, 'id'>>): Promise<Provider> {
    const existing = await this.repo.getProvider(id);
    if (!existing) throw hubError('UNKNOWN_PROVIDER', 'Proveedor no encontrado');
    return this.upsertProvider({ ...existing, ...patch, id });
  }

  async deleteProvider(id: string): Promise<boolean> {
    const games = await this.repo.listGames({ providerId: id });
    for (const g of games) await this.repo.deleteGame(g.id);
    return this.repo.deleteProvider(id);
  }

  async upsertGame(input: GameInput): Promise<Game> {
    const provider = await this.repo.getProvider(input.providerId);
    if (!provider) throw hubError('UNKNOWN_PROVIDER', 'Proveedor no encontrado');
    const externalId = input.externalId ?? input.id ?? input.title;
    const id = input.id ?? catalogGameId(input.providerId, externalId);
    const existing = await this.repo.getGame(id);
    if (existing && existing.providerId !== input.providerId) {
      throw hubError('DUPLICATE', 'El id de juego ya pertenece a otro proveedor');
    }
    const now = this.now();
    const imgs = defaultImages(id);
    return this.repo.saveGame({
      id,
      providerId: input.providerId,
      externalId,
      title: input.title,
      category: input.category,
      mechanic: input.mechanic ?? existing?.mechanic ?? 'standard',
      rtp: input.rtp ?? existing?.rtp ?? 96,
      volatility: input.volatility ?? existing?.volatility ?? 'medium',
      images: { ...imgs, ...(existing?.images ?? {}), ...(input.images ?? {}) },
      tags: input.tags ?? existing?.tags ?? [],
      allowedMarkets: (input.allowedMarkets ?? existing?.allowedMarkets ?? []).map((m) => m.toUpperCase()),
      status: input.status ?? existing?.status ?? 'active',
      hasDemo: input.hasDemo ?? existing?.hasDemo ?? true,
      releasedAt: input.releasedAt ?? existing?.releasedAt ?? now,
      popularity: input.popularity ?? existing?.popularity ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async patchGame(id: string, patch: Partial<Omit<GameInput, 'id' | 'providerId'>>): Promise<Game> {
    const existing = await this.repo.getGame(id);
    if (!existing) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
    return this.upsertGame({ ...existing, ...patch, id, providerId: existing.providerId });
  }

  async deleteGame(id: string): Promise<boolean> {
    return this.repo.deleteGame(id);
  }

  async setOperatorGame(operatorId: string, gameId: string, patch: { enabled?: boolean; sortOrder?: number }): Promise<OperatorGame> {
    const game = await this.repo.getGame(gameId);
    if (!game) throw hubError('GAME_NOT_FOUND', 'Juego no encontrado');
    const current = (await this.repo.listOperatorGames(operatorId)).find((o) => o.gameId === gameId);
    return this.repo.saveOperatorGame({
      operatorId,
      gameId,
      enabled: patch.enabled ?? current?.enabled ?? true,
      sortOrder: patch.sortOrder ?? current?.sortOrder ?? 0,
    });
  }

  /** Fija el orden del lobby del operador: los ids en el orden dado reciben sortOrder 0..n-1. */
  async setOperatorOrder(operatorId: string, gameIds: string[]): Promise<OperatorGame[]> {
    const out: OperatorGame[] = [];
    for (let i = 0; i < gameIds.length; i++) out.push(await this.setOperatorGame(operatorId, gameIds[i], { sortOrder: i }));
    return out;
  }

  async listOperatorGames(operatorId: string): Promise<OperatorGame[]> {
    return this.repo.listOperatorGames(operatorId);
  }

  /**
   * Sincroniza el catálogo de un proveedor: crea/actualiza los juegos recibidos y desactiva
   * los que el proveedor ya no devuelve. Respeta la popularidad y el estado manual de los existentes.
   */
  async syncProvider(providerId: string, dtos: GameDTO[]): Promise<{ created: number; updated: number; disabled: number }> {
    const provider = await this.repo.getProvider(providerId);
    if (!provider) throw hubError('UNKNOWN_PROVIDER', 'Proveedor no encontrado');
    const existing = await this.repo.listGames({ providerId });
    const byExternal = new Map(existing.map((g) => [g.externalId, g]));
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    for (const d of dtos) {
      seen.add(d.externalId);
      const prev = byExternal.get(d.externalId);
      await this.upsertGame({
        id: prev?.id,
        providerId,
        externalId: d.externalId,
        title: d.title,
        category: d.category,
        mechanic: d.mechanic,
        rtp: d.rtp,
        volatility: d.volatility,
        images: d.images,
        tags: d.tags,
        allowedMarkets: d.allowedMarkets,
        hasDemo: d.hasDemo,
        releasedAt: d.releasedAt ? new Date(d.releasedAt) : undefined,
        status: prev?.status ?? 'active',
      });
      if (prev) updated++;
      else created++;
    }
    let disabled = 0;
    for (const g of existing) {
      if (!seen.has(g.externalId) && g.status !== 'disabled') {
        await this.repo.saveGame({ ...g, status: 'disabled', updatedAt: this.now() });
        disabled++;
      }
    }
    return { created, updated, disabled };
  }

  // ---------- Internos ----------
  private isAvailable(game: Game, provider: Provider | null | undefined, og: OperatorGame | undefined, market?: string): boolean {
    if (game.status !== 'active') return false;
    if (!provider || provider.status !== 'active') return false;
    if (og && !og.enabled) return false;
    if (market && game.allowedMarkets.length > 0 && !game.allowedMarkets.includes(market.toUpperCase())) return false;
    return true;
  }

  private view(game: Game, provider: Provider | null | undefined, og: OperatorGame | undefined): GameView {
    return {
      ...game,
      providerName: provider?.name ?? game.providerId,
      isNew: this.now().getTime() - game.releasedAt.getTime() < NEW_WINDOW_MS,
      ...(og ? { sortOrder: og.sortOrder } : {}),
    };
  }
}
