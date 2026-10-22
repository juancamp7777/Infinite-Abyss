import { randomUUID } from 'crypto';
import type { DomainEvents, DomainEventName, EventBus } from '../../shared/events/EventBus';
import type { PlayerCompliancePort, PlayerComplianceStatus } from '../../shared/ports/PlayerCompliancePort';
import type { Rule, SegmentPort } from '../../shared/ports/SegmentPort';
import type { ModuleLogger } from '../../shared/module';
import { HttpError, notFound } from '../../shared/http/errors';
import { applyEvent, eventKey, newProfile } from '../domain/projection';
import { buildRfmScorer, enrich } from '../domain/rfm';
import { evaluateRule, toAttributes } from '../domain/segments';
import type {
  CrmNote, CrmPlayerView, CrmProfile, CrmSegment, CrmTicket, TimelineEntry, TicketPriority, TicketStatus,
} from '../domain/types';
import type { CrmRepository, TicketFilter } from './CrmRepository';

export type Clock = () => Date;

/* ───────────────────────── Timeline ───────────────────────── */

export interface TimelineInput {
  operatorId: string;
  playerId: string;
  type: string;
  title: string;
  data?: Record<string, unknown>;
  at?: string;
}

/** Servicio publicado como `crm.timeline` (marketing registra aquí los mensajes enviados). */
export class CrmTimelineService {
  constructor(private readonly repo: CrmRepository, private readonly clock: Clock) {}

  async add(input: TimelineInput): Promise<TimelineEntry> {
    const entry: TimelineEntry = {
      id: randomUUID(),
      operatorId: input.operatorId,
      playerId: input.playerId,
      type: input.type,
      title: input.title,
      ...(input.data ? { data: input.data } : {}),
      at: input.at ?? this.clock().toISOString(),
    };
    await this.repo.addTimeline(entry);
    return entry;
  }

  list(operatorId: string, playerId: string, limit = 100): Promise<TimelineEntry[]> {
    return this.repo.listTimeline(operatorId, playerId, limit);
  }
}

/* ───────────────────────── Perfiles ───────────────────────── */

export interface ProfileQuery {
  q?: string;
  country?: string;
  churnRisk?: string;
  tag?: string;
  segmentId?: string;
  sort?: 'ltv' | 'ggr' | 'lastActivityAt' | 'registeredAt' | 'vipScore';
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const BIG_WIN_MULTIPLIER = 100;

const EVENT_NAMES: DomainEventName[] = [
  'player.registered', 'deposit.completed', 'withdrawal.completed', 'bet.placed', 'bet.settled', 'session.started', 'login',
];

/** Servicio publicado como `crm.profiles` (getProfile). */
export class CrmProfileService {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: CrmRepository,
    private readonly timeline: CrmTimelineService,
    private readonly compliance: PlayerCompliancePort | undefined,
    private readonly clock: Clock,
    private readonly logger?: ModuleLogger,
  ) {}

  /** Suscribe los 7 eventos del bus. Devuelve la función para desuscribir todo. */
  subscribe(bus: EventBus): () => void {
    const offs = EVENT_NAMES.map((name) =>
      bus.subscribe(name, async (payload) => { await this.handle(name, payload as never); }),
    );
    return () => offs.forEach((off) => off());
  }

