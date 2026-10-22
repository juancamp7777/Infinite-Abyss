import type { CrmRepository, TicketFilter } from '../application/CrmRepository';
import type { CrmNote, CrmProfile, CrmSegment, CrmTicket, TimelineEntry, TicketMessage, TicketPriority, TicketStatus } from '../domain/types';
import type { Rule } from '../../shared/ports/SegmentPort';

/** Subconjunto del PrismaClient usado (evita depender de los tipos generados tras la fusión de schemas). */
interface Delegate {
  findUnique(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  upsert(args: any): Promise<any>;
  create(args: any): Promise<any>;
  deleteMany(args: any): Promise<{ count: number }>;
  delete(args: any): Promise<any>;
}
export interface CrmPrismaLike {
  crmPlayerProfile: Delegate;
  crmProcessedEvent: Delegate;
  crmNote: Delegate;
  crmTimelineEntry: Delegate;
  crmTicket: Delegate;
  crmSegment: Delegate;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

function serializeProfile(p: CrmProfile): Record<string, unknown> {
  const big = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));
  return {
    ...p,
    depositsTotal: p.depositsTotal.toString(),
    withdrawalsTotal: p.withdrawalsTotal.toString(),
    totalWagered: p.totalWagered.toString(),
    totalWon: p.totalWon.toString(),
    games: big(p.games),
    categories: big(p.categories),
  };
}

function reviveProfile(d: any): CrmProfile {
  const big = (m: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, BigInt(v)])) as Record<string, bigint>;
  return {
    ...d,
    depositsTotal: BigInt(d.depositsTotal ?? 0),
    withdrawalsTotal: BigInt(d.withdrawalsTotal ?? 0),
    totalWagered: BigInt(d.totalWagered ?? 0),
    totalWon: BigInt(d.totalWon ?? 0),
    games: big(d.games),
    categories: big(d.categories),
    activeDays: d.activeDays ?? [],
    tags: d.tags ?? [],
  };
}

const toNote = (r: any): CrmNote => ({
  id: r.id, operatorId: r.operatorId, playerId: r.playerId, authorId: r.authorId, text: r.text, createdAt: iso(r.createdAt),
});

const toTimeline = (r: any): TimelineEntry => ({
  id: r.id, operatorId: r.operatorId, playerId: r.playerId, type: r.type, title: r.title,
  ...(r.data ? { data: r.data } : {}), at: iso(r.at),
});

const toTicket = (r: any): CrmTicket => ({
  id: r.id, operatorId: r.operatorId, playerId: r.playerId, subject: r.subject,
  status: r.status as TicketStatus, priority: r.priority as TicketPriority,
  ...(r.assignedTo ? { assignedTo: r.assignedTo } : {}),
  messages: (r.messages ?? []) as TicketMessage[], createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

const toSegment = (r: any): CrmSegment => ({
  id: r.id, operatorId: r.operatorId, name: r.name, ...(r.description ? { description: r.description } : {}),
  rule: r.rule as Rule, ...(r.createdBy ? { createdBy: r.createdBy } : {}), createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

export class PrismaCrmRepository implements CrmRepository {
  constructor(private readonly db: CrmPrismaLike) {}

  async getProfile(operatorId: string, playerId: string) {
    const r = await this.db.crmPlayerProfile.findUnique({ where: { operatorId_playerId: { operatorId, playerId } } });
    return r ? reviveProfile(r.data) : null;
  }

  async saveProfile(p: CrmProfile) {
    const data = serializeProfile(p);
    const lastActivityAt = p.lastActivityAt ? new Date(p.lastActivityAt) : null;
    await this.db.crmPlayerProfile.upsert({
      where: { operatorId_playerId: { operatorId: p.operatorId, playerId: p.playerId } },
      create: { operatorId: p.operatorId, playerId: p.playerId, data, lastActivityAt },
      update: { data, lastActivityAt },
    });
  }

  async listProfiles(operatorId: string) {
    const rows = await this.db.crmPlayerProfile.findMany({ where: { operatorId } });
    return rows.map((r) => reviveProfile(r.data));
  }

  async claimEvent(key: string) {
    try {
      await this.db.crmProcessedEvent.create({ data: { key } });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }

  async releaseEvent(key: string) {
    await this.db.crmProcessedEvent.deleteMany({ where: { key } });
  }

  async addNote(n: CrmNote) {
    await this.db.crmNote.create({ data: { id: n.id, operatorId: n.operatorId, playerId: n.playerId, authorId: n.authorId, text: n.text, createdAt: new Date(n.createdAt) } });
  }

  async listNotes(operatorId: string, playerId: string) {
    return (await this.db.crmNote.findMany({ where: { operatorId, playerId }, orderBy: { createdAt: 'desc' } })).map(toNote);
  }

  async addTimeline(e: TimelineEntry) {
    await this.db.crmTimelineEntry.create({
      data: { id: e.id, operatorId: e.operatorId, playerId: e.playerId, type: e.type, title: e.title, ...(e.data ? { data: e.data } : {}), at: new Date(e.at) },
    });
  }

  async listTimeline(operatorId: string, playerId: string, limit: number) {
    const rows = await this.db.crmTimelineEntry.findMany({ where: { operatorId, playerId }, orderBy: { at: 'desc' }, take: limit });
    return rows.map(toTimeline);
  }

  async saveTicket(t: CrmTicket) {
    const fields = { subject: t.subject, status: t.status, priority: t.priority, assignedTo: t.assignedTo ?? null, messages: t.messages as unknown as object };
    await this.db.crmTicket.upsert({
      where: { id: t.id },
      create: { id: t.id, operatorId: t.operatorId, playerId: t.playerId, createdAt: new Date(t.createdAt), ...fields },
      update: fields,
    });
  }

  async getTicket(operatorId: string, id: string) {
    const r = await this.db.crmTicket.findUnique({ where: { id } });
    return r && r.operatorId === operatorId ? toTicket(r) : null;
  }

  async listTickets(operatorId: string, f: TicketFilter) {
    const rows = await this.db.crmTicket.findMany({
      where: { operatorId, ...(f.status ? { status: f.status } : {}), ...(f.playerId ? { playerId: f.playerId } : {}), ...(f.assignedTo ? { assignedTo: f.assignedTo } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return rows.map(toTicket);
  }

  async saveSegment(s: CrmSegment) {
    const fields = { name: s.name, description: s.description ?? null, rule: s.rule as unknown as object };
    await this.db.crmSegment.upsert({
      where: { id: s.id },
      create: { id: s.id, operatorId: s.operatorId, createdBy: s.createdBy ?? null, createdAt: new Date(s.createdAt), ...fields },
      update: fields,
    });
  }

  async getSegment(operatorId: string, id: string) {
    const r = await this.db.crmSegment.findUnique({ where: { id } });
    return r && r.operatorId === operatorId ? toSegment(r) : null;
  }

  async listSegments(operatorId: string) {
    return (await this.db.crmSegment.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' } })).map(toSegment);
  }

  async deleteSegment(operatorId: string, id: string) {
    const r = await this.db.crmSegment.deleteMany({ where: { id, operatorId } });
    return r.count > 0;
  }
}
