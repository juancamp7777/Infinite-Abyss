import type { DomainEvents } from '../../shared/events/EventBus';
import type { SegmentPort } from '../../shared/ports/SegmentPort';
import type { ModuleLogger } from '../../shared/module';
import { assignVariant } from '../domain/ab';
import type { Campaign, SendLog } from '../domain/types';
import type { MarketingRepos } from '../infrastructure/stores';
import type { MessagingService } from './MessagingService';

export interface VariantMetrics {
  variant: string;
  sent: number;
  delivered: number;
  excluded: number;
  failed: number;
  opened: number;
  clicked: number;
  converted: number;
  conversionRate: number;
  openRate: number;
  clickRate: number;
  excludedByReason: Record<string, number>;
}

export class CampaignService {
  constructor(
    private readonly repos: MarketingRepos,
    private readonly messaging: MessagingService,
    private readonly segments: () => SegmentPort | undefined,
    private readonly clock: () => Date,
    private readonly logger: ModuleLogger,
  ) {}

  private async sendTo(c: Campaign, playerId: string): Promise<SendLog> {
    const v = assignVariant(c.variants, playerId, c.id);
    return this.messaging.sendMarketing({
      operatorId: c.operatorId, playerId, templateId: v.templateId, refId: c.id, refType: 'campaign', variant: v.key,
    });
  }

  /** Lanza una campaña one-shot sobre su segmento. Marca 'running' antes de enviar (evita doble lanzamiento). */
  async launch(c: Campaign): Promise<Campaign> {
    if (c.status === 'running' || c.status === 'done') return c;
    const seg = this.segments();
    if (!c.segmentId || !seg) throw new Error('La campaña one-shot requiere segmentId y el servicio de segmentos');
    c.status = 'running';
    c.updatedAt = this.clock().toISOString();
    await this.repos.campaigns.put(c);
    const players = await seg.listPlayers(c.operatorId, c.segmentId);
    c.stats = { audience: players.length, processed: 0 };
    for (const p of players) {
      try {
        await this.sendTo(c, p);
      } catch (e) {
        this.logger.error('[marketing] fallo enviando campaña', { campaignId: c.id, error: String(e) });
      }
      c.stats.processed += 1;
    }
    c.status = 'done';
    c.updatedAt = this.clock().toISOString();
    return this.repos.campaigns.put(c);
  }

  async tick(now: Date): Promise<void> {
    const due = await this.repos.campaigns.list({ status: 'scheduled', dueBefore: new Date(now.getTime() + 1).toISOString() });
    for (const c of due) await this.launch(c);
  }

  async onEvent<K extends 'player.registered' | 'deposit.completed' | 'login' | 'bet.settled'>(name: K, e: DomainEvents[K]): Promise<void> {
    const active = await this.repos.campaigns.list({ operatorId: e.operatorId, status: 'active' });
    for (const c of active) {
      if (c.triggerEvent !== name) continue;
      if (c.segmentId) {
        const seg = this.segments();
        if (!seg || !(await seg.isMember(c.operatorId, c.segmentId, e.playerId))) continue;
      }
      await this.sendTo(c, e.playerId);
    }
  }

  /** Atribuye el depósito al envío de marketing más reciente dentro de la ventana de conversión. */
  async attributeDeposit(e: DomainEvents['deposit.completed'], defaultWindowDays: number): Promise<SendLog | null> {
    const at = new Date(e.at).getTime();
    const sends = await this.repos.sends.list({ operatorId: e.operatorId, playerId: e.playerId, status: 'sent' });
    const candidates: Array<{ s: SendLog; windowDays: number }> = [];
    for (const s of sends) {
      if (s.kind !== 'marketing' || !s.refId || s.convertedAt) continue;
      let windowDays = defaultWindowDays;
      if (s.refType === 'campaign') windowDays = (await this.repos.campaigns.get(s.refId))?.conversionWindowDays ?? defaultWindowDays;
      const sentAt = new Date(s.at).getTime();
      if (sentAt <= at && at - sentAt <= windowDays * 86_400_000) candidates.push({ s, windowDays });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => new Date(b.s.at).getTime() - new Date(a.s.at).getTime());
    const hit = candidates[0].s;
    hit.convertedAt = e.at;
    hit.conversionAmount = e.amount.toString();
    await this.repos.sends.put(hit);
    return hit;
  }

  async markOpened(sendId: string): Promise<void> {
    const s = await this.repos.sends.get(sendId);
    if (s && !s.openedAt) {
      s.openedAt = this.clock().toISOString();
      await this.repos.sends.put(s);
    }
  }

  async markClicked(sendId: string): Promise<void> {
    const s = await this.repos.sends.get(sendId);
    if (!s) return;
    const now = this.clock().toISOString();
    if (!s.clickedAt) s.clickedAt = now;
    if (!s.openedAt) s.openedAt = now; // un clic implica apertura
    await this.repos.sends.put(s);
  }

  /** Métricas por variante de una campaña o journey. "Entregado" = aceptado por el proveedor del canal. */
  async metrics(operatorId: string, refId: string): Promise<{ total: VariantMetrics; variants: VariantMetrics[] }> {
    const logs = await this.repos.sends.list({ operatorId, refId });
    const groups = new Map<string, SendLog[]>();
    for (const l of logs) groups.set(l.variant ?? '-', [...(groups.get(l.variant ?? '-') ?? []), l]);
    const calc = (variant: string, rows: SendLog[]): VariantMetrics => {
      const sent = rows.filter((r) => r.status === 'sent');
      const excludedByReason: Record<string, number> = {};
      for (const r of rows.filter((x) => x.status === 'excluded')) excludedByReason[r.reason ?? '?'] = (excludedByReason[r.reason ?? '?'] ?? 0) + 1;
      const n = sent.length;
      const opened = sent.filter((r) => r.openedAt).length;
      const clicked = sent.filter((r) => r.clickedAt).length;
      const converted = sent.filter((r) => r.convertedAt).length;
      return {
        variant, sent: n, delivered: n, excluded: rows.filter((r) => r.status === 'excluded').length,
        failed: rows.filter((r) => r.status === 'failed').length, opened, clicked, converted,
        conversionRate: n ? converted / n : 0, openRate: n ? opened / n : 0, clickRate: n ? clicked / n : 0, excludedByReason,
      };
    };
    return { total: calc('total', logs), variants: [...groups.entries()].map(([k, v]) => calc(k, v)) };
  }
}