  /** Serializa por jugador para que dos eventos simultáneos no se pisen al leer-modificar-guardar. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }

  /** Procesa un evento una sola vez. Devuelve false si era un duplicado. */
  async handle<K extends DomainEventName>(name: K, e: DomainEvents[K]): Promise<boolean> {
    return this.serial(`${e.operatorId}:${e.playerId}`, async () => {
      const key = eventKey(name, e);
      if (!(await this.repo.claimEvent(key))) return false;
      try {
        const nowIso = this.clock().toISOString();
        const profile = (await this.repo.getProfile(e.operatorId, e.playerId)) ?? newProfile(e.operatorId, e.playerId, nowIso);
        applyEvent(profile, name, e, nowIso);
        await this.repo.saveProfile(profile);
        await this.recordTimeline(name, e);
        return true;
      } catch (err) {
        await this.repo.releaseEvent(key); // permite el reintento de la entrega
        this.logger?.error('CRM: fallo procesando evento', { event: name, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }

  private async recordTimeline<K extends DomainEventName>(name: K, e: DomainEvents[K]): Promise<void> {
    const base = { operatorId: e.operatorId, playerId: e.playerId, at: e.at };
    switch (name) {
      case 'player.registered':
        await this.timeline.add({ ...base, type: 'registered', title: 'Registro en la plataforma' });
        break;
      case 'deposit.completed': {
        const ev = e as DomainEvents['deposit.completed'];
        await this.timeline.add({ ...base, type: 'deposit', title: ev.isFirst ? 'Primer depósito' : 'Depósito', data: { amount: ev.amount.toString(), currency: ev.currency, txId: ev.txId } });
        break;
      }
      case 'withdrawal.completed': {
        const ev = e as DomainEvents['withdrawal.completed'];
        await this.timeline.add({ ...base, type: 'withdrawal', title: 'Retiro', data: { amount: ev.amount.toString(), currency: ev.currency, txId: ev.txId } });
        break;
      }
      case 'bet.settled': {
        const ev = e as DomainEvents['bet.settled'];
        if (ev.multiplier >= BIG_WIN_MULTIPLIER) {
          await this.timeline.add({ ...base, type: 'big_win', title: `Gran premio x${ev.multiplier} en ${ev.gameId}`, data: { win: ev.win.toString(), gameId: ev.gameId, roundId: ev.roundId } });
        }
        break;
      }
      default:
        break; // apuestas, sesiones y logins no se listan: serían ruido en la línea de tiempo
    }
  }

  private async scorer(operatorId: string) {
    const now = this.clock();
    const all = await this.repo.listProfiles(operatorId);
    return { now, all, scorer: buildRfmScorer(all, now) };
  }

  /** Perfil 360 enriquecido (LTV, GGR, favoritos, RFM, riesgo) o null. Con compliance=true añade el estado de cumplimiento. */
  async getProfile(operatorId: string, playerId: string, opts: { compliance?: boolean } = {}): Promise<(CrmPlayerView & { compliance?: PlayerComplianceStatus }) | null> {
    const profile = await this.repo.getProfile(operatorId, playerId);
    if (!profile) return null;
    const { now, scorer } = await this.scorer(operatorId);
    const view = enrich(profile, now, scorer);
    if (opts.compliance && this.compliance) {
      return { ...view, compliance: await this.compliance.getStatus(operatorId, playerId) };
    }
    return view;
  }

  /** Todas las vistas del operador (RFM calculado una sola vez). */
  async listViews(operatorId: string): Promise<CrmPlayerView[]> {
    const { now, all, scorer } = await this.scorer(operatorId);
    return all.map((p) => enrich(p, now, scorer));
  }

  async list(operatorId: string, q: ProfileQuery, segments?: CrmSegmentService): Promise<{ items: CrmPlayerView[]; total: number }> {
    let views = await this.listViews(operatorId);
    if (q.segmentId && segments) {
      const members = new Set(await segments.listPlayers(operatorId, q.segmentId));
      views = views.filter((v) => members.has(v.playerId));
    }
    const needle = q.q?.toLowerCase();
    views = views.filter(
      (v) =>
        (!needle || v.playerId.toLowerCase().includes(needle) || (v.email ?? '').toLowerCase().includes(needle)) &&
        (!q.country || v.country === q.country) &&
        (!q.churnRisk || v.churnRisk === q.churnRisk) &&
        (!q.tag || v.tags.includes(q.tag)),
    );
    const sort = q.sort ?? 'lastActivityAt';
    const dir = q.order === 'asc' ? 1 : -1;
    const keyOf = (v: CrmPlayerView): number => {
      switch (sort) {
        case 'ltv': return Number(v.ltv);
        case 'ggr': return Number(v.ggr);
        case 'vipScore': return v.vipScore;
        case 'registeredAt': return v.registeredAt ? Date.parse(v.registeredAt) : 0;
        default: return v.lastActivityAt ? Date.parse(v.lastActivityAt) : 0;
      }
    };
    views.sort((a, b) => (keyOf(a) - keyOf(b)) * dir || a.playerId.localeCompare(b.playerId));
    return { total: views.length, items: views.slice(q.offset, q.offset + q.limit) };
  }

  /* Etiquetas y notas */

  private async mutateProfile(operatorId: string, playerId: string, fn: (p: CrmProfile) => void): Promise<CrmProfile> {
    return this.serial(`${operatorId}:${playerId}`, async () => {
      const p = await this.repo.getProfile(operatorId, playerId);
      if (!p) throw notFound('Jugador sin perfil en el CRM');
      fn(p);
      p.updatedAt = this.clock().toISOString();
      await this.repo.saveProfile(p);
      return p;
    });
  }

  async addTag(operatorId: string, playerId: string, tag: string, actorId?: string): Promise<string[]> {
    let added = false;
    const p = await this.mutateProfile(operatorId, playerId, (pr) => {
      if (!pr.tags.includes(tag)) {
        pr.tags.push(tag);
        added = true;
      }
    });
    if (added) await this.timeline.add({ operatorId, playerId, type: 'tag', title: `Etiqueta añadida: ${tag}`, data: { tag, actorId } });
    return p.tags;
  }

  async removeTag(operatorId: string, playerId: string, tag: string, actorId?: string): Promise<string[]> {
    let removed = false;
    const p = await this.mutateProfile(operatorId, playerId, (pr) => {
      const i = pr.tags.indexOf(tag);
      if (i >= 0) {
        pr.tags.splice(i, 1);
        removed = true;
      }
    });
    if (removed) await this.timeline.add({ operatorId, playerId, type: 'tag', title: `Etiqueta quitada: ${tag}`, data: { tag, actorId } });
    return p.tags;
  }

  async addNote(operatorId: string, playerId: string, authorId: string, text: string): Promise<CrmNote> {
    if (!(await this.repo.getProfile(operatorId, playerId))) throw notFound('Jugador sin perfil en el CRM');
    const note: CrmNote = { id: randomUUID(), operatorId, playerId, authorId, text, createdAt: this.clock().toISOString() };
    await this.repo.addNote(note);
    await this.timeline.add({ operatorId, playerId, type: 'note', title: 'Nota añadida', data: { noteId: note.id, authorId }, at: note.createdAt });
    return note;
  }

  listNotes(operatorId: string, playerId: string): Promise<CrmNote[]> {
    return this.repo.listNotes(operatorId, playerId);
  }
}

/* ───────────────────────── Segmentos ───────────────────────── */

/** Servicio publicado como `crm.segments` y que implementa SegmentPort. */
export class CrmSegmentService implements SegmentPort {
  constructor(
    private readonly repo: CrmRepository,
    private readonly profiles: () => CrmProfileService,
    private readonly clock: Clock,
  ) {}

  async create(operatorId: string, input: { name: string; description?: string; rule: Rule }, createdBy?: string): Promise<CrmSegment> {
    const now = this.clock().toISOString();
    const seg: CrmSegment = {
      id: randomUUID(), operatorId, name: input.name,
      ...(input.description ? { description: input.description } : {}),
      rule: input.rule, ...(createdBy ? { createdBy } : {}), createdAt: now, updatedAt: now,
    };
    await this.repo.saveSegment(seg);
    return seg;
  }

  async update(operatorId: string, id: string, patch: { name?: string; description?: string; rule?: Rule }): Promise<CrmSegment> {
    const seg = await this.repo.getSegment(operatorId, id);
    if (!seg) throw notFound('Segmento no encontrado');
    const next: CrmSegment = { ...seg, ...patch, updatedAt: this.clock().toISOString() };
    await this.repo.saveSegment(next);
    return next;
  }

  async get(operatorId: string, id: string): Promise<CrmSegment> {
    const seg = await this.repo.getSegment(operatorId, id);
    if (!seg) throw notFound('Segmento no encontrado');
    return seg;
  }

  list(operatorId: string): Promise<CrmSegment[]> {
    return this.repo.listSegments(operatorId);
  }

  async remove(operatorId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteSegment(operatorId, id))) throw notFound('Segmento no encontrado');
  }

  /** Jugadores del operador que cumplen la regla (vistas completas). */
  async match(operatorId: string, rule: Rule): Promise<CrmPlayerView[]> {
    const now = this.clock();
    const views = await this.profiles().listViews(operatorId);
    return views.filter((v) => evaluateRule(rule, toAttributes(v), now));
  }

  /** Previsualización: conteo y una muestra de ids. */
  async preview(operatorId: string, rule: Rule, sample = 10): Promise<{ count: number; sample: string[] }> {
    const m = await this.match(operatorId, rule);
    return { count: m.length, sample: m.slice(0, sample).map((v) => v.playerId) };
  }

  async listPlayers(operatorId: string, segmentId: string): Promise<string[]> {
    const seg = await this.repo.getSegment(operatorId, segmentId);
    if (!seg) return [];
    return (await this.match(operatorId, seg.rule)).map((v) => v.playerId);
  }

  async isMember(operatorId: string, segmentId: string, playerId: string): Promise<boolean> {
    const seg = await this.repo.getSegment(operatorId, segmentId);
    if (!seg) return false;
    const view = await this.profiles().getProfile(operatorId, playerId);
    return view ? evaluateRule(seg.rule, toAttributes(view), this.clock()) : false;
  }
}

/* ───────────────────────── Tickets ───────────────────────── */

export class CrmTicketService {
  constructor(private readonly repo: CrmRepository, private readonly timeline: CrmTimelineService, private readonly clock: Clock) {}

  async create(operatorId: string, playerId: string, input: { subject: string; message: string; priority?: TicketPriority }): Promise<CrmTicket> {
    const now = this.clock().toISOString();
    const ticket: CrmTicket = {
      id: randomUUID(), operatorId, playerId, subject: input.subject, status: 'open', priority: input.priority ?? 'normal',
      messages: [{ id: randomUUID(), authorType: 'player', authorId: playerId, text: input.message, at: now }],
      createdAt: now, updatedAt: now,
    };
    await this.repo.saveTicket(ticket);
    await this.timeline.add({ operatorId, playerId, type: 'ticket', title: `Ticket abierto: ${ticket.subject}`, data: { ticketId: ticket.id }, at: now });
    return ticket;
  }

  async get(operatorId: string, id: string): Promise<CrmTicket> {
    const t = await this.repo.getTicket(operatorId, id);
    if (!t) throw notFound('Ticket no encontrado');
    return t;
  }

  list(operatorId: string, filter: TicketFilter = {}): Promise<CrmTicket[]> {
    return this.repo.listTickets(operatorId, filter);
  }

  /** Mensaje de un agente (o del jugador). Un agente que responde pasa el ticket a "pending"; el jugador lo reabre. */
  async addMessage(operatorId: string, id: string, author: { type: 'player' | 'agent'; id: string }, text: string): Promise<CrmTicket> {
    const t = await this.get(operatorId, id);
    if (t.status === 'closed') throw new HttpError(409, 'TICKET_CLOSED', 'El ticket está cerrado');
    if (author.type === 'player' && t.playerId !== author.id) throw notFound('Ticket no encontrado');
    const now = this.clock().toISOString();
    t.messages.push({ id: randomUUID(), authorType: author.type, authorId: author.id, text, at: now });
    t.status = author.type === 'agent' ? 'pending' : 'open';
    t.updatedAt = now;
    await this.repo.saveTicket(t);
    await this.timeline.add({ operatorId, playerId: t.playerId, type: 'ticket', title: `Respuesta en ticket: ${t.subject}`, data: { ticketId: t.id, by: author.type }, at: now });
    return t;
  }

  async update(operatorId: string, id: string, patch: { status?: TicketStatus; priority?: TicketPriority; assignedTo?: string | null }): Promise<CrmTicket> {
    const t = await this.get(operatorId, id);
    if (patch.status) t.status = patch.status;
    if (patch.priority) t.priority = patch.priority;
    if (patch.assignedTo !== undefined) {
      if (patch.assignedTo === null) delete t.assignedTo;
      else t.assignedTo = patch.assignedTo;
    }
    t.updatedAt = this.clock().toISOString();
    await this.repo.saveTicket(t);
    if (patch.status) {
      await this.timeline.add({ operatorId, playerId: t.playerId, type: 'ticket', title: `Ticket ${patch.status}: ${t.subject}`, data: { ticketId: t.id }, at: t.updatedAt });
    }
    return t;
  }
}
