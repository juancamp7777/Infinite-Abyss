import { randomBytes, randomUUID } from 'crypto';
import { HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import type { SecretBox } from '../domain/secretBox';
import type { ChannelType, Conversation, InboxChannel, InboxRepository, Message } from '../domain/types';
import { ChannelSendError, type ChannelAdapter, type WebhookRequest } from '../infrastructure/channels/ChannelAdapter';
import type { InboxService } from './InboxService';

/** Vista del canal para el backoffice: sin credenciales; con lo necesario para configurar el webhook. */
export interface ChannelView {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  publicInfo: Record<string, string>;
  webhookUrl: string | null;
  /** Solo WhatsApp: el "Verify token" que se pega en Meta. */
  verifyToken?: string;
  createdAt: Date;
}

/**
 * Canales externos del inbox (WhatsApp Cloud, Telegram): alta con credenciales cifradas, webhooks entrantes con
 * verificación de firma e idempotencia, y entrega de las respuestas de los agentes.
 */
export class ChannelService {
  private readonly adapters: Map<ChannelType, ChannelAdapter<any>>;

  constructor(
    private readonly repo: InboxRepository,
    private readonly inbox: InboxService,
    private readonly box: SecretBox,
    adapters: ChannelAdapter<any>[],
    private readonly opts: { publicBaseUrl?: string; logger: ModuleLogger },
  ) {
    this.adapters = new Map(adapters.map((a) => [a.type, a]));
    inbox.setDispatcher((conv, msg) => this.deliver(conv, msg));
  }

  webhookUrl(id: string): string | null {
    const base = this.opts.publicBaseUrl?.replace(/\/+$/, '');
    return base ? `${base}/inbox/v1/channels/${id}/webhook` : null;
  }

  private view(c: InboxChannel): ChannelView {
    return {
      id: c.id, type: c.type, name: c.name, enabled: c.enabled, publicInfo: c.publicInfo, webhookUrl: this.webhookUrl(c.id),
      ...(c.type === 'whatsapp' ? { verifyToken: c.webhookSecret } : {}), createdAt: c.createdAt,
    };
  }

  private adapter(type: ChannelType): ChannelAdapter<any> {
    const a = this.adapters.get(type);
    if (!a) throw new HttpError(400, 'BAD_REQUEST', `Canal no soportado: ${type}`);
    return a;
  }

  async list(operatorId: string): Promise<ChannelView[]> {
    return (await this.repo.listChannels(operatorId)).map((c) => this.view(c));
  }

  /** Alta de un canal. Telegram registra su webhook al momento (si hay URL pública); si falla, no se guarda. */
  async create(operatorId: string, type: ChannelType, name: string, rawConfig: unknown): Promise<{ channel: ChannelView; warning?: string }> {
    const a = this.adapter(type);
    const { config, publicInfo } = a.parseConfig(rawConfig);
    const now = new Date();
    const ch: InboxChannel = {
      id: randomUUID(), operatorId, type, name: name.trim().slice(0, 80) || publicInfo.phone || publicInfo.bot || type, enabled: true,
      webhookSecret: randomBytes(24).toString('base64url'), configEnc: this.box.seal(config), publicInfo, createdAt: now, updatedAt: now,
    };
    const warning = await this.activate(a, ch, config);
    return { channel: this.view(await this.repo.saveChannel(ch)), ...(warning ? { warning } : {}) };
  }

  async update(operatorId: string, id: string, patch: { name?: string; enabled?: boolean; config?: unknown }): Promise<{ channel: ChannelView; warning?: string }> {
    const ch = await this.must(operatorId, id);
    const next: InboxChannel = { ...ch, updatedAt: new Date() };
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 80) || ch.name;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    let warning: string | undefined;
    if (patch.config !== undefined) {
      const a = this.adapter(ch.type);
      const { config, publicInfo } = a.parseConfig(patch.config);
      next.configEnc = this.box.seal(config);
      next.publicInfo = publicInfo;
      warning = await this.activate(a, next, config);
    }
    return { channel: this.view(await this.repo.saveChannel(next)), ...(warning ? { warning } : {}) };
  }

  async remove(operatorId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteChannel(operatorId, id))) throw new HttpError(404, 'NOT_FOUND', 'Canal no encontrado');
  }

  /**
   * Webhook público. GET = verificación (WhatsApp). POST = mensajes: firma obligatoria; cada mensaje entra con
   * clientMsgId `<tipo>:<id del canal>` para que los reintentos del proveedor no dupliquen nada.
   * Devuelve el cuerpo de la respuesta; lanza 401/404 si el webhook no es auténtico.
   */
  async webhook(id: string, req: WebhookRequest): Promise<string | { ok: true; received: number }> {
    const ch = await this.repo.findChannel(id);
    if (!ch || !ch.enabled) throw new HttpError(404, 'NOT_FOUND', 'Canal no encontrado');
    const a = this.adapter(ch.type);
    if (req.method === 'GET') {
      const challenge = a.handshake?.(req, ch.webhookSecret) ?? null;
      if (challenge === null) throw new HttpError(403, 'FORBIDDEN', 'Verificación rechazada');
      return challenge;
    }
    const config = this.box.open(ch.configEnc);
    if (!a.verify(req, config, ch.webhookSecret)) throw new HttpError(401, 'UNAUTHORIZED', 'Firma inválida');
    let received = 0;
    for (const m of a.parse(req.body)) {
      try {
        const conv = await this.inbox.conversationFor({ operatorId: ch.operatorId, channel: ch.type, channelId: ch.id, externalId: `${ch.id}:${m.from}`, name: m.name });
        const clientMsgId = `${ch.type}:${m.messageId}`.slice(0, 64);
        const image = m.media && a.fetchMedia ? await a.fetchMedia(config, m.media.ref).catch((e: Error) => {
          this.opts.logger.warn('[inbox] imagen entrante no descargada', { channelId: ch.id, error: e.message });
          return null;
        }) : null;
        if (image) await this.inbox.contactAttachment(conv, image, m.body, clientMsgId, { skipRateLimit: true });
        else await this.inbox.contactMessage(conv, m.body, clientMsgId, { skipRateLimit: true });
        received += 1;
      } catch (e) {
        // Un mensaje inválido no debe hacer reintentar todo el lote al proveedor.
        this.opts.logger.warn('[inbox] mensaje entrante descartado', { channelId: ch.id, error: (e as Error).message });
      }
    }
    return { ok: true, received };
  }

  /** Envía una respuesta del agente por el canal de la conversación. */
  private async deliver(conv: Conversation, msg: Message): Promise<{ externalMessageId: string }> {
    if (!conv.channelId) throw new ChannelSendError('La conversación no tiene canal asociado');
    const ch = await this.repo.findChannel(conv.channelId);
    if (!ch || ch.operatorId !== conv.operatorId) throw new ChannelSendError('El canal de esta conversación ya no existe');
    if (!ch.enabled) throw new ChannelSendError('El canal está desactivado');
    const to = conv.externalId.slice(ch.id.length + 1);
    return this.adapter(ch.type).send(this.box.open(ch.configEnc), to, msg.body);
  }

  private async activate(a: ChannelAdapter<any>, ch: InboxChannel, config: unknown): Promise<string | undefined> {
    if (!a.activate) return undefined;
    const url = this.webhookUrl(ch.id);
    if (!url) return 'Define INBOX_PUBLIC_URL (URL pública https del API) para registrar el webhook automáticamente.';
    try {
      await a.activate(config, url, ch.webhookSecret);
      return undefined;
    } catch (e) {
      throw new HttpError(400, 'CHANNEL_ACTIVATION_FAILED', (e as Error).message);
    }
  }

  private async must(operatorId: string, id: string): Promise<InboxChannel> {
    const c = (await this.repo.listChannels(operatorId)).find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Canal no encontrado');
    return c;
  }
}
