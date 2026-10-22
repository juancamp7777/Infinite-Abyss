import { randomUUID } from 'crypto';
import type { ModuleDeps, ModuleLogger } from '../../shared/module';
import type { PlayerCompliancePort, PlayerComplianceStatus } from '../../shared/ports/PlayerCompliancePort';
import { renderTemplate, htmlToText } from '../domain/render';
import { isAllowedRedirect } from '../domain/urlSafety';
import { signUnsubscribeToken } from '../domain/unsubscribe';
import type { ChannelKind, Consent, ExclusionReason, OperatorBrand, SendLog, Template } from '../domain/types';
import type { ChannelRegistry } from '../infrastructure/channels';
import type { MarketingRepos } from '../infrastructure/stores';

export interface MessagingConfig {
  /** Máximo de mensajes de marketing por jugador dentro de la ventana. */
  frequencyCapMax: number;
  frequencyCapHours: number;
  publicBaseUrl: string;
  unsubscribeSecret: string;
  /** Dominios globales permitidos en clics (además de brand.linkDomains). */
  linkAllowlist: string[];
  defaultConversionWindowDays: number;
}

export type Eligibility = { ok: true; compliance: PlayerComplianceStatus } | { ok: false; reason: ExclusionReason };

export interface SendRequest {
  operatorId: string;
  playerId: string;
  templateId: string;
  refId?: string;
  refType?: 'campaign' | 'journey';
  variant?: string;
  vars?: Record<string, unknown>;
}

export interface MessagingDeps {
  repos: MarketingRepos;
  channels: ChannelRegistry;
  compliance: PlayerCompliancePort;
  clock: () => Date;
  config: MessagingConfig;
  logger: ModuleLogger;
  /** Resuelve servicios publicados por otros módulos (skins, crmTimeline). */
  services: () => Record<string, unknown>;
  newId?: () => string;
}

export class MessagingService {
  private readonly newId: () => string;
  constructor(private readonly d: MessagingDeps) {
    this.newId = d.newId ?? randomUUID;
  }

  /** Estado de cumplimiento (autoexclusión, límites, edad). Falla cerrado. */
  async checkCompliance(operatorId: string, playerId: string): Promise<Eligibility> {
    let c: PlayerComplianceStatus;
    try {
      c = await this.d.compliance.getStatus(operatorId, playerId);
    } catch (e) {
      this.d.logger.error('[marketing] cumplimiento no disponible; se excluye al jugador', { error: String(e) });
      return { ok: false, reason: 'COMPLIANCE_UNAVAILABLE' };
    }
    if (c.selfExcluded) return { ok: false, reason: 'SELF_EXCLUDED' };
    if (c.isMinor) return { ok: false, reason: 'MINOR' };
    if (!c.ageVerified) return { ok: false, reason: 'AGE_NOT_VERIFIED' };
    if (c.hasActiveLimits) return { ok: false, reason: 'ACTIVE_LIMITS' };
    return { ok: true, compliance: c };
  }

  /** GUARD CENTRAL de marketing: cumplimiento + opt-in del canal + límite de frecuencia. */
  async checkEligibility(operatorId: string, playerId: string, channel: ChannelKind): Promise<Eligibility> {
    const comp = await this.checkCompliance(operatorId, playerId);
    if (!comp.ok) return comp;
    const consent = await this.d.repos.consents.get(`${operatorId}:${playerId}:${channel}`);
    if (!consent?.optIn) return { ok: false, reason: 'NO_OPT_IN' };
    const since = this.d.clock().getTime() - this.d.config.frequencyCapHours * 3_600_000;
    const recent = await this.d.repos.sends.list({ operatorId, playerId, status: 'sent' });
    const count = recent.filter((s) => s.kind === 'marketing' && new Date(s.at).getTime() >= since).length;
    if (count >= this.d.config.frequencyCapMax) return { ok: false, reason: 'FREQUENCY_CAP' };
    return comp;
  }

