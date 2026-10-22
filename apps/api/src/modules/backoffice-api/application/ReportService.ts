import { badRequest, HttpError } from '../../shared/http/errors';
import { toCsv, type CsvCell } from './csv';
import { findService, type DashboardService } from './DashboardService';

export const REPORT_TYPES = ['kpis-daily', 'players', 'providers', 'bonuses', 'campaigns', 'jackpots'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const isReportType = (v: string): v is ReportType => (REPORT_TYPES as readonly string[]).includes(v);

export interface ReportRequest {
  operatorId?: string;
  from: string;
  to: string;
}

const MAX_ROWS = 50_000;

/** Genera reportes CSV con los services de los demás módulos (si faltan responde 501 con mensaje claro). */
export class ReportService {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly services: Record<string, unknown>,
  ) {}

  private need<T>(label: string, svc: T | undefined): T {
    if (!svc) throw new HttpError(501, 'MODULE_UNAVAILABLE', `El módulo ${label} no está montado`);
    return svc;
  }

  async csv(type: ReportType, q: ReportRequest): Promise<string> {
    switch (type) {
      case 'kpis-daily': return this.kpis(q);
      case 'players': return this.players(q);
      case 'providers': return this.providers(q);
      case 'bonuses': return this.bonuses(q);
      case 'campaigns': return this.campaigns(q);
      case 'jackpots': return this.jackpots(q);
    }
  }

  private async kpis(q: ReportRequest): Promise<string> {
    const rows = await this.dashboard.rows(q.operatorId, q.from, q.to);
    return toCsv(
      ['day', 'operatorId', 'registrations', 'logins', 'activePlayers', 'depositors', 'ftdCount', 'ftdAmount', 'depositsCount', 'depositsAmount', 'withdrawalsCount', 'withdrawalsAmount', 'betCount', 'bets', 'wins', 'ggr', 'bonusCost', 'jackpotFunding', 'ngr'],
      rows.map((r) => [r.day, r.operatorId, r.registrations, r.logins, r.activePlayers, r.depositors, r.ftdCount, r.ftdAmount, r.depositsCount, r.depositsAmount, r.withdrawalsCount, r.withdrawalsAmount, r.betCount, r.settledStake, r.settledWins, r.ggr, r.bonusCost, r.jackpotFunding, r.ngr]),
    );
  }

  private async players(q: ReportRequest): Promise<string> {
    const crm = this.need('crm', findService<any>(this.services, 'crmProfiles'));
    if (!q.operatorId) throw badRequest('Indica operatorId para el reporte de jugadores');
    const views: any[] = (await crm.listViews(q.operatorId)).slice(0, MAX_ROWS);
    return toCsv(
      ['playerId', 'country', 'currency', 'registeredAt', 'lastLoginAt', 'depositsTotal', 'depositsCount', 'withdrawalsTotal', 'totalWagered', 'totalWon', 'ggr', 'ltv', 'betCount', 'churnRisk', 'vipScore', 'tags'],
      views.map((v) => [v.playerId, v.country, v.currency, v.registeredAt, v.lastLoginAt, v.depositsTotal, v.depositsCount, v.withdrawalsTotal, v.totalWagered, v.totalWon, v.ggr, v.ltv, v.betCount, v.churnRisk, v.vipScore, (v.tags ?? []).join(';')]),
    );
  }

  private async providers(q: ReportRequest): Promise<string> {
    const hub = this.need('hub', findService<any>(this.services, 'hubReports'));
    const rep = await hub.providers({ ...(q.operatorId ? { operatorId: q.operatorId } : {}), from: new Date(`${q.from}T00:00:00Z`), to: new Date(`${q.to}T23:59:59.999Z`) });
    return toCsv(
      ['providerId', 'providerName', 'bets', 'wins', 'ggr', 'rounds', 'openRounds'],
      (rep.providers as any[]).map((p) => [p.providerId, p.providerName, p.bets, p.wins, p.ggr, p.rounds, p.openRounds]),
    );
  }

  private async bonuses(q: ReportRequest): Promise<string> {
    const promo = this.need('promotions', findService<any>(this.services, 'promotions'));
    const list: any[] = await promo.bonuses.listBonuses({ ...(q.operatorId ? { operatorId: q.operatorId } : {}), limit: MAX_ROWS });
    return toCsv(
      ['id', 'operatorId', 'playerId', 'type', 'status', 'currency', 'amount', 'createdAt', 'activatedAt'],
      list.slice(0, MAX_ROWS).map((b) => [b.id, b.operatorId, b.playerId, b.type, b.status, b.currency, b.amount, b.createdAt, b.activatedAt]),
    );
  }

  private async campaigns(q: ReportRequest): Promise<string> {
    const mkt = this.need('marketing', findService<any>(this.services, 'marketing'));
    if (!q.operatorId) throw badRequest('Indica operatorId para el reporte de campañas');
    const camps: any[] = await mkt.repos.campaigns.list({ operatorId: q.operatorId });
    const rows: CsvCell[][] = [];
    for (const c of camps) {
      const m = await mkt.campaigns.metrics(q.operatorId, c.id);
      for (const v of m.variants.length ? m.variants : [m.total]) {
        rows.push([c.id, c.name, c.status, c.channel, v.variant, v.sent, v.delivered, v.excluded, v.failed, v.opened, v.clicked, v.converted, v.openRate, v.clickRate, v.conversionRate]);
      }
    }
    return toCsv(['campaignId', 'name', 'status', 'channel', 'variant', 'sent', 'delivered', 'excluded', 'failed', 'opened', 'clicked', 'converted', 'openRate', 'clickRate', 'conversionRate'], rows);
  }

  private async jackpots(q: ReportRequest): Promise<string> {
    const promo = this.need('promotions', findService<any>(this.services, 'promotions'));
    const list: any[] = await promo.jackpots.list(q.operatorId);
    const rows: CsvCell[][] = [];
    for (const j of list) {
      let rep: any = {};
      try {
        rep = await promo.jackpots.report(q.operatorId ?? j.operatorId, j.id);
      } catch {
        rep = {};
      }
      for (const l of j.levels as any[]) {
        rows.push([j.id, j.operatorId, j.name, j.status, j.currency, l.key, l.seedAmount, l.currentAmount, j.contributionBps, rep.contributions, rep.seedFunding, rep.payouts]);
      }
    }
    return toCsv(['jackpotId', 'operatorId', 'name', 'status', 'currency', 'level', 'seedAmount', 'currentAmount', 'contributionBps', 'totalContributions', 'totalSeedFunding', 'totalPayouts'], rows);
  }
}
