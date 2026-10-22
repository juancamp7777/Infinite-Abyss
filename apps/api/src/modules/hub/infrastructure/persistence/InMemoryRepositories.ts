import type { GameCategory } from '../../../shared/events/EventBus';
import {
  CatalogRepository,
  DuplicateTransactionError,
  HubRepositories,
  RemoteOperatorRepository,
  ReportFilter,
  ReportRow,
  SessionRepository,
  WalletTxRepository,
} from '../../domain/repositories';
import type {
  Game,
  HubRound,
  HubSession,
  HubTransaction,
  OperatorGame,
  Provider,
  RemoteOperator,
} from '../../domain/types';

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryCatalogRepository implements CatalogRepository {
  private readonly providers = new Map<string, Provider>();
  private readonly games = new Map<string, Game>();
  private readonly operatorGames = new Map<string, OperatorGame>();

  async listProviders(): Promise<Provider[]> {
    return [...this.providers.values()].map(clone);
  }
  async getProvider(id: string): Promise<Provider | null> {
    const p = this.providers.get(id);
    return p ? clone(p) : null;
  }
  async saveProvider(p: Provider): Promise<Provider> {
    this.providers.set(p.id, clone(p));
    return clone(p);
  }
  async deleteProvider(id: string): Promise<boolean> {
    return this.providers.delete(id);
  }

  async listGames(filter: { providerId?: string; category?: GameCategory } = {}): Promise<Game[]> {
    return [...this.games.values()]
      .filter((g) => (!filter.providerId || g.providerId === filter.providerId) && (!filter.category || g.category === filter.category))
      .map(clone);
  }
  async getGame(id: string): Promise<Game | null> {
    const g = this.games.get(id);
    return g ? clone(g) : null;
  }
  async saveGame(g: Game): Promise<Game> {
    this.games.set(g.id, clone(g));
    return clone(g);
  }
  async deleteGame(id: string): Promise<boolean> {
    return this.games.delete(id);
  }

  async listOperatorGames(operatorId: string): Promise<OperatorGame[]> {
    return [...this.operatorGames.values()].filter((o) => o.operatorId === operatorId).map(clone);
  }
  async saveOperatorGame(og: OperatorGame): Promise<OperatorGame> {
    this.operatorGames.set(`${og.operatorId}\u0000${og.gameId}`, clone(og));
    return clone(og);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly byId = new Map<string, HubSession>();
  private readonly byToken = new Map<string, string>();

  async create(s: HubSession): Promise<HubSession> {
    this.byId.set(s.id, clone(s));
    this.byToken.set(s.token, s.id);
    return clone(s);
  }
  async findByToken(token: string): Promise<HubSession | null> {
    const id = this.byToken.get(token);
    return id ? this.findById(id) : null;
  }
  async findById(id: string): Promise<HubSession | null> {
    const s = this.byId.get(id);
    return s ? clone(s) : null;
  }
  async touch(id: string, expiresAt: Date): Promise<void> {
    const s = this.byId.get(id);
    if (s) s.expiresAt = expiresAt;
  }
  private readonly byExternal = new Map<string, string>();
  async setExternalSessionId(id: string, externalSessionId: string): Promise<void> {
    const s = this.byId.get(id);
    if (!s) return;
    const key = `${s.providerId}\u0000${externalSessionId}`;
    const owner = this.byExternal.get(key);
    // Mismo contrato que el índice único de Prisma: el id externo pertenece a una sola sesión del proveedor.
    if (owner && owner !== id) throw new Error('externalSessionId ya asignado a otra sesión');
    s.externalSessionId = externalSessionId;
    this.byExternal.set(key, id);
  }
  async findByExternalId(providerId: string, externalSessionId: string): Promise<HubSession | null> {
    const id = this.byExternal.get(`${providerId}\u0000${externalSessionId}`);
    return id ? this.findById(id) : null;
  }
}

export class InMemoryWalletTxRepository implements WalletTxRepository {
  private readonly txs = new Map<string, HubTransaction>();
  private readonly rounds = new Map<string, HubRound>();

  async findTx(providerId: string, providerTxId: string): Promise<HubTransaction | null> {
    const t = this.txs.get(`${providerId}\u0000${providerTxId}`);
    return t ? clone(t) : null;
  }
  async insertTx(tx: HubTransaction): Promise<HubTransaction> {
    const k = `${tx.providerId}\u0000${tx.providerTxId}`;
    if (this.txs.has(k)) throw new DuplicateTransactionError();
    this.txs.set(k, clone(tx));
    return clone(tx);
  }
  async updateTx(id: string, patch: Partial<Pick<HubTransaction, 'status' | 'response' | 'walletTxId'>>): Promise<void> {
    for (const t of this.txs.values()) {
      if (t.id === id) Object.assign(t, clone(patch));
    }
  }

  async findRound(providerId: string, providerRoundId: string): Promise<HubRound | null> {
    const r = this.rounds.get(`${providerId}\u0000${providerRoundId}`);
    return r ? clone(r) : null;
  }
  async saveRound(r: HubRound): Promise<HubRound> {
    this.rounds.set(`${r.providerId}\u0000${r.providerRoundId}`, clone(r));
    return clone(r);
  }

  async aggregate(filter: ReportFilter): Promise<ReportRow[]> {
    const rows = new Map<string, ReportRow>();
    for (const r of this.rounds.values()) {
      if (filter.from && r.createdAt < filter.from) continue;
      if (filter.to && r.createdAt >= filter.to) continue;
      if (filter.operatorId && r.operatorId !== filter.operatorId) continue;
      if (filter.providerId && r.providerId !== filter.providerId) continue;
      const k = `${r.providerId}\u0000${r.gameId}`;
      const row = rows.get(k) ?? { providerId: r.providerId, gameId: r.gameId, bets: 0n, wins: 0n, rounds: 0, openRounds: 0 };
      row.bets += r.betAmount;
      row.wins += r.winAmount;
      row.rounds += 1;
      if (r.status === 'open') row.openRounds += 1;
      rows.set(k, row);
    }
    return [...rows.values()];
  }
}

export class InMemoryRemoteOperatorRepository implements RemoteOperatorRepository {
  private readonly items = new Map<string, RemoteOperator>();
  async list(): Promise<RemoteOperator[]> {
    return [...this.items.values()].map(clone);
  }
  async get(id: string): Promise<RemoteOperator | null> {
    const r = this.items.get(id);
    return r ? clone(r) : null;
  }
  async save(r: RemoteOperator): Promise<RemoteOperator> {
    this.items.set(r.id, clone(r));
    return clone(r);
  }
}

export function createInMemoryRepositories(): HubRepositories {
  return {
    catalog: new InMemoryCatalogRepository(),
    sessions: new InMemorySessionRepository(),
    txs: new InMemoryWalletTxRepository(),
    remoteOperators: new InMemoryRemoteOperatorRepository(),
  };
}
