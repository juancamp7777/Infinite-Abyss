/** Repositorios genéricos (documento JSON + columnas de índice). InMemory para pruebas, Prisma para producción. */
import type {
  Affiliate, Attribution, Campaign, Consent, InboxMessage, Journey, JourneyRun, OperatorBrand, PlayerState,
  PostbackLog, PushSubscription, SendLog, Template,
} from '../domain/types';

export interface StoreQuery {
  operatorId?: string;
  playerId?: string;
  refId?: string;
  status?: string;
  /** dueAt < dueBefore (ISO). */
  dueBefore?: string;
  limit?: number;
}

export interface Store<T extends { id: string; operatorId: string }> {
  get(id: string): Promise<T | null>;
  put(item: T): Promise<T>;
  /** Inserta solo si no existe (true = insertado). Sirve para dedupe/idempotencia. */
  putIfAbsent(item: T): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  /** Más recientes primero. */
  list(q?: StoreQuery): Promise<T[]>;
}

export interface IndexFields {
  playerId?: string;
  refId?: string;
  status?: string;
  dueAt?: string;
}
type Indexer<T> = (item: T) => IndexFields;

export class InMemoryStore<T extends { id: string; operatorId: string }> implements Store<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly index: Indexer<T> = () => ({})) {}

  async get(id: string): Promise<T | null> {
    const v = this.items.get(id);
    return v ? structuredClone(v) : null;
  }
  async put(item: T): Promise<T> {
    this.items.set(item.id, structuredClone(item));
    return item;
  }
  async putIfAbsent(item: T): Promise<boolean> {
    if (this.items.has(item.id)) return false;
    this.items.set(item.id, structuredClone(item));
    return true;
  }
  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
  async list(q: StoreQuery = {}): Promise<T[]> {
    const out: T[] = [];
    for (const item of [...this.items.values()].reverse()) {
      if (q.operatorId && item.operatorId !== q.operatorId) continue;
      const ix = this.index(item);
      if (q.playerId && ix.playerId !== q.playerId) continue;
      if (q.refId && ix.refId !== q.refId) continue;
      if (q.status && ix.status !== q.status) continue;
      if (q.dueBefore && !(ix.dueAt && ix.dueAt < q.dueBefore)) continue;
      out.push(structuredClone(item));
      if (q.limit && out.length >= q.limit) break;
    }
    return out;
  }
}

interface PrismaDelegate {
  findUnique(args: unknown): Promise<{ data: unknown } | null>;
  upsert(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
  delete(args: unknown): Promise<unknown>;
  findMany(args: unknown): Promise<Array<{ data: unknown }>>;
}

export class PrismaStore<T extends { id: string; operatorId: string }> implements Store<T> {
  constructor(private readonly delegate: PrismaDelegate, private readonly index: Indexer<T> = () => ({})) {}

