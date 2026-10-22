/* Repositorios Prisma del Hub. Se tipa el cliente de forma estructural para no depender del cliente
 * generado (los modelos Hub* viven en prisma/modules/hub.prisma y se fusionan en la integración). */
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = {
  findUnique(args: any): Promise<any>;
  findFirst(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  create(args: any): Promise<any>;
  upsert(args: any): Promise<any>;
  update(args: any): Promise<any>;
  updateMany(args: any): Promise<any>;
  deleteMany(args: any): Promise<{ count: number }>;
  groupBy(args: any): Promise<any[]>;
};

export interface HubPrismaClient {
  hubProvider: Delegate;
  hubGame: Delegate;
  hubOperatorGame: Delegate;
  hubSession: Delegate;
  hubRound: Delegate;
  hubTransaction: Delegate;
  hubRemoteOperator: Delegate;
}

export function isHubPrismaClient(v: unknown): v is HubPrismaClient {
  return !!v && typeof v === 'object' && 'hubGame' in v && 'hubTransaction' in v;
}

const isUniqueViolation = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

const toProvider = (r: any): Provider => ({
  id: r.id,
  name: r.name,
  type: r.type,
  status: r.status,
  config: (r.config ?? {}) as Record<string, unknown>,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toGame = (r: any): Game => ({
  id: r.id,
  providerId: r.providerId,
  externalId: r.externalId,
  title: r.title,
  category: r.category,
  mechanic: r.mechanic,
  rtp: Number(r.rtp),
  volatility: r.volatility,
  images: r.images,
  tags: r.tags ?? [],
  allowedMarkets: r.allowedMarkets ?? [],
  status: r.status,
  hasDemo: r.hasDemo,
  releasedAt: r.releasedAt,
  popularity: r.popularity,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toSession = (r: any): HubSession => ({
  id: r.id,
  token: r.token,
  operatorId: r.operatorId,
  playerId: r.playerId,
  providerId: r.providerId,
  gameId: r.gameId,
  currency: r.currency,
  mode: r.mode,
  walletKind: r.walletKind,
  remoteOperatorId: opt(r.remoteOperatorId),
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
});

const toRound = (r: any): HubRound => ({
  id: r.id,
  providerId: r.providerId,
  providerRoundId: r.providerRoundId,
  operatorId: r.operatorId,
  playerId: r.playerId,
  gameId: r.gameId,
  currency: r.currency,
  sessionId: r.sessionId,
  betAmount: BigInt(r.betAmount),
  winAmount: BigInt(r.winAmount),
  status: r.status,
  createdAt: r.createdAt,
  settledAt: opt(r.settledAt),
});

const toTx = (r: any): HubTransaction => ({
  id: r.id,
  providerId: r.providerId,
  providerTxId: r.providerTxId,
  type: r.type,
  status: r.status,
  operatorId: r.operatorId,
  playerId: r.playerId,
  currency: r.currency,
  amount: BigInt(r.amount),
  providerRoundId: opt(r.providerRoundId),
  gameId: opt(r.gameId),
  sessionId: opt(r.sessionId),
  referenceTxId: opt(r.referenceTxId),
  walletTxId: opt(r.walletTxId),
  fingerprint: r.fingerprint,
  response: opt(r.response),
  createdAt: r.createdAt,
});

export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly db: HubPrismaClient) {}

  async listProviders(): Promise<Provider[]> {
    return (await this.db.hubProvider.findMany({ orderBy: { name: 'asc' } })).map(toProvider);
  }
  async getProvider(id: string): Promise<Provider | null> {
    const r = await this.db.hubProvider.findUnique({ where: { id } });
    return r ? toProvider(r) : null;
  }
  async saveProvider(p: Provider): Promise<Provider> {
    const data = { name: p.name, type: p.type, status: p.status, config: p.config };
    return toProvider(await this.db.hubProvider.upsert({ where: { id: p.id }, create: { id: p.id, ...data }, update: data }));
  }
  async deleteProvider(id: string): Promise<boolean> {
    return (await this.db.hubProvider.deleteMany({ where: { id } })).count > 0;
  }

  async listGames(filter: { providerId?: string; category?: GameCategory } = {}): Promise<Game[]> {
    const where: Record<string, unknown> = {};
    if (filter.providerId) where.providerId = filter.providerId;
    if (filter.category) where.category = filter.category;
    return (await this.db.hubGame.findMany({ where })).map(toGame);
  }
  async getGame(id: string): Promise<Game | null> {
    const r = await this.db.hubGame.findUnique({ where: { id } });
    return r ? toGame(r) : null;
  }
  async saveGame(g: Game): Promise<Game> {
    const data = {
      providerId: g.providerId,
      externalId: g.externalId,
      title: g.title,
      category: g.category,
      mechanic: g.mechanic,
      rtp: g.rtp,
      volatility: g.volatility,
      images: g.images,
      tags: g.tags,
      allowedMarkets: g.allowedMarkets,
      status: g.status,
      hasDemo: g.hasDemo,
      releasedAt: g.releasedAt,
      popularity: g.popularity,
    };
    return toGame(await this.db.hubGame.upsert({ where: { id: g.id }, create: { id: g.id, ...data }, update: data }));
  }
  async deleteGame(id: string): Promise<boolean> {
    return (await this.db.hubGame.deleteMany({ where: { id } })).count > 0;
  }

  async listOperatorGames(operatorId: string): Promise<OperatorGame[]> {
    return (await this.db.hubOperatorGame.findMany({ where: { operatorId } })).map((r: any) => ({
      operatorId: r.operatorId,
      gameId: r.gameId,
      enabled: r.enabled,
      sortOrder: r.sortOrder,
    }));
  }
  async saveOperatorGame(og: OperatorGame): Promise<OperatorGame> {
    await this.db.hubOperatorGame.upsert({
      where: { operatorId_gameId: { operatorId: og.operatorId, gameId: og.gameId } },
      create: og,
      update: { enabled: og.enabled, sortOrder: og.sortOrder },
    });
    return { ...og };
  }
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db: HubPrismaClient) {}
  async create(s: HubSession): Promise<HubSession> {
    return toSession(await this.db.hubSession.create({ data: { ...s, remoteOperatorId: s.remoteOperatorId ?? null } }));
  }
  async findByToken(token: string): Promise<HubSession | null> {
    const r = await this.db.hubSession.findUnique({ where: { token } });
    return r ? toSession(r) : null;
  }
  async findById(id: string): Promise<HubSession | null> {
    const r = await this.db.hubSession.findUnique({ where: { id } });
    return r ? toSession(r) : null;
  }
  async touch(id: string, expiresAt: Date): Promise<void> {
    await this.db.hubSession.updateMany({ where: { id }, data: { expiresAt } });
  }
}

export class PrismaWalletTxRepository implements WalletTxRepository {
  constructor(private readonly db: HubPrismaClient) {}

  async findTx(providerId: string, providerTxId: string): Promise<HubTransaction | null> {
    const r = await this.db.hubTransaction.findUnique({ where: { providerId_providerTxId: { providerId, providerTxId } } });
    return r ? toTx(r) : null;
  }
  async insertTx(tx: HubTransaction): Promise<HubTransaction> {
    try {
      const data: Record<string, unknown> = { ...tx };
      for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
      return toTx(await this.db.hubTransaction.create({ data }));
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateTransactionError();
      throw e;
    }
  }
  async updateTx(id: string, patch: Partial<Pick<HubTransaction, 'status' | 'response' | 'walletTxId'>>): Promise<void> {
    await this.db.hubTransaction.update({ where: { id }, data: patch });
  }

  async findRound(providerId: string, providerRoundId: string): Promise<HubRound | null> {
    const r = await this.db.hubRound.findUnique({ where: { providerId_providerRoundId: { providerId, providerRoundId } } });
    return r ? toRound(r) : null;
  }
  async saveRound(r: HubRound): Promise<HubRound> {
    const data = {
      operatorId: r.operatorId,
      playerId: r.playerId,
      gameId: r.gameId,
      currency: r.currency,
      sessionId: r.sessionId,
      betAmount: r.betAmount,
      winAmount: r.winAmount,
      status: r.status,
      settledAt: r.settledAt ?? null,
    };
    return toRound(
      await this.db.hubRound.upsert({
        where: { providerId_providerRoundId: { providerId: r.providerId, providerRoundId: r.providerRoundId } },
        create: { id: r.id, providerId: r.providerId, providerRoundId: r.providerRoundId, createdAt: r.createdAt, ...data },
        update: data,
      }),
    );
  }

  async aggregate(filter: ReportFilter): Promise<ReportRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.operatorId) where.operatorId = filter.operatorId;
    if (filter.providerId) where.providerId = filter.providerId;
    if (filter.from || filter.to) {
      where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lt: filter.to } : {}) };
    }
    const [all, open] = await Promise.all([
      this.db.hubRound.groupBy({ by: ['providerId', 'gameId'], where, _sum: { betAmount: true, winAmount: true }, _count: { _all: true } }),
      this.db.hubRound.groupBy({ by: ['providerId', 'gameId'], where: { ...where, status: 'open' }, _count: { _all: true } }),
    ]);
    const openMap = new Map(open.map((o: any) => [`${o.providerId}\u0000${o.gameId}`, Number(o._count._all)]));
    return all.map((g: any) => ({
      providerId: g.providerId,
      gameId: g.gameId,
      bets: BigInt(g._sum.betAmount ?? 0),
      wins: BigInt(g._sum.winAmount ?? 0),
      rounds: Number(g._count._all),
      openRounds: openMap.get(`${g.providerId}\u0000${g.gameId}`) ?? 0,
    }));
  }
}

export class PrismaRemoteOperatorRepository implements RemoteOperatorRepository {
  constructor(private readonly db: HubPrismaClient) {}
  async list(): Promise<RemoteOperator[]> {
    return (await this.db.hubRemoteOperator.findMany({ orderBy: { name: 'asc' } })).map((r: any) => ({ ...r }));
  }
  async get(id: string): Promise<RemoteOperator | null> {
    const r = await this.db.hubRemoteOperator.findUnique({ where: { id } });
    return r ? { ...r } : null;
  }
  async save(r: RemoteOperator): Promise<RemoteOperator> {
    const data = { name: r.name, walletCallbackUrl: r.walletCallbackUrl, status: r.status, currencies: r.currencies };
    return { ...(await this.db.hubRemoteOperator.upsert({ where: { id: r.id }, create: { id: r.id, createdAt: r.createdAt, ...data }, update: data })) };
  }
}

export function createPrismaRepositories(db: HubPrismaClient): HubRepositories {
  return {
    catalog: new PrismaCatalogRepository(db),
    sessions: new PrismaSessionRepository(db),
    txs: new PrismaWalletTxRepository(db),
    remoteOperators: new PrismaRemoteOperatorRepository(db),
  };
}
