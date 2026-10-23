import { Prisma, type PrismaClient } from '@prisma/client';
import { HttpError } from '../../shared/http/errors';
import { autoCloseAt, cashExpected, computePayroll, lateMinutes, monthRange, netMinutes, type Pause, type PayType, type SessionKind } from '../domain/rules';

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} no encontrado`);
type Pauses = Array<{ from: string; to?: string }>;
const toPauses = (j: unknown): Pause[] => ((j as Pauses) ?? []).map((p) => ({ from: new Date(p.from), ...(p.to ? { to: new Date(p.to) } : {}) }));

/** Día local (YYYY-MM-DD) y día de la semana (0 = domingo) en la zona horaria de la persona. */
export function localDay(d: Date, timeZone: string): { day: string; weekday: number } {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
  return { day, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd) };
}

/** Actividad para Ascend (XP); nunca rompe la operación si falla. */
export type CrewActivityHook = (a: { operatorId: string; memberId?: string; userId?: string; type: 'on_time' | 'checklist' | 'task_done' | 'cash_perfect'; refId: string }) => Promise<unknown>;

export interface MemberInput {
  id?: string;
  backofficeUserId?: string | null;
  name: string;
  role: string;
  team?: string | null;
  timezone?: string;
  payType?: PayType;
  baseAmount?: bigint;
  currency: string;
  dayOff?: number | null;
  active?: boolean;
}

/**
 * Crew: equipo, turnos planificados, fichaje (una jornada abierta por persona, cierre atómico y de seguridad),
 * tareas, checklist por turno, avisos con confirmación obligatoria, caja por turno y nómina con mes congelado.
 */
export class CrewService {
  constructor(private readonly db: PrismaClient, private readonly opts: { now?: () => Date; onActivity?: CrewActivityHook } = {}) {}

  private async activity(a: Parameters<CrewActivityHook>[0]) {
    try {
      await this.opts.onActivity?.(a);
    } catch {
      /* la gamificación nunca bloquea el trabajo */
    }
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  // ───────────────────────── equipo ─────────────────────────

  listMembers(operatorId: string) {
    return this.db.crewMember.findMany({ where: { operatorId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
  }

  async member(operatorId: string, id: string) {
    const m = await this.db.crewMember.findFirst({ where: { id, operatorId } });
    if (!m) throw notFound('Integrante');
    return m;
  }

  /** La persona logueada en el backoffice, si forma parte del equipo. */
  async me(operatorId: string, backofficeUserId: string) {
    const m = await this.db.crewMember.findFirst({ where: { operatorId, backofficeUserId, active: true } });
    if (!m) throw new HttpError(404, 'NOT_A_MEMBER', 'Tu usuario no está en el equipo de este operador');
    return m;
  }

  /** Un administrador se suma a sí mismo al equipo (o se reactiva) para usar Mi turno sin pedírselo a nadie. */
  async joinSelf(operatorId: string, backofficeUserId: string) {
    const existing = await this.db.crewMember.findFirst({ where: { operatorId, backofficeUserId } });
    if (existing) return existing.active ? existing : this.db.crewMember.update({ where: { id: existing.id }, data: { active: true } });
    const [user, operator] = await Promise.all([
      this.db.backofficeUser.findUnique({ where: { id: backofficeUserId } }),
      this.db.operator.findUnique({ where: { id: operatorId } }),
    ]);
    if (!operator) throw notFound('Operador');
    const name = (user?.email.split('@')[0] || 'Administración').slice(0, 80);
    return this.db.crewMember.create({ data: { operatorId, backofficeUserId, name, role: 'Administración', currency: operator.defaultCurrency } });
  }

  async saveMember(operatorId: string, input: MemberInput) {
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
      } catch {
        throw new HttpError(400, 'BAD_REQUEST', 'Zona horaria inválida');
      }
    }
    const data = {
      name: input.name, role: input.role, team: input.team ?? null, timezone: input.timezone ?? 'America/Argentina/Buenos_Aires', payType: input.payType ?? 'monthly',
      baseAmount: input.baseAmount ?? 0n, currency: input.currency, dayOff: input.dayOff ?? null, active: input.active ?? true, backofficeUserId: input.backofficeUserId ?? null,
    };
    try {
      if (input.id) {
        await this.member(operatorId, input.id);
        return await this.db.crewMember.update({ where: { id: input.id }, data });
      }
      return await this.db.crewMember.create({ data: { ...data, operatorId } });
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'DUPLICATE', 'Ese usuario de backoffice ya está en el equipo');
      throw e;
    }
  }

  // ───────────────────────── turnos planificados ─────────────────────────

  listShifts(operatorId: string, from: Date, to: Date, memberId?: string) {
    return this.db.crewShift.findMany({ where: { operatorId, startsAt: { gte: from, lt: to }, ...(memberId ? { memberId } : {}) }, orderBy: { startsAt: 'asc' } });
  }

  async createShift(operatorId: string, s: { memberId: string; label: string; startsAt: Date; endsAt: Date }) {
    await this.member(operatorId, s.memberId);
    if (s.endsAt <= s.startsAt) throw new HttpError(400, 'BAD_REQUEST', 'El turno debe terminar después de empezar');
    if (s.endsAt.getTime() - s.startsAt.getTime() > 16 * 3_600_000) throw new HttpError(400, 'BAD_REQUEST', 'Un turno no puede superar 16 horas');
    const overlap = await this.db.crewShift.findFirst({ where: { memberId: s.memberId, startsAt: { lt: s.endsAt }, endsAt: { gt: s.startsAt } } });
    if (overlap) throw new HttpError(409, 'OVERLAP', 'Se superpone con otro turno de la misma persona');
    return this.db.crewShift.create({ data: { ...s, operatorId } });
  }

  async deleteShift(operatorId: string, id: string) {
    const n = await this.db.crewShift.deleteMany({ where: { id, operatorId } });
    if (!n.count) throw notFound('Turno');
  }

  // ───────────────────────── fichaje ─────────────────────────

  async clockIn(operatorId: string, memberId: string, extra = false) {
    const m = await this.member(operatorId, memberId);
    const now = this.now();
    const { weekday } = localDay(now, m.timezone);
    // Turno planificado vigente o que empieza en la próxima hora.
    const shift = await this.db.crewShift.findFirst({
      where: { memberId, startsAt: { lte: new Date(now.getTime() + 3_600_000) }, endsAt: { gt: now } }, orderBy: { startsAt: 'asc' },
    });
    const kind: SessionKind = m.dayOff !== null && m.dayOff === weekday ? 'dayoff' : extra ? 'extra' : 'normal';
    try {
      const s = await this.db.crewSession.create({
        data: { operatorId, memberId, openKey: memberId, shiftId: shift?.id ?? null, kind, status: 'working', startedAt: now, lateMinutes: kind === 'normal' ? lateMinutes(shift?.startsAt, now) : 0 },
      });
      // Puntualidad: solo con turno planificado y llegando a tiempo.
      if (s.kind === 'normal' && s.shiftId && s.lateMinutes === 0) await this.activity({ operatorId, memberId, type: 'on_time', refId: s.id });
      return s;
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'ALREADY_OPEN', 'Ya tienes una jornada abierta');
      throw e;
    }
  }

  private async open(operatorId: string, memberId: string) {
    const s = await this.db.crewSession.findFirst({ where: { operatorId, openKey: memberId } });
    if (!s) throw new HttpError(409, 'NOT_OPEN', 'No tienes una jornada abierta');
    return s;
  }

  async pause(operatorId: string, memberId: string) {
    const s = await this.open(operatorId, memberId);
    if (s.status === 'paused') return s;
    const pauses = [...((s.pauses as Pauses) ?? []), { from: this.now().toISOString() }];
    const n = await this.db.crewSession.updateMany({ where: { id: s.id, status: 'working', openKey: memberId }, data: { status: 'paused', pauses } });
    if (!n.count) throw new HttpError(409, 'CONFLICT', 'La jornada cambió; recarga');
    return this.db.crewSession.findUniqueOrThrow({ where: { id: s.id } });
  }

  async resume(operatorId: string, memberId: string) {
    const s = await this.open(operatorId, memberId);
    if (s.status === 'working') return s;
    const pauses = ((s.pauses as Pauses) ?? []).map((p, i, all) => (i === all.length - 1 && !p.to ? { ...p, to: this.now().toISOString() } : p));
    const n = await this.db.crewSession.updateMany({ where: { id: s.id, status: 'paused', openKey: memberId }, data: { status: 'working', pauses } });
    if (!n.count) throw new HttpError(409, 'CONFLICT', 'La jornada cambió; recarga');
    return this.db.crewSession.findUniqueOrThrow({ where: { id: s.id } });
  }

  /** Cierre atómico: solo una de dos peticiones simultáneas cierra la jornada. */
  async clockOut(operatorId: string, memberId: string, closedBy: 'member' | 'manager' | 'auto' = 'member', at?: Date) {
    const s = await this.open(operatorId, memberId);
    const end = at ?? this.now();
    const pauses = ((s.pauses as Pauses) ?? []).map((p) => (p.to ? p : { ...p, to: end.toISOString() }));
    const net = netMinutes(s.startedAt, end, toPauses(pauses));
    const n = await this.db.crewSession.updateMany({
      where: { id: s.id, openKey: memberId },
      data: { openKey: null, status: 'closed', endedAt: end, pauses, netMinutes: net, closedBy },
    });
    if (!n.count) throw new HttpError(409, 'NOT_OPEN', 'La jornada ya estaba cerrada');
    return this.db.crewSession.findUniqueOrThrow({ where: { id: s.id } });
  }

  /** Jornadas olvidadas: se cierran a las 14 h netas o 20 h de reloj (marcadas como automáticas, nunca se descartan). */
  async autoCloseTick(): Promise<number> {
    const now = this.now();
    let closed = 0;
    for (const s of await this.db.crewSession.findMany({ where: { openKey: { not: null } }, take: 500 })) {
      const at = autoCloseAt(s.startedAt, toPauses(s.pauses), now);
      if (!at) continue;
      await this.clockOut(s.operatorId, s.memberId, 'auto', at).then(() => closed++).catch(() => undefined);
    }
    return closed;
  }

  async live(operatorId: string) {
    const open = await this.db.crewSession.findMany({ where: { operatorId, openKey: { not: null } }, orderBy: { startedAt: 'asc' } });
    const members = new Map((await this.listMembers(operatorId)).map((m) => [m.id, m]));
    const now = this.now();
    return open.map((s) => ({ ...s, memberName: members.get(s.memberId)?.name ?? '—', netMinutesSoFar: netMinutes(s.startedAt, now, toPauses(s.pauses)) }));
  }

  listSessions(operatorId: string, month: string, memberId?: string) {
    const { from, to } = monthRange(month);
    return this.db.crewSession.findMany({ where: { operatorId, startedAt: { gte: from, lt: to }, ...(memberId ? { memberId } : {}) }, orderBy: { startedAt: 'desc' }, take: 1000 });
  }

  // ───────────────────────── tareas ─────────────────────────

  listTasks(operatorId: string, f: { assigneeId?: string; status?: string }) {
    return this.db.crewTask.findMany({ where: { operatorId, ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}), ...(f.status ? { status: f.status } : {}) }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }], take: 500 });
  }

  async createTask(operatorId: string, t: { title: string; description?: string; assigneeId?: string | null; dueAt?: Date | null }, createdBy: string) {
    if (t.assigneeId) await this.member(operatorId, t.assigneeId);
    return this.db.crewTask.create({ data: { operatorId, title: t.title, description: t.description ?? '', assigneeId: t.assigneeId ?? null, dueAt: t.dueAt ?? null, createdBy } });
  }

  async updateTask(operatorId: string, id: string, patch: { title?: string; description?: string; assigneeId?: string | null; status?: 'todo' | 'doing' | 'done'; dueAt?: Date | null }, actorMemberId?: string) {
    const t = await this.db.crewTask.findFirst({ where: { id, operatorId } });
    if (!t) throw notFound('Tarea');
    // El personal solo mueve sus propias tareas (y no las reasigna).
    if (actorMemberId && (t.assigneeId !== actorMemberId || patch.assigneeId !== undefined || patch.title !== undefined)) throw new HttpError(403, 'FORBIDDEN', 'Solo puedes cambiar el estado de tus tareas');
    if (patch.assigneeId) await this.member(operatorId, patch.assigneeId);
    const completedAt = patch.status === 'done' ? (t.completedAt ?? this.now()) : patch.status ? null : t.completedAt;
    const saved = await this.db.crewTask.update({ where: { id }, data: { ...patch, completedAt } });
    if (saved.status === 'done' && t.status !== 'done' && saved.assigneeId) await this.activity({ operatorId, memberId: saved.assigneeId, type: 'task_done', refId: saved.id });
    return saved;
  }

  async deleteTask(operatorId: string, id: string) {
    const n = await this.db.crewTask.deleteMany({ where: { id, operatorId } });
    if (!n.count) throw notFound('Tarea');
  }

  // ───────────────────────── checklist ─────────────────────────

  listChecklist(operatorId: string) {
    return this.db.crewChecklistItem.findMany({ where: { operatorId }, orderBy: { createdAt: 'asc' } });
  }

  createChecklistItem(operatorId: string, title: string, shiftLabel = '') {
    return this.db.crewChecklistItem.create({ data: { operatorId, title, shiftLabel } });
  }

  async toggleChecklistItem(operatorId: string, id: string, active: boolean) {
    const n = await this.db.crewChecklistItem.updateMany({ where: { id, operatorId }, data: { active } });
    if (!n.count) throw notFound('Ítem');
  }

  /** Checklist de hoy (día local de la persona) filtrado por la etiqueta del turno vigente. */
  async myChecklist(operatorId: string, memberId: string) {
    const m = await this.member(operatorId, memberId);
    const { day } = localDay(this.now(), m.timezone);
    const open = await this.db.crewSession.findFirst({ where: { openKey: memberId } });
    const shift = open?.shiftId ? await this.db.crewShift.findUnique({ where: { id: open.shiftId } }) : null;
    const items = (await this.db.crewChecklistItem.findMany({ where: { operatorId, active: true }, orderBy: { createdAt: 'asc' } }))
      .filter((i) => !i.shiftLabel || i.shiftLabel === shift?.label);
    const marks = await this.db.crewChecklistMark.findMany({ where: { memberId, day, itemId: { in: items.map((i) => i.id) } } });
    const done = new Set(marks.map((x) => x.itemId));
    return { day, shiftLabel: shift?.label ?? null, items: items.map((i) => ({ ...i, done: done.has(i.id) })) };
  }

  async markChecklist(operatorId: string, memberId: string, itemId: string, done: boolean) {
    const m = await this.member(operatorId, memberId);
    const item = await this.db.crewChecklistItem.findFirst({ where: { id: itemId, operatorId, active: true } });
    if (!item) throw notFound('Ítem');
    if (!(await this.db.crewSession.findFirst({ where: { openKey: memberId } }))) throw new HttpError(409, 'NOT_OPEN', 'Ficha tu entrada antes de marcar el checklist');
    const { day } = localDay(this.now(), m.timezone);
    if (done) {
      await this.db.crewChecklistMark.upsert({ where: { itemId_memberId_day: { itemId, memberId, day } }, create: { itemId, memberId, day }, update: {} });
      await this.activity({ operatorId, memberId, type: 'checklist', refId: `${itemId}:${memberId}:${day}` });
    }
    else await this.db.crewChecklistMark.deleteMany({ where: { itemId, memberId, day } });
    return this.myChecklist(operatorId, memberId);
  }

  // ───────────────────────── avisos ─────────────────────────

  createAnnouncement(operatorId: string, a: { title: string; body: string; severity: 'info' | 'warning' | 'critical'; mandatory: boolean }, createdBy: string) {
    return this.db.crewAnnouncement.create({ data: { ...a, operatorId, createdBy } });
  }

  async listAnnouncements(operatorId: string) {
    const items = await this.db.crewAnnouncement.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const reads = await this.db.crewAnnouncementRead.groupBy({ by: ['announcementId'], where: { announcementId: { in: items.map((i) => i.id) } }, _count: { _all: true } });
    const count = new Map(reads.map((r) => [r.announcementId, r._count._all]));
    return items.map((i) => ({ ...i, reads: count.get(i.id) ?? 0 }));
  }

  async myAnnouncements(operatorId: string, memberId: string) {
    const items = await this.db.crewAnnouncement.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const read = new Set((await this.db.crewAnnouncementRead.findMany({ where: { memberId, announcementId: { in: items.map((i) => i.id) } } })).map((r) => r.announcementId));
    return items.map((i) => ({ ...i, read: read.has(i.id) }));
  }

  async ackAnnouncement(operatorId: string, memberId: string, id: string) {
    if (!(await this.db.crewAnnouncement.findFirst({ where: { id, operatorId } }))) throw notFound('Aviso');
    await this.db.crewAnnouncementRead.upsert({ where: { announcementId_memberId: { announcementId: id, memberId } }, create: { announcementId: id, memberId }, update: {} });
  }

  // ───────────────────────── caja ─────────────────────────

  listCash(operatorId: string) {
    return this.db.crewCashSession.findMany({ where: { operatorId }, orderBy: { openedAt: 'desc' }, take: 100 });
  }

  async cashDetail(operatorId: string, id: string) {
    const s = await this.db.crewCashSession.findFirst({ where: { id, operatorId } });
    if (!s) throw notFound('Caja');
    const movements = await this.db.crewCashMovement.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } });
    return { ...s, movements, expectedNow: cashExpected(s.openingBalance, movements.map((m) => ({ type: m.type as 'in' | 'out', amount: m.amount }))) };
  }

  async openCash(operatorId: string, box: string, currency: string, openingBalance: bigint, openedBy: string) {
    try {
      return await this.db.crewCashSession.create({ data: { operatorId, box, currency, openingBalance, openedBy, openKey: `${operatorId}:${box}` } });
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'ALREADY_OPEN', `La caja "${box}" ya está abierta`);
      throw e;
    }
  }

  async cashMovement(operatorId: string, id: string, m: { type: 'in' | 'out'; amount: bigint; concept: string }, by: string) {
    const s = await this.db.crewCashSession.findFirst({ where: { id, operatorId } });
    if (!s) throw notFound('Caja');
    if (s.status !== 'open') throw new HttpError(409, 'CLOSED', 'La caja está cerrada: no admite movimientos');
    if (m.amount <= 0n) throw new HttpError(400, 'BAD_REQUEST', 'El monto debe ser positivo');
    return this.db.crewCashMovement.create({ data: { sessionId: id, ...m, createdBy: by } });
  }

  /** Cierre: esperado vs declarado y foto congelada; luego la caja no admite cambios salvo reapertura auditada. */
  async closeCash(operatorId: string, id: string, declared: bigint, by: string) {
    const d = await this.cashDetail(operatorId, id);
    if (d.status !== 'open') throw new HttpError(409, 'CLOSED', 'La caja ya está cerrada');
    const ins = d.movements.filter((m) => m.type === 'in');
    const outs = d.movements.filter((m) => m.type === 'out');
    const snapshot = {
      openingBalance: d.openingBalance.toString(), ins: ins.length, outs: outs.length,
      totalIn: ins.reduce((a, m) => a + m.amount, 0n).toString(), totalOut: outs.reduce((a, m) => a + m.amount, 0n).toString(),
      expected: d.expectedNow.toString(), declared: declared.toString(), difference: (declared - d.expectedNow).toString(),
    };
    const n = await this.db.crewCashSession.updateMany({
      where: { id, operatorId, status: 'open' },
      data: { status: 'closed', openKey: null, closedBy: by, closedAt: this.now(), expectedBalance: d.expectedNow, declaredBalance: declared, difference: declared - d.expectedNow, snapshot },
    });
    if (!n.count) throw new HttpError(409, 'CLOSED', 'La caja ya está cerrada');
    if (declared === d.expectedNow) await this.activity({ operatorId, userId: by, type: 'cash_perfect', refId: id });
    return this.cashDetail(operatorId, id);
  }

  async reopenCash(operatorId: string, id: string, by: string, reason: string) {
    const s = await this.db.crewCashSession.findFirst({ where: { id, operatorId } });
    if (!s) throw notFound('Caja');
    if (s.status !== 'closed') throw new HttpError(409, 'NOT_CLOSED', 'La caja no está cerrada');
    try {
      await this.db.crewCashSession.update({ where: { id }, data: { status: 'open', openKey: `${operatorId}:${s.box}`, reopenedBy: by, reopenReason: reason } });
    } catch (e) {
      if (isUnique(e)) throw new HttpError(409, 'ALREADY_OPEN', `Hay otra caja "${s.box}" abierta`);
      throw e;
    }
    return this.cashDetail(operatorId, id);
  }

  // ───────────────────────── nómina ─────────────────────────

  async payroll(operatorId: string, month: string) {
    const { from, to } = monthRange(month);
    const members = (await this.listMembers(operatorId)).filter((m) => m.active);
    const sessions = await this.db.crewSession.findMany({ where: { operatorId, startedAt: { gte: from, lt: to }, status: 'closed' } });
    const adjustments = await this.db.crewPayrollAdjustment.findMany({ where: { operatorId, month }, orderBy: { createdAt: 'asc' } });
    const closes = new Map((await this.db.crewPayrollClose.findMany({ where: { operatorId, month } })).map((c) => [c.memberId, c]));
    return members.map((m) => {
      const close = closes.get(m.id);
      const adj = adjustments.filter((a) => a.memberId === m.id);
      const result = computePayroll({
        payType: m.payType as PayType, baseAmount: m.baseAmount,
        sessions: sessions.filter((s) => s.memberId === m.id).map((s) => ({ kind: s.kind as SessionKind, netMinutes: s.netMinutes ?? 0 })),
        adjustments: adj.map((a) => ({ type: a.type as 'bonus' | 'discount', amount: a.amount })),
      });
      return { member: { id: m.id, name: m.name, role: m.role, currency: m.currency, payType: m.payType }, result, adjustments: adj, closed: close ? { snapshot: close.snapshot, closedAt: close.closedAt, paidAt: close.paidAt } : null };
    });
  }

  private async assertMonthOpen(memberId: string, month: string) {
    if (await this.db.crewPayrollClose.findUnique({ where: { memberId_month: { memberId, month } } })) throw new HttpError(409, 'MONTH_CLOSED', 'La nómina de ese mes ya está cerrada para esta persona');
  }

  async addAdjustment(operatorId: string, a: { memberId: string; month: string; type: 'bonus' | 'discount'; amount: bigint; note: string }, by: string) {
    await this.member(operatorId, a.memberId);
    await this.assertMonthOpen(a.memberId, a.month);
    if (a.amount <= 0n) throw new HttpError(400, 'BAD_REQUEST', 'El monto debe ser positivo');
    return this.db.crewPayrollAdjustment.create({ data: { ...a, operatorId, createdBy: by } });
  }

  async deleteAdjustment(operatorId: string, id: string) {
    const a = await this.db.crewPayrollAdjustment.findFirst({ where: { id, operatorId } });
    if (!a) throw notFound('Ajuste');
    await this.assertMonthOpen(a.memberId, a.month);
    await this.db.crewPayrollAdjustment.delete({ where: { id } });
  }

  /** Congela el mes: foto por persona (los cambios posteriores no alteran lo liquidado). */
  async closeMonth(operatorId: string, month: string, by: string) {
    const rows = await this.payroll(operatorId, month);
    let closed = 0;
    for (const r of rows) {
      if (r.closed) continue;
      const snapshot = JSON.parse(JSON.stringify({ ...r.result, adjustments: r.adjustments.map((a) => ({ type: a.type, amount: a.amount, note: a.note })) }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
      try {
        await this.db.crewPayrollClose.create({ data: { operatorId, memberId: r.member.id, month, snapshot, closedBy: by } });
        closed++;
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
    return { closed };
  }

  async markPaid(operatorId: string, month: string, memberId: string, by: string) {
    const n = await this.db.crewPayrollClose.updateMany({ where: { operatorId, month, memberId, paidAt: null }, data: { paidAt: this.now(), paidBy: by } });
    if (!n.count) throw new HttpError(409, 'NOT_CLOSED', 'Cierra el mes antes de marcarlo pagado (o ya estaba pagado)');
  }
}
