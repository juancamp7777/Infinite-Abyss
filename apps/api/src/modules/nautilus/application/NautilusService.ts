import type { PrismaClient } from '@prisma/client';
import { currencyDecimals } from '../../../domain/money/currencies';
import { HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import type { IntegrationsPort } from '../../shared/ports/IntegrationsPort';
import { DEFAULT_THRESHOLDS, detectFindings, type Finding, type Snapshot, type Thresholds } from '../domain/watchers';
import type { Briefing, BrainFactory, NautilusBrain, ReadOnlyTool } from '../infrastructure/brain';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Hora local de cada casino según su moneda (día de los reportes). */
const UTC_OFFSET_BY_CURRENCY: Record<string, number> = { ARS: -180, BRL: -180, COP: -300, MXN: -360, USD: -300, CLP: -180, PEN: -300 };

export function formatAmount(minor: bigint, currency: string): string {
  const d = currencyDecimals(currency);
  const n = Number(minor) / 10 ** d;
  return `${n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: Math.min(d, 2) })} ${currency}`;
}

export interface NautilusOptions {
  logger: ModuleLogger;
  integrations?: () => IntegrationsPort | undefined;
  brainFactory: BrainFactory;
  envKey?: string;
  thresholds?: Thresholds;
  /** Hora local a partir de la cual se redacta el resumen del día anterior. */
  reportHour?: number;
  now?: () => Date;
  fetch?: FetchLike;
}

/**
 * Nautilus: vigila cada casino (reglas deterministas), avisa por Telegram lo grave, redacta el resumen diario con
 * Claude y responde preguntas del operador con herramientas de solo lectura. Nunca mueve dinero.
 */
export class NautilusService {
  constructor(private readonly db: PrismaClient, private readonly opts: NautilusOptions) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private ago(ms: number): Date {
    return new Date(this.now().getTime() - ms);
  }

  // ───── foto del casino ─────

  async snapshot(operatorId: string): Promise<Snapshot> {
    const t = this.opts.thresholds ?? DEFAULT_THRESHOLDS;
    const now = this.now().getTime();
    const minutes = (d: Date | null | undefined) => (d ? (now - d.getTime()) / 60_000 : 0);

    const chatWhere = { operatorId, status: 'open', unread: { gt: 0 }, lastMessageAt: { lt: this.ago(t.chatMinutes * 60_000) } };
    const [chatCount, chatOldest] = await Promise.all([
      this.db.inboxConversation.count({ where: chatWhere }),
      this.db.inboxConversation.findFirst({ where: chatWhere, orderBy: { lastMessageAt: 'asc' }, select: { lastMessageAt: true } }),
    ]);

    const receipts = async (status: string, olderThanMin: number) => {
      const where = { operatorId, status, createdAt: { lt: this.ago(olderThanMin * 60_000) } };
      const [count, oldest] = await Promise.all([
        this.db.pearlReceipt.count({ where }),
        this.db.pearlReceipt.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      ]);
      return { count, oldestMinutes: minutes(oldest?.createdAt) };
    };

    const silentSince = this.ago(t.feedSilentHours * 3_600_000);
    const feeds = await this.db.pearlFeed.findMany({
      where: { operatorId, enabled: true, OR: [{ lastEventAt: { lt: silentSince } }, { lastEventAt: null, createdAt: { lt: silentSince } }] },
      select: { name: true, lastEventAt: true, createdAt: true },
    });

    const wWhere = { operatorId, status: 'REQUESTED' as const, createdAt: { lt: this.ago(t.withdrawalHours * 3_600_000) } };
    const [wAgg, wOldest] = await Promise.all([
      this.db.withdrawal.aggregate({ where: wWhere, _count: true, _sum: { amount: true } }),
      this.db.withdrawal.findFirst({ where: wWhere, orderBy: { createdAt: 'asc' }, select: { createdAt: true, currency: true } }),
    ]);

    const integ = await this.db.integrationCredential.findMany({ where: { scope: { in: [operatorId, 'platform'] }, status: 'error' }, select: { key: true, lastError: true } });

    const failed = await this.db.deposit.groupBy({
      by: ['userId'],
      where: { operatorId, status: 'FAILED', createdAt: { gte: this.ago(3_600_000) } },
      _count: { _all: true },
    });
    const bursts = failed.filter((f) => f._count._all >= t.failedDepositsPerHour);
    const users = bursts.length
      ? await this.db.user.findMany({ where: { id: { in: bursts.map((b) => b.userId) } }, select: { id: true, username: true } })
      : [];

    return {
      unansweredChats: { count: chatCount, oldestMinutes: minutes(chatOldest?.lastMessageAt) },
      pearlPendingReview: await receipts('pending_review', t.reviewMinutes),
      pearlWaitingBank: await receipts('waiting_bank', t.waitingBankMinutes),
      staleFeeds: feeds.map((f) => ({ name: f.name, hoursSilent: minutes(f.lastEventAt ?? f.createdAt) / 60 })),
      withdrawalsPending: { count: wAgg._count, oldestHours: minutes(wOldest?.createdAt) / 60, totalMinor: wAgg._sum.amount ?? 0n, currency: wOldest?.currency ?? null },
      integrationErrors: integ.map((i) => ({ key: i.key, message: i.lastError })),
      failedDepositBursts: bursts.map((b) => ({ userId: b.userId, username: users.find((u) => u.id === b.userId)?.username ?? null, failed: b._count._all })),
    };
  }

  // ───── escaneo: hallazgos y avisos ─────

  /** Detecta, guarda (sin duplicar), cierra lo que ya se resolvió solo y avisa por Telegram lo grave nuevo. */
  async scan(operatorId: string): Promise<{ open: number; created: number; resolved: number }> {
    const findings = detectFindings(await this.snapshot(operatorId), this.opts.thresholds);
    const now = this.now();
    const existing = await this.db.nautilusFinding.findMany({ where: { operatorId, status: { in: ['open', 'acknowledged'] } } });
    let created = 0;
    const toNotify: Finding[] = [];
    for (const f of findings) {
      const prev = existing.find((e) => e.key === f.key);
      const base = { kind: f.kind, severity: f.severity, title: f.title, detail: f.detail, data: f.data as object, lastSeenAt: now };
      if (prev) {
        await this.db.nautilusFinding.update({ where: { id: prev.id }, data: base });
        if (f.severity === 'high' && !prev.notifiedAt) toNotify.push(f);
      } else {
        await this.db.nautilusFinding.upsert({
          where: { operatorId_key: { operatorId, key: f.key } },
          create: { operatorId, key: f.key, ...base, firstSeenAt: now },
          update: { ...base, status: 'open', resolvedAt: null, ackBy: null, notifiedAt: null, firstSeenAt: now },
        });
        created++;
        if (f.severity === 'high') toNotify.push(f);
      }
    }
    const gone = existing.filter((e) => !findings.some((f) => f.key === e.key));
    if (gone.length) await this.db.nautilusFinding.updateMany({ where: { id: { in: gone.map((g) => g.id) } }, data: { status: 'resolved', resolvedAt: now } });

    if (toNotify.length) {
      const sent = await this.telegram(operatorId, ['🚨 Nautilus · alertas', ...toNotify.map((f) => `• ${f.title}\n  ${f.detail}`)].join('\n\n'));
      if (sent) await this.db.nautilusFinding.updateMany({ where: { operatorId, key: { in: toNotify.map((f) => f.key) } }, data: { notifiedAt: now } });
    }
    return { open: findings.length, created, resolved: gone.length };
  }

  findings(operatorId: string, status?: string) {
    return this.db.nautilusFinding.findMany({
      where: { operatorId, ...(status ? { status } : { status: { in: ['open', 'acknowledged'] } }) },
      orderBy: [{ lastSeenAt: 'desc' }],
      take: 100,
    });
  }

  async setStatus(operatorId: string, id: string, status: 'acknowledged' | 'resolved', by: string) {
    const r = await this.db.nautilusFinding.updateMany({
      where: { id, operatorId },
      data: status === 'resolved' ? { status, resolvedAt: this.now(), ackBy: by } : { status, ackBy: by },
    });
    if (r.count === 0) throw new HttpError(404, 'NOT_FOUND', 'Hallazgo no encontrado');
  }

  // ───── Claude ─────

  private async brain(operatorId: string): Promise<NautilusBrain> {
    const key = (await this.opts.integrations?.()?.value(operatorId, 'anthropic', 'apiKey').catch(() => undefined)) ?? this.opts.envKey;
    if (!key) throw new HttpError(409, 'AI_NOT_CONNECTED', 'Conecta la llave de Claude en Integraciones para usar Nautilus');
    return this.opts.brainFactory(key);
  }

  private async operator(operatorId: string) {
    const op = await this.db.operator.findUnique({ where: { id: operatorId }, select: { name: true, defaultCurrency: true } });
    if (!op) throw new HttpError(404, 'NOT_FOUND', 'Casino no encontrado');
    return op;
  }

  /** Día local del casino (YYYY-MM-DD) con un desplazamiento en días. */
  localDay(currency: string, shiftDays = 0): string {
    const offset = UTC_OFFSET_BY_CURRENCY[currency] ?? 0;
    return new Date(this.now().getTime() + offset * 60_000 + shiftDays * 86_400_000).toISOString().slice(0, 10);
  }

  async kpis(operatorId: string, days: number) {
    const op = await this.operator(operatorId);
    const from = this.localDay(op.defaultCurrency, -Math.max(1, Math.min(days, 31)));
    const rows = await this.db.boDayKpi.findMany({ where: { operatorId, day: { gte: from } }, orderBy: { day: 'asc' } });
    const c = op.defaultCurrency;
    return rows.map((r) => ({
      day: r.day, registrations: r.registrations, activePlayers: r.activePlayers, depositors: r.depositors, ftd: r.ftdCount,
      deposits: formatAmount(r.depositsAmount, c), withdrawals: formatAmount(r.withdrawalsAmount, c),
      ggr: formatAmount(r.settledStake - r.settledWins, c), bets: r.betCount,
    }));
  }

  /** Redacta (o devuelve, si ya existe) el resumen de ayer con Claude y lo manda por Telegram. */
  async report(operatorId: string, force = false) {
    const op = await this.operator(operatorId);
    const day = this.localDay(op.defaultCurrency, -1);
    const existing = await this.db.nautilusReport.findUnique({ where: { operatorId_day: { operatorId, day } } });
    if (existing && !force) return existing;
    const brain = await this.brain(operatorId);
    const findings = await this.findings(operatorId);
    const briefing: Briefing = await brain.briefing({
      casino: op.name, day, currency: op.defaultCurrency,
      lastDays: await this.kpis(operatorId, 7),
      openFindings: findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, since: f.firstSeenAt.toISOString() })),
    });
    const saved = await this.db.nautilusReport.upsert({
      where: { operatorId_day: { operatorId, day } },
      create: { operatorId, day, content: briefing as object, model: 'claude' },
      update: { content: briefing as object, createdAt: this.now() },
    });
    const lines = [`🌊 Nautilus · ${op.name} · ${day}`, briefing.headline, briefing.summary];
    if (briefing.risks.length) lines.push(`Riesgos:\n${briefing.risks.map((r) => `• ${r.title}: ${r.detail}`).join('\n')}`);
    if (briefing.recommendations.length) lines.push(`Qué hacer:\n${briefing.recommendations.map((r) => `• ${r.action}`).join('\n')}`);
    await this.telegram(operatorId, lines.join('\n\n'));
    return saved;
  }

  reports(operatorId: string) {
    return this.db.nautilusReport.findMany({ where: { operatorId }, orderBy: { day: 'desc' }, take: 30 });
  }

  /** Herramientas de solo lectura, siempre limitadas al casino que pregunta. */
  tools(operatorId: string): ReadOnlyTool[] {
    return [
      {
        name: 'kpis', description: 'Cifras diarias del casino: registros, jugadores activos, depositantes, primeros depósitos, depósitos, retiros, GGR y apuestas.',
        inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31, description: 'Cuántos días hacia atrás' } }, required: ['days'] },
        run: async (i) => this.kpis(operatorId, Number(i.days) || 7),
      },
      {
        name: 'open_findings', description: 'Alertas abiertas de los vigilantes (chats sin responder, caja, retiros, integraciones, fraude).',
        inputSchema: { type: 'object', properties: {} },
        run: async () => (await this.findings(operatorId)).map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, since: f.firstSeenAt })),
      },
      {
        name: 'pending_withdrawals', description: 'Retiros pendientes de aprobar, del más antiguo al más nuevo.',
        inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } },
        run: async (i) => {
          const rows = await this.db.withdrawal.findMany({
            where: { operatorId, status: 'REQUESTED' }, orderBy: { createdAt: 'asc' }, take: Math.min(Number(i.limit) || 10, 20),
            select: { amount: true, currency: true, createdAt: true, user: { select: { username: true, kycStatus: true } } },
          });
          return rows.map((w) => ({ player: w.user.username, kyc: w.user.kycStatus, amount: formatAmount(w.amount, w.currency), requestedAt: w.createdAt }));
        },
      },
      {
        name: 'cashier_queue', description: 'Cola de comprobantes de Pearl de las últimas 24 h por estado.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => {
          const rows = await this.db.pearlReceipt.groupBy({ by: ['status'], where: { operatorId, createdAt: { gte: this.ago(86_400_000) } }, _count: { _all: true } });
          return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
        },
      },
      {
        name: 'find_player', description: 'Busca jugadores por usuario o correo (máx. 5) con su estado, KYC y depósitos de 30 días.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 60 } }, required: ['query'] },
        run: async (i) => {
          const q = String(i.query ?? '').trim();
          if (q.length < 2) return [];
          const users = await this.db.user.findMany({
            where: { operatorId, OR: [{ username: { contains: q, mode: 'insensitive' } }, { emailNormalized: { contains: q.toLowerCase() } }] },
            take: 5, select: { id: true, username: true, status: true, kycStatus: true, createdAt: true },
          });
          return Promise.all(users.map(async (u) => {
            const d = await this.db.deposit.aggregate({ where: { operatorId, userId: u.id, status: 'CONFIRMED', createdAt: { gte: this.ago(30 * 86_400_000) } }, _count: true, _sum: { amount: true } });
            return { username: u.username, status: u.status, kyc: u.kycStatus, since: u.createdAt, deposits30d: d._count, deposited30dMinor: (d._sum.amount ?? 0n).toString() };
          }));
        },
      },
    ];
  }

  async ask(operatorId: string, question: string): Promise<string> {
    const op = await this.operator(operatorId);
    const brain = await this.brain(operatorId);
    const context = `Casino: ${op.name}. Moneda: ${op.defaultCurrency}. Hoy (hora local): ${this.localDay(op.defaultCurrency)}.`;
    return brain.ask(question, context, this.tools(operatorId));
  }

  // ───── Telegram ─────

  private async telegram(operatorId: string, text: string): Promise<boolean> {
    const port = this.opts.integrations?.();
    const token = await port?.value(operatorId, 'telegram-alerts', 'botToken').catch(() => undefined);
    const chatId = await port?.value(operatorId, 'telegram-alerts', 'chatId').catch(() => undefined);
    if (!token || !chatId) return false;
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      this.opts.logger.warn('[nautilus] no se pudo avisar por Telegram', { operatorId });
      return false;
    }
  }

  // ───── ciclo automático ─────

  /** Escanea todos los casinos activos y, pasada la hora del reporte, redacta el resumen de ayer si falta. */
  async tick(): Promise<void> {
    const ops = await this.db.operator.findMany({ where: { status: 'ACTIVE' }, select: { id: true, defaultCurrency: true } });
    for (const op of ops) {
      try {
        await this.scan(op.id);
        const offset = UTC_OFFSET_BY_CURRENCY[op.defaultCurrency] ?? 0;
        const localHour = new Date(this.now().getTime() + offset * 60_000).getUTCHours();
        if (localHour >= (this.opts.reportHour ?? 8)) {
          const day = this.localDay(op.defaultCurrency, -1);
          const done = await this.db.nautilusReport.findUnique({ where: { operatorId_day: { operatorId: op.id, day } }, select: { id: true } });
          if (!done) await this.report(op.id).catch((e) => {
            if (!(e instanceof HttpError && e.code === 'AI_NOT_CONNECTED')) this.opts.logger.warn('[nautilus] resumen diario falló', { operatorId: op.id, error: e instanceof Error ? e.message : String(e) });
          });
        }
      } catch (e) {
        this.opts.logger.error('[nautilus] escaneo falló', { operatorId: op.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
