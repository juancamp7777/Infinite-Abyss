import { Prisma, type PrismaClient } from '@prisma/client';
import type { InboxEvent } from '../../inbox/application/InboxService';
import { BADGES, firstResponseXp, leagueFor, levelFor, weekStart, XP, type ActivityType, type Counters } from '../domain/ascend';

const EMPTY: Counters = { first_response: 0, fast_response: 0, deposit_approved: 0, checklist: 0, task_done: 0, on_time: 0, cash_perfect: 0 };

/**
 * Registro de actividad del equipo (idempotente por refKey) y lectura de XP, nivel, liga, insignias, ranking y KPIs.
 * Fuentes: Sonar (tiempo de primera respuesta), Pearl (cargas aprobadas por cajeros) y Crew (puntualidad, checklist,
 * tareas, cajas sin diferencia). Todo se calcula en el servidor (no en el navegador).
 */
export class AscendService {
  constructor(private readonly db: PrismaClient, private readonly opts: { now?: () => Date } = {}) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  async record(operatorId: string, memberId: string, type: ActivityType, refId: string, o: { xp?: number; value?: number; at?: Date } = {}): Promise<boolean> {
    const xp = o.xp ?? (type === 'first_response' ? firstResponseXp(o.value ?? 0) : XP[type]);
    try {
      await this.db.crewActivity.create({ data: { operatorId, memberId, type, xp, value: o.value ?? null, refKey: `${type}:${refId}`, at: o.at ?? this.now() } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false; // ya contado
      throw e;
    }
  }

  /** Actividad de un usuario de backoffice: cuenta solo si está en el equipo del operador. */
  async recordForUser(operatorId: string, backofficeUserId: string, type: ActivityType, refId: string, o: { xp?: number; value?: number; at?: Date } = {}) {
    const m = await this.db.crewMember.findFirst({ where: { operatorId, backofficeUserId, active: true }, select: { id: true } });
    return m ? this.record(operatorId, m.id, type, refId, o) : false;
  }

  /**
   * Sonar: reloj de "contacto esperando". El primer mensaje del contacto lo arranca; la primera respuesta de un agente
   * lo detiene y otorga XP según la velocidad. Las notas internas no cuentan.
   */
  async onInboxEvent(e: InboxEvent): Promise<void> {
    const c = e.conversation;
    if (e.type === 'contact_message') {
      await this.db.crewResponseClock.upsert({ where: { conversationId: c.id }, create: { conversationId: c.id, operatorId: c.operatorId, waitingSince: e.message.createdAt }, update: {} });
      await this.db.crewResponseClock.updateMany({ where: { conversationId: c.id, waitingSince: null }, data: { waitingSince: e.message.createdAt } });
      return;
    }
    if (e.type === 'closed') {
      await this.db.crewResponseClock.deleteMany({ where: { conversationId: c.id } });
      return;
    }
    if (e.type !== 'agent_message' || e.message.direction !== 'out' || !e.message.authorId) return;
    const clock = await this.db.crewResponseClock.findUnique({ where: { conversationId: c.id } });
    if (!clock?.waitingSince) return;
    const n = await this.db.crewResponseClock.updateMany({ where: { conversationId: c.id, waitingSince: clock.waitingSince }, data: { waitingSince: null } });
    if (!n.count) return;
    const seconds = Math.max(0, Math.round((e.message.createdAt.getTime() - clock.waitingSince.getTime()) / 1000));
    await this.recordForUser(c.operatorId, e.message.authorId, 'first_response', e.message.id, { value: seconds, at: e.message.createdAt });
  }

  private async counters(memberIds: string[], from?: Date): Promise<Map<string, Counters & { xp: number; responseSeconds: number }>> {
    const rows = await this.db.crewActivity.groupBy({
      by: ['memberId', 'type'], where: { memberId: { in: memberIds }, ...(from ? { at: { gte: from } } : {}) }, _count: { _all: true }, _sum: { xp: true, value: true },
    });
    const fast = await this.db.crewActivity.groupBy({ by: ['memberId'], where: { memberId: { in: memberIds }, type: 'first_response', value: { lte: 120 }, ...(from ? { at: { gte: from } } : {}) }, _count: { _all: true } });
    const out = new Map(memberIds.map((id) => [id, { ...EMPTY, xp: 0, responseSeconds: 0 }]));
    for (const r of rows) {
      const c = out.get(r.memberId)!;
      (c as unknown as Record<string, number>)[r.type] = r._count._all;
      c.xp += r._sum.xp ?? 0;
      if (r.type === 'first_response') c.responseSeconds = r._sum.value ?? 0;
    }
    for (const f of fast) out.get(f.memberId)!.fast_response = f._count._all;
    return out;
  }

  /** Ranking del equipo en el periodo, con liga semanal y KPIs. */
  async leaderboard(operatorId: string, period: 'week' | 'month' | 'all') {
    const now = this.now();
    const from = period === 'week' ? weekStart(now) : period === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : undefined;
    const members = await this.db.crewMember.findMany({ where: { operatorId, active: true }, select: { id: true, name: true, role: true } });
    const ids = members.map((m) => m.id);
    const [period_, week, total] = await Promise.all([this.counters(ids, from), this.counters(ids, weekStart(now)), this.counters(ids)]);
    return members
      .map((m) => {
        const p = period_.get(m.id)!;
        return {
          member: m,
          xp: p.xp,
          totalXp: total.get(m.id)!.xp,
          level: levelFor(total.get(m.id)!.xp).level,
          league: leagueFor(week.get(m.id)!.xp),
          kpis: {
            firstResponses: p.first_response, avgFirstResponseSec: p.first_response ? Math.round(p.responseSeconds / p.first_response) : null,
            fastResponses: p.fast_response, depositsApproved: p.deposit_approved, checklist: p.checklist, tasksDone: p.task_done, onTime: p.on_time, cashPerfect: p.cash_perfect,
          },
        };
      })
      .sort((a, b) => b.xp - a.xp || b.totalXp - a.totalXp)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  /** Perfil de la persona: nivel, progreso, liga de la semana, puesto, insignias y KPIs de 30 días. */
  async profile(operatorId: string, memberId: string) {
    const now = this.now();
    const [total, week, last30] = await Promise.all([this.counters([memberId]), this.counters([memberId], weekStart(now)), this.counters([memberId], new Date(now.getTime() - 30 * 86_400_000))]);
    const t = total.get(memberId)!;
    const w = week.get(memberId)!;
    const k = last30.get(memberId)!;
    const board = await this.leaderboard(operatorId, 'week');
    return {
      xp: t.xp, ...levelFor(t.xp), weeklyXp: w.xp, league: leagueFor(w.xp), rank: board.find((r) => r.member.id === memberId)?.rank ?? null, teamSize: board.length,
      badges: BADGES.map((b) => ({ key: b.key, label: b.label, description: b.description, earned: b.earned(t) })),
      kpis30d: { firstResponses: k.first_response, avgFirstResponseSec: k.first_response ? Math.round(k.responseSeconds / k.first_response) : null, depositsApproved: k.deposit_approved, checklist: k.checklist, tasksDone: k.task_done, onTime: k.on_time, cashPerfect: k.cash_perfect },
    };
  }
}