  async getBrand(operatorId: string): Promise<OperatorBrand> {
    const skins = this.d.services().skins as { getSkin?: (op: string) => Promise<Record<string, unknown> | null> } | undefined;
    const own = await this.d.repos.brands.get(operatorId);
    if (skins?.getSkin) {
      try {
        const s = await skins.getSkin(operatorId);
        if (s) {
          return {
            id: operatorId, operatorId, name: String(s.name ?? own?.name ?? operatorId),
            logoUrl: (s.logoUrl as string | undefined) ?? own?.logoUrl,
            primaryColor: (s.primaryColor as string | undefined) ?? own?.primaryColor,
            supportEmail: own?.supportEmail, linkDomains: own?.linkDomains ?? [],
          };
        }
      } catch (e) {
        this.d.logger.warn('[marketing] servicio de skins falló; se usa la marca propia', { error: String(e) });
      }
    }
    return own ?? { id: operatorId, operatorId, name: operatorId, linkDomains: [] };
  }

  unsubscribeUrl(operatorId: string, playerId: string, channel: ChannelKind): string {
    const t = signUnsubscribeToken(this.d.config.unsubscribeSecret, operatorId, playerId, channel);
    return `${this.d.config.publicBaseUrl}/marketing/v1/unsubscribe?t=${encodeURIComponent(t)}`;
  }

  /** Envío de marketing: SIEMPRE pasa por el guard. Devuelve el SendLog (sent | excluded | failed). */
  async sendMarketing(req: SendRequest): Promise<SendLog> {
    const tpl = await this.loadTemplate(req);
    if (tpl.kind !== 'marketing') throw new Error('Plantilla no es de marketing: usa sendTransactional');
    const elig = await this.checkEligibility(req.operatorId, req.playerId, tpl.channel);
    if (!elig.ok) return this.logExcluded(req, tpl, elig.reason);
    return this.deliver(req, tpl, elig.compliance);
  }

  /** Mensajes transaccionales/regulatorios (p. ej. confirmaciones, avisos legales): no pasan por el guard de marketing. */
  async sendTransactional(req: SendRequest): Promise<SendLog> {
    const tpl = await this.loadTemplate(req);
    if (tpl.kind === 'marketing') throw new Error('Plantilla de marketing: usa sendMarketing');
    let compliance: PlayerComplianceStatus = { selfExcluded: false, hasActiveLimits: false, ageVerified: false, isMinor: false };
    try {
      compliance = await this.d.compliance.getStatus(req.operatorId, req.playerId);
    } catch {
      /* se envía igualmente: es obligatorio informar */
    }
    return this.deliver(req, tpl, compliance);
  }

  private async loadTemplate(req: SendRequest): Promise<Template> {
    const tpl = await this.d.repos.templates.get(req.templateId);
    if (!tpl || tpl.operatorId !== req.operatorId) throw new Error(`Plantilla ${req.templateId} no existe para el operador`);
    return tpl;
  }

  private async record(req: SendRequest, tpl: Template, patch: Partial<SendLog> & Pick<SendLog, 'status'>, id = this.newId()): Promise<SendLog> {
    const log: SendLog = {
      id, operatorId: req.operatorId, playerId: req.playerId, channel: tpl.channel, kind: tpl.kind, refId: req.refId,
      refType: req.refType, variant: req.variant, templateId: tpl.id, at: this.d.clock().toISOString(), ...patch,
    };
    await this.d.repos.sends.put(log);
    await this.timeline(log);
    return log;
  }

  private logExcluded(req: SendRequest, tpl: Template, reason: ExclusionReason): Promise<SendLog> {
    return this.record(req, tpl, { status: 'excluded', reason });
  }

  private async timeline(log: SendLog): Promise<void> {
    const tl = this.d.services().crmTimeline as { add?: (e: Record<string, unknown>) => unknown } | undefined;
    if (!tl?.add) return;
    try {
      await tl.add({
        operatorId: log.operatorId, playerId: log.playerId, type: 'marketing.message', at: log.at,
        title: `Marketing ${log.channel}: ${log.status}${log.reason ? ` (${log.reason})` : ''}`,
        data: { sendId: log.id, refId: log.refId, variant: log.variant },
      });
    } catch (e) {
      this.d.logger.warn('[marketing] no se pudo añadir a la línea de tiempo del CRM', { error: String(e) });
    }
  }

