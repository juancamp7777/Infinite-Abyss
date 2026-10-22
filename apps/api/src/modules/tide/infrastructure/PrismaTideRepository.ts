import type { FlowGraph } from '../domain/graph';
import type { TideFlow, TideRepository, TideSession, TideVersion } from '../domain/types';

/** Subconjunto del PrismaClient usado (evita depender de los tipos generados). */
interface Delegate {
  findFirst(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  upsert(args: any): Promise<any>;
  create(args: any): Promise<any>;
  deleteMany(args: any): Promise<{ count: number }>;
}
export interface TidePrismaLike {
  tideFlow: Delegate;
  tideFlowVersion: Delegate;
  tideSession: Delegate;
}

const flow = (r: any): TideFlow => {
  const f = { ...r, draft: r.draft as FlowGraph };
  if (f.publishedVersion === null) delete f.publishedVersion;
  return f;
};
const session = (r: any): TideSession => {
  const s = { ...r, vars: (r.vars ?? {}) as Record<string, string>, trace: (r.trace ?? []) as string[] };
  if (s.expiresAt === null) delete s.expiresAt;
  return s;
};

export class PrismaTideRepository implements TideRepository {
  constructor(private readonly db: TidePrismaLike) {}

  async listFlows(operatorId: string) {
    return (await this.db.tideFlow.findMany({ where: { operatorId }, orderBy: { createdAt: 'asc' } })).map(flow);
  }

  async findFlow(operatorId: string, id: string) {
    const r = await this.db.tideFlow.findFirst({ where: { id, operatorId } });
    return r ? flow(r) : null;
  }

  async saveFlow(f: TideFlow) {
    const data = { ...f, draft: f.draft as object, publishedVersion: f.publishedVersion ?? null };
    const { id, ...rest } = data;
    return flow(await this.db.tideFlow.upsert({ where: { id }, create: data, update: rest }));
  }

  async deleteFlow(operatorId: string, id: string) {
    const n = (await this.db.tideFlow.deleteMany({ where: { id, operatorId } })).count;
    if (n) {
      await this.db.tideFlowVersion.deleteMany({ where: { flowId: id } });
      await this.db.tideSession.deleteMany({ where: { flowId: id } });
    }
    return n > 0;
  }

  async saveVersion(v: TideVersion) {
    try {
      const r = await this.db.tideFlowVersion.create({ data: { ...v, graph: v.graph as object } });
      return { ...r, graph: r.graph as FlowGraph } as TideVersion;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw Object.assign(new Error('Versión duplicada'), { code: 'DUPLICATE_VERSION' });
      throw e;
    }
  }

  async findVersion(flowId: string, version: number) {
    const r = await this.db.tideFlowVersion.findUnique({ where: { flowId_version: { flowId, version } } });
    return r ? ({ ...r, graph: r.graph as FlowGraph } as TideVersion) : null;
  }

  async findSession(conversationId: string) {
    const r = await this.db.tideSession.findUnique({ where: { conversationId } });
    return r ? session(r) : null;
  }

  async saveSession(s: TideSession) {
    const data = { ...s, expiresAt: s.expiresAt ?? null };
    const { conversationId, ...rest } = data;
    return session(await this.db.tideSession.upsert({ where: { conversationId }, create: data, update: rest }));
  }

  async deleteSession(conversationId: string) {
    await this.db.tideSession.deleteMany({ where: { conversationId } });
  }

  async dueSessions(now: Date, limit: number) {
    return (await this.db.tideSession.findMany({ where: { status: 'waiting', expiresAt: { lte: now } }, orderBy: { expiresAt: 'asc' }, take: limit })).map(session);
  }
}