  private row(item: T) {
    const ix = this.index(item);
    return {
      operatorId: item.operatorId,
      playerId: ix.playerId ?? null,
      refId: ix.refId ?? null,
      status: ix.status ?? null,
      dueAt: ix.dueAt ? new Date(ix.dueAt) : null,
      data: JSON.parse(JSON.stringify(item)),
    };
  }
  async get(id: string): Promise<T | null> {
    const r = await this.delegate.findUnique({ where: { id } });
    return r ? (r.data as T) : null;
  }
  async put(item: T): Promise<T> {
    const row = this.row(item);
    await this.delegate.upsert({ where: { id: item.id }, create: { id: item.id, ...row }, update: row });
    return item;
  }
  async putIfAbsent(item: T): Promise<boolean> {
    try {
      await this.delegate.create({ data: { id: item.id, ...this.row(item) } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }
  async delete(id: string): Promise<boolean> {
    try {
      await this.delegate.delete({ where: { id } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') return false;
      throw e;
    }
  }
  async list(q: StoreQuery = {}): Promise<T[]> {
    const where: Record<string, unknown> = {};
    if (q.operatorId) where.operatorId = q.operatorId;
    if (q.playerId) where.playerId = q.playerId;
    if (q.refId) where.refId = q.refId;
    if (q.status) where.status = q.status;
    if (q.dueBefore) where.dueAt = { lt: new Date(q.dueBefore) };
    const rows = await this.delegate.findMany({ where, orderBy: { createdAt: 'desc' }, ...(q.limit ? { take: q.limit } : {}) });
    return rows.map((r) => r.data as T);
  }
}

export interface MarketingRepos {
  brands: Store<OperatorBrand>;
  templates: Store<Template>;
  campaigns: Store<Campaign>;
  journeys: Store<Journey>;
  runs: Store<JourneyRun>;
  affiliates: Store<Affiliate>;
  attributions: Store<Attribution>;
  postbacks: Store<PostbackLog>;
  consents: Store<Consent>;
  sends: Store<SendLog>;
  inbox: Store<InboxMessage>;
  pushSubs: Store<PushSubscription>;
  players: Store<PlayerState>;
}

export function createInMemoryRepos(): MarketingRepos {
  return {
    brands: new InMemoryStore(),
    templates: new InMemoryStore(),
    campaigns: new InMemoryStore<Campaign>((c) => ({ status: c.status, dueAt: c.status === 'scheduled' ? c.scheduledAt : undefined })),
    journeys: new InMemoryStore<Journey>((j) => ({ status: j.status })),
    runs: new InMemoryStore<JourneyRun>((r) => ({ playerId: r.playerId, refId: r.journeyId, status: r.status, dueAt: r.dueAt })),
    affiliates: new InMemoryStore(),
    attributions: new InMemoryStore<Attribution>((a) => ({ playerId: a.playerId })),
    postbacks: new InMemoryStore<PostbackLog>((p) => ({ playerId: p.playerId, status: p.status, dueAt: p.nextAttemptAt })),
    consents: new InMemoryStore<Consent>((c) => ({ playerId: c.playerId })),
    sends: new InMemoryStore<SendLog>((s) => ({ playerId: s.playerId, refId: s.refId, status: s.status })),
    inbox: new InMemoryStore<InboxMessage>((m) => ({ playerId: m.playerId, status: m.readAt ? 'read' : 'unread' })),
    pushSubs: new InMemoryStore<PushSubscription>((s) => ({ playerId: s.playerId })),
    players: new InMemoryStore<PlayerState>((p) => ({ playerId: p.playerId })),
  };
}

/** `prisma` es un PrismaClient generado con los modelos Mkt* (prisma/modules/marketing.prisma fusionado). */
export function createPrismaRepos(prisma: unknown): MarketingRepos {
  const p = prisma as Record<string, PrismaDelegate>;
  const mk = <T extends { id: string; operatorId: string }>(name: string, ix?: Indexer<T>) => new PrismaStore<T>(p[name], ix);
  return {
    brands: mk('mktOperatorBrand'),
    templates: mk('mktTemplate'),
    campaigns: mk<Campaign>('mktCampaign', (c) => ({ status: c.status, dueAt: c.status === 'scheduled' ? c.scheduledAt : undefined })),
    journeys: mk<Journey>('mktJourney', (j) => ({ status: j.status })),
    runs: mk<JourneyRun>('mktJourneyRun', (r) => ({ playerId: r.playerId, refId: r.journeyId, status: r.status, dueAt: r.dueAt })),
    affiliates: mk('mktAffiliate'),
    attributions: mk<Attribution>('mktAttribution', (a) => ({ playerId: a.playerId })),
    postbacks: mk<PostbackLog>('mktPostback', (x) => ({ playerId: x.playerId, status: x.status, dueAt: x.nextAttemptAt })),
    consents: mk<Consent>('mktConsent', (c) => ({ playerId: c.playerId })),
    sends: mk<SendLog>('mktSendLog', (s) => ({ playerId: s.playerId, refId: s.refId, status: s.status })),
    inbox: mk<InboxMessage>('mktInboxMessage', (m) => ({ playerId: m.playerId, status: m.readAt ? 'read' : 'unread' })),
    pushSubs: mk<PushSubscription>('mktPushSubscription', (s) => ({ playerId: s.playerId })),
    players: mk<PlayerState>('mktPlayerState', (s) => ({ playerId: s.playerId })),
  };
}
