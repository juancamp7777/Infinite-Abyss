import type { TideFlow, TideRepository, TideSession, TideVersion } from '../domain/types';

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryTideRepository implements TideRepository {
  private readonly flows = new Map<string, TideFlow>();
  private readonly versions = new Map<string, TideVersion>();
  private readonly sessions = new Map<string, TideSession>();

  async listFlows(operatorId: string) {
    return [...this.flows.values()].filter((f) => f.operatorId === operatorId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }
  async findFlow(operatorId: string, id: string) {
    const f = this.flows.get(id);
    return f && f.operatorId === operatorId ? clone(f) : null;
  }
  async saveFlow(f: TideFlow) {
    this.flows.set(f.id, clone(f));
    return clone(f);
  }
  async deleteFlow(operatorId: string, id: string) {
    const f = this.flows.get(id);
    return !!f && f.operatorId === operatorId && this.flows.delete(id);
  }
  async saveVersion(v: TideVersion) {
    const key = `${v.flowId}:${v.version}`;
    if (this.versions.has(key)) throw Object.assign(new Error('Versión duplicada'), { code: 'DUPLICATE_VERSION' });
    this.versions.set(key, clone(v));
    return clone(v);
  }
  async findVersion(flowId: string, version: number) {
    const v = this.versions.get(`${flowId}:${version}`);
    return v ? clone(v) : null;
  }
  async findSession(conversationId: string) {
    const s = this.sessions.get(conversationId);
    return s ? clone(s) : null;
  }
  async saveSession(s: TideSession) {
    this.sessions.set(s.conversationId, clone(s));
    return clone(s);
  }
  async deleteSession(conversationId: string) {
    this.sessions.delete(conversationId);
  }
  async dueSessions(now: Date, limit: number) {
    return [...this.sessions.values()].filter((s) => s.status === 'waiting' && s.expiresAt && s.expiresAt <= now).slice(0, limit).map(clone);
  }
}
