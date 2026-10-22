import type { CrmNote, CrmProfile, CrmSegment, CrmTicket, TimelineEntry, TicketStatus } from '../domain/types';

export interface TicketFilter {
  status?: TicketStatus;
  playerId?: string;
  assignedTo?: string;
}

export interface CrmRepository {
  getProfile(operatorId: string, playerId: string): Promise<CrmProfile | null>;
  saveProfile(profile: CrmProfile): Promise<void>;
  listProfiles(operatorId: string): Promise<CrmProfile[]>;
  /** true si la clave era nueva (se reserva); false si el evento ya se procesó. */
  claimEvent(key: string): Promise<boolean>;
  /** Libera la clave (para reintentar si el procesamiento falló). */
  releaseEvent(key: string): Promise<void>;

  addNote(note: CrmNote): Promise<void>;
  listNotes(operatorId: string, playerId: string): Promise<CrmNote[]>;

  addTimeline(entry: TimelineEntry): Promise<void>;
  /** Más recientes primero. */
  listTimeline(operatorId: string, playerId: string, limit: number): Promise<TimelineEntry[]>;

  saveTicket(ticket: CrmTicket): Promise<void>;
  getTicket(operatorId: string, id: string): Promise<CrmTicket | null>;
  listTickets(operatorId: string, filter: TicketFilter): Promise<CrmTicket[]>;

  saveSegment(segment: CrmSegment): Promise<void>;
  getSegment(operatorId: string, id: string): Promise<CrmSegment | null>;
  listSegments(operatorId: string): Promise<CrmSegment[]>;
  deleteSegment(operatorId: string, id: string): Promise<boolean>;
}

const clone = <T>(x: T): T => structuredClone(x);
const byRecent = <T extends { createdAt?: string; at?: string }>(a: T, b: T): number =>
  Date.parse(b.createdAt ?? b.at ?? '') - Date.parse(a.createdAt ?? a.at ?? '');

export class InMemoryCrmRepository implements CrmRepository {
  private profiles = new Map<string, CrmProfile>();
  private events = new Set<string>();
  private notes: CrmNote[] = [];
  private timeline: TimelineEntry[] = [];
  private tickets = new Map<string, CrmTicket>();
  private segments = new Map<string, CrmSegment>();

  private pk = (op: string, id: string) => `${op}\u0000${id}`;

  async getProfile(op: string, playerId: string) {
    const p = this.profiles.get(this.pk(op, playerId));
    return p ? clone(p) : null;
  }
  async saveProfile(profile: CrmProfile) {
    this.profiles.set(this.pk(profile.operatorId, profile.playerId), clone(profile));
  }
  async listProfiles(op: string) {
    return [...this.profiles.values()].filter((p) => p.operatorId === op).map(clone);
  }
  async claimEvent(key: string) {
    if (this.events.has(key)) return false;
    this.events.add(key);
    return true;
  }
  async releaseEvent(key: string) {
    this.events.delete(key);
  }

  async addNote(note: CrmNote) {
    this.notes.push(clone(note));
  }
  async listNotes(op: string, playerId: string) {
    return this.notes.filter((n) => n.operatorId === op && n.playerId === playerId).sort(byRecent).map(clone);
  }

  async addTimeline(entry: TimelineEntry) {
    this.timeline.push(clone(entry));
  }
  async listTimeline(op: string, playerId: string, limit: number) {
    return this.timeline
      .filter((t) => t.operatorId === op && t.playerId === playerId)
      .sort(byRecent)
      .slice(0, limit)
      .map(clone);
  }

  async saveTicket(t: CrmTicket) {
    this.tickets.set(this.pk(t.operatorId, t.id), clone(t));
  }
  async getTicket(op: string, id: string) {
    const t = this.tickets.get(this.pk(op, id));
    return t ? clone(t) : null;
  }
  async listTickets(op: string, f: TicketFilter) {
    return [...this.tickets.values()]
      .filter(
        (t) =>
          t.operatorId === op &&
          (!f.status || t.status === f.status) &&
          (!f.playerId || t.playerId === f.playerId) &&
          (!f.assignedTo || t.assignedTo === f.assignedTo),
      )
      .sort(byRecent)
      .map(clone);
  }

  async saveSegment(s: CrmSegment) {
    this.segments.set(this.pk(s.operatorId, s.id), clone(s));
  }
  async getSegment(op: string, id: string) {
    const s = this.segments.get(this.pk(op, id));
    return s ? clone(s) : null;
  }
  async listSegments(op: string) {
    return [...this.segments.values()].filter((s) => s.operatorId === op).sort(byRecent).map(clone);
  }
  async deleteSegment(op: string, id: string) {
    return this.segments.delete(this.pk(op, id));
  }
}
