import type { PrismaClient } from '@prisma/client';

/** Fila por persona (o el bot) en el período: lo que el dueño mira para saber quién trabaja y cómo. */
export interface AgentMetrics {
  key: string;
  name: string;
  backofficeUserId: string | null;
  memberId: string | null;
  isBot: boolean;
  loads: { count: number; amount: string };
  debits: { count: number; amount: string };
  receipts: { count: number; amount: string };
  withdrawals: { approved: number; rejected: number; amount: string };
  messages: number;
  firstResponses: number;
  avgResponseSeconds: number | null;
  workedMinutes: number;
}

export interface TeamMetricsReport {
  from: string;
  to: string;
  currency: string;
  agents: AgentMetrics[];
  totals: { loads: number; loaded: string; debited: string; receipts: number; withdrawalsApproved: number; withdrawn: string; messages: number; avgResponseSeconds: number | null };
  /** Cargas (depósitos + manuales) por hora local del día, 0..23. */
  hourly: Array<{ hour: number; count: number; amount: string }>;
  players: { registered: number; loaders: number; firstTimeLoaders: number; returningLoaders: number };
}

const BOT = 'bot';

/** Métricas del equipo de caja y atención, como el panel de Magik: por persona, por turno y pulso por hora. */
export class TeamMetrics {
  constructor(private readonly db: PrismaClient) {}

  async report(operatorId: string, from: Date, to: Date, timeZone: string): Promise<TeamMetricsReport> {
    const db = this.db;
    const range = { gte: from, lt: to };
    const [operator, members, manual, receipts, withdrawals, messages, responses, sessions, hourly, loaders, registered] = await Promise.all([
      db.operator.findUnique({ where: { id: operatorId }, select: { defaultCurrency: true } }),
      db.crewMember.findMany({ where: { operatorId }, select: { id: true, name: true, backofficeUserId: true } }),
      db.$queryRaw<Array<{ uid: string | null; loads: number; loaded: bigint | null; debits: number; debited: bigint | null }>>`
        SELECT t."createdByBackofficeUserId"::text AS uid,
               COUNT(*) FILTER (WHERE e.amount > 0)::int AS loads, SUM(e.amount) FILTER (WHERE e.amount > 0) AS loaded,
               COUNT(*) FILTER (WHERE e.amount < 0)::int AS debits, SUM(-e.amount) FILTER (WHERE e.amount < 0) AS debited
        FROM "LedgerTransaction" t
        JOIN "LedgerEntry" e ON e."transactionId" = t.id
        JOIN "LedgerAccount" a ON a.id = e."accountId"
        WHERE t."operatorId" = ${operatorId}::uuid AND t.type = 'MANUAL_ADJUSTMENT' AND a.type = 'PLAYER_CASH'
          AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
        GROUP BY 1`,
      db.pearlReceipt.groupBy({ by: ['reviewerId'], where: { operatorId, status: 'credited', updatedAt: range }, _count: { _all: true }, _sum: { amount: true } }),
      db.withdrawal.groupBy({ by: ['reviewedByBackofficeUserId', 'status'], where: { operatorId, reviewedAt: range }, _count: { _all: true }, _sum: { amount: true } }),
      db.inboxMessage.groupBy({ by: ['authorType', 'authorId'], where: { operatorId, direction: 'out', authorType: { in: ['agent', 'bot'] }, createdAt: range }, _count: { _all: true } }),
      db.crewActivity.groupBy({ by: ['memberId'], where: { operatorId, type: 'first_response', at: range }, _count: { _all: true }, _sum: { value: true } }),
      db.crewSession.findMany({ where: { operatorId, startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] }, select: { memberId: true, startedAt: true, endedAt: true, netMinutes: true } }),
      db.$queryRaw<Array<{ hour: number; count: number; amount: bigint }>>`
        SELECT EXTRACT(HOUR FROM e."createdAt" AT TIME ZONE ${timeZone})::int AS hour, COUNT(*)::int AS count, SUM(e.amount) AS amount
        FROM "LedgerEntry" e
        JOIN "LedgerTransaction" t ON t.id = e."transactionId"
        JOIN "LedgerAccount" a ON a.id = e."accountId"
        WHERE e."operatorId" = ${operatorId}::uuid AND a.type = 'PLAYER_CASH' AND e.amount > 0
          AND t.type IN ('DEPOSIT', 'MANUAL_ADJUSTMENT') AND e."createdAt" >= ${from} AND e."createdAt" < ${to}
        GROUP BY 1`,
      db.$queryRaw<Array<{ loaders: number; first_time: number }>>`
        SELECT COUNT(*)::int AS loaders, COUNT(*) FILTER (WHERE first_at >= ${from})::int AS first_time
        FROM (
          SELECT a."userId", MIN(e."createdAt") AS first_at, MAX(e."createdAt") AS last_at
          FROM "LedgerEntry" e
          JOIN "LedgerTransaction" t ON t.id = e."transactionId"
          JOIN "LedgerAccount" a ON a.id = e."accountId"
          WHERE e."operatorId" = ${operatorId}::uuid AND a.type = 'PLAYER_CASH' AND e.amount > 0
            AND t.type IN ('DEPOSIT', 'MANUAL_ADJUSTMENT') AND e."createdAt" < ${to}
          GROUP BY a."userId"
        ) p
        WHERE p.last_at >= ${from}`,
      db.user.count({ where: { operatorId, createdAt: range } }),
    ]);