  private async deliver(req: SendRequest, tpl: Template, compliance: PlayerComplianceStatus): Promise<SendLog> {
    const channel = this.d.channels[tpl.channel];
    if (!channel) return this.record(req, tpl, { status: 'failed', reason: 'CHANNEL_NOT_CONFIGURED' });
    const state = await this.d.repos.players.get(`${req.operatorId}:${req.playerId}`);
    const to =
      tpl.channel === 'email' ? (state?.email ?? compliance.email)
      : tpl.channel === 'sms' || tpl.channel === 'whatsapp' ? compliance.phone
      : undefined;
    if ((tpl.channel === 'email' || tpl.channel === 'sms' || tpl.channel === 'whatsapp') && !to) {
      return this.record(req, tpl, { status: 'excluded', reason: 'NO_ADDRESS' });
    }
    const brand = await this.getBrand(req.operatorId);
    const sendId = this.newId();
    const unsubscribeUrl = this.unsubscribeUrl(req.operatorId, req.playerId, tpl.channel);
    const vars: Record<string, unknown> = {
      firstName: state?.firstName ?? '',
      ...req.vars,
      operator: { name: brand.name, logoUrl: brand.logoUrl ?? '', primaryColor: brand.primaryColor ?? '', supportEmail: brand.supportEmail ?? '' },
      unsubscribeUrl,
    };
    const subject = tpl.subject ? renderTemplate(tpl.subject, vars, { mode: 'text' }) : undefined;
    let text: string;
    let html: string | undefined;
    const headers: Record<string, string> = {};
    if (tpl.channel === 'email') {
      let body = renderTemplate(tpl.body, vars, { mode: 'html', rawKeys: ['unsubscribeUrl'] });
      body = this.rewriteLinks(body, sendId, [...this.d.config.linkAllowlist, ...brand.linkDomains]);
      if (tpl.kind === 'marketing') {
        if (!tpl.body.includes('{{unsubscribeUrl')) {
          body += `<p style="font-size:12px;color:#888"><a href="${unsubscribeUrl}">Darme de baja</a></p>`;
        }
        headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      html = `${body}<img src="${this.d.config.publicBaseUrl}/marketing/v1/t/o/${sendId}.gif" width="1" height="1" alt="" style="display:none">`;
      text = htmlToText(body);
    } else {
      text = renderTemplate(tpl.body, vars, { mode: 'text' });
    }
    await this.record(req, tpl, { status: 'queued' }, sendId);
    try {
      const { providerMessageId } = await channel.send({ sendId, operatorId: req.operatorId, playerId: req.playerId, to, subject, text, html, headers, meta: { templateName: tpl.name } });
      return await this.record(req, tpl, { status: 'sent', providerMessageId }, sendId);
    } catch (e) {
      this.d.logger.error('[marketing] fallo de envío', { sendId, channel: tpl.channel, error: e instanceof Error ? e.message : String(e) });
      return this.record(req, tpl, { status: 'failed', reason: e instanceof Error ? e.message : 'SEND_ERROR' }, sendId);
    }
  }

  /** Reemplaza href http(s) permitidos por el redirect con tracking de clics. */
  private rewriteLinks(html: string, sendId: string, allowed: string[]): string {
    return html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, href: string) => {
      const raw = href.replace(/&amp;/g, '&');
      if (raw.includes('/marketing/v1/unsubscribe') || !isAllowedRedirect(raw, allowed)) return m;
      return `href="${this.d.config.publicBaseUrl}/marketing/v1/t/c/${sendId}?u=${encodeURIComponent(raw)}"`;
    });
  }
}

/** Consentimiento por canal. */
export class ConsentService {
  constructor(private readonly repos: MarketingRepos, private readonly clock: () => Date) {}

  async get(operatorId: string, playerId: string, channel: ChannelKind): Promise<Consent | null> {
    return this.repos.consents.get(`${operatorId}:${playerId}:${channel}`);
  }

  async set(operatorId: string, playerId: string, channel: ChannelKind, optIn: boolean, source: string): Promise<Consent> {
    const id = `${operatorId}:${playerId}:${channel}`;
    const at = this.clock().toISOString();
    const prev = await this.repos.consents.get(id);
    const history = [...(prev?.history ?? []), { optIn, source, at }].slice(-50);
    return this.repos.consents.put({ id, operatorId, playerId, channel, optIn, source, at, history });
  }

  async list(operatorId: string, playerId: string): Promise<Consent[]> {
    return this.repos.consents.list({ operatorId, playerId });
  }
}