    const byUser = new Map(members.filter((m) => m.backofficeUserId).map((m) => [m.backofficeUserId!, m]));
    const byMember = new Map(members.map((m) => [m.id, m]));
    const rows = new Map<string, AgentMetrics>();
    const row = (uid: string | null): AgentMetrics => {
      const key = uid ?? BOT;
      let r = rows.get(key);
      if (!r) {
        const m = uid ? byUser.get(uid) : undefined;
        r = {
          key, name: uid ? m?.name ?? 'Sin ficha en Crew' : 'Bot', backofficeUserId: uid, memberId: m?.id ?? null, isBot: !uid,
          loads: { count: 0, amount: '0' }, debits: { count: 0, amount: '0' }, receipts: { count: 0, amount: '0' },
          withdrawals: { approved: 0, rejected: 0, amount: '0' }, messages: 0, firstResponses: 0, avgResponseSeconds: null, workedMinutes: 0,
        };
        rows.set(key, r);
      }
      return r;
    };
    const add = (a: string, b: bigint | number | null | undefined) => (BigInt(a) + BigInt(b ?? 0)).toString();

    for (const m of manual) {
      const r = row(m.uid);
      r.loads = { count: r.loads.count + m.loads, amount: add(r.loads.amount, m.loaded) };
      r.debits = { count: r.debits.count + m.debits, amount: add(r.debits.amount, m.debited) };
    }
    for (const g of receipts) {
      const r = row(g.reviewerId);
      r.receipts = { count: r.receipts.count + g._count._all, amount: add(r.receipts.amount, g._sum.amount) };
    }
    for (const g of withdrawals) {
      if (!g.reviewedByBackofficeUserId) continue;
      const r = row(g.reviewedByBackofficeUserId);
      const approved = g.status === 'APPROVED' || g.status === 'PROCESSING' || g.status === 'PAID';
      if (approved) r.withdrawals = { ...r.withdrawals, approved: r.withdrawals.approved + g._count._all, amount: add(r.withdrawals.amount, g._sum.amount) };
      else if (g.status === 'REJECTED') r.withdrawals = { ...r.withdrawals, rejected: r.withdrawals.rejected + g._count._all };
    }
    for (const g of messages) row(g.authorType === 'bot' ? null : g.authorId).messages += g._count._all;
    for (const g of responses) {
      const m = byMember.get(g.memberId);
      const r = row(m?.backofficeUserId ?? null);
      if (r.isBot) continue;
      r.firstResponses += g._count._all;
      r.avgResponseSeconds = Math.round((g._sum.value ?? 0) / Math.max(1, g._count._all));
    }
    const now = Date.now();
    for (const s of sessions) {
      const m = byMember.get(s.memberId);
      if (!m?.backofficeUserId) continue;
      const start = Math.max(s.startedAt.getTime(), from.getTime());
      const end = Math.min((s.endedAt ?? new Date(now)).getTime(), to.getTime(), now);
      const span = Math.max(0, Math.round((end - start) / 60_000));
      // Con turno cerrado y completo dentro del rango se usa el neto (sin pausas); si no, la parte que cae en el rango.
      const inside = s.endedAt && s.startedAt >= from && s.endedAt <= to;
      row(m.backofficeUserId).workedMinutes += inside && s.netMinutes != null ? s.netMinutes : span;
    }
    for (const m of members) if (m.backofficeUserId) row(m.backofficeUserId);

    const agents = [...rows.values()].sort((a, b) => Number(b.isBot) - Number(a.isBot) || b.loads.count + b.receipts.count - (a.loads.count + a.receipts.count) || b.messages - a.messages);
    const humans = agents.filter((a) => a.firstResponses > 0);
    const responded = humans.reduce((n, a) => n + a.firstResponses, 0);
    const sum = (f: (a: AgentMetrics) => string) => agents.reduce((n, a) => n + BigInt(f(a)), 0n).toString();
    const loaderRow = loaders[0] ?? { loaders: 0, first_time: 0 };
    const byHour = new Map(hourly.map((h) => [h.hour, h]));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      currency: operator?.defaultCurrency ?? '',
      agents,
      totals: {
        loads: agents.reduce((n, a) => n + a.loads.count + a.receipts.count, 0),
        loaded: (BigInt(sum((a) => a.loads.amount)) + BigInt(sum((a) => a.receipts.amount))).toString(),
        debited: sum((a) => a.debits.amount),
        receipts: agents.reduce((n, a) => n + a.receipts.count, 0),
        withdrawalsApproved: agents.reduce((n, a) => n + a.withdrawals.approved, 0),
        withdrawn: sum((a) => a.withdrawals.amount),
        messages: agents.reduce((n, a) => n + a.messages, 0),
        avgResponseSeconds: responded ? Math.round(humans.reduce((n, a) => n + (a.avgResponseSeconds ?? 0) * a.firstResponses, 0) / responded) : null,
      },
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHour.get(hour)?.count ?? 0, amount: String(byHour.get(hour)?.amount ?? 0) })),
      players: { registered, loaders: loaderRow.loaders, firstTimeLoaders: loaderRow.first_time, returningLoaders: loaderRow.loaders - loaderRow.first_time },
    };
  }
}
