import { createHash } from 'crypto';
import webpush from 'web-push';
import type { Server as SocketIOServer } from 'socket.io';
import type { ModuleLogger } from '../../shared/module';
import type { Channel, ChannelKind, ChannelMessage, InboxMessage, PushDesign, PushSubscription } from '../domain/types';
import type { Store } from './stores';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ChannelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ChannelError';
  }
}

/** Canal de desarrollo: registra el mensaje en el logger (sin datos sensibles más allá del destino enmascarado). */
export class LogChannel implements Channel {
  readonly sent: ChannelMessage[] = [];
  constructor(readonly kind: ChannelKind, private readonly logger?: ModuleLogger) {}
  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    this.sent.push(msg);
    this.logger?.info(`[marketing:${this.kind}] mensaje simulado`, { sendId: msg.sendId, to: maskAddress(msg.to), subject: msg.subject });
    return { providerMessageId: `log-${msg.sendId}` };
  }
}

export function maskAddress(to?: string): string | undefined {
  if (!to) return undefined;
  return to.length <= 4 ? '***' : `${to.slice(0, 2)}***${to.slice(-2)}`;
}

interface HttpChannelConfig {
  apiUrl: string;
  apiKey: string;
  from?: string;
  timeoutMs?: number;
}

async function postJson(fetchFn: FetchLike, cfg: HttpChannelConfig, payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetchFn(cfg.apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new ChannelError('PROVIDER_ERROR', `El proveedor respondió ${res.status}`);
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function providerId(json: Record<string, unknown>, fallback: string): string {
  const v = json.id ?? json.messageId ?? json.message_id;
  return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
}

/**
 * Email vía API HTTP de un proveedor transaccional genérico (MKT_EMAIL_API_URL / MKT_EMAIL_API_KEY).
 * Cuerpo JSON: { from, to, subject, html, text, headers }. Si el proveedor usa otro contrato, ajustar `buildPayload`.
 * SMTP se añadiría como otro adaptador de Channel (kind 'email') con nodemailer sin tocar el resto del módulo.
 */
export class EmailHttpChannel implements Channel {
  readonly kind = 'email' as const;
  constructor(private readonly cfg: HttpChannelConfig, private readonly fetchFn: FetchLike = fetch) {}

  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    if (!msg.to) throw new ChannelError('NO_ADDRESS', 'Sin email de destino');
    const json = await postJson(this.fetchFn, this.cfg, {
      from: this.cfg.from, to: msg.to, subject: msg.subject ?? '', html: msg.html ?? msg.text, text: msg.text, headers: msg.headers ?? {},
    });
    return { providerMessageId: providerId(json, `email-${msg.sendId}`) };
  }
}

/**
 * SMS vía agregador HTTP (MKT_SMS_API_URL / MKT_SMS_API_KEY / MKT_SMS_FROM).
 * TODO: el contrato real (campos, autenticación, callbacks de entrega) depende del proveedor contratado.
 */
export class SmsHttpChannel implements Channel {
  readonly kind = 'sms' as const;
  constructor(private readonly cfg: HttpChannelConfig, private readonly fetchFn: FetchLike = fetch) {}
  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    if (!msg.to) throw new ChannelError('NO_ADDRESS', 'Sin teléfono de destino');
    const json = await postJson(this.fetchFn, this.cfg, { from: this.cfg.from, to: msg.to, body: msg.text });
    return { providerMessageId: providerId(json, `sms-${msg.sendId}`) };
  }
}

/**
 * WhatsApp Business (MKT_WHATSAPP_API_URL / MKT_WHATSAPP_API_KEY).
 * TODO: WhatsApp exige plantillas pre-aprobadas por Meta/BSP; mapear `meta.templateName` al contrato del proveedor.
 */
export class WhatsAppHttpChannel implements Channel {
  readonly kind = 'whatsapp' as const;
  constructor(private readonly cfg: HttpChannelConfig, private readonly fetchFn: FetchLike = fetch) {}
  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    if (!msg.to) throw new ChannelError('NO_ADDRESS', 'Sin teléfono de destino');
    const json = await postJson(this.fetchFn, this.cfg, { to: msg.to, text: msg.text, template: msg.meta?.templateName });
    return { providerMessageId: providerId(json, `wa-${msg.sendId}`) };
  }
}

export const endpointId = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex').slice(0, 40);

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** mailto: o https: de contacto (lo exige el estándar). */
  subject: string;
}

/** Envío Web Push (inyectable en pruebas). Devuelve el status HTTP del servicio de push del navegador. */
export type PushSender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, vapid: VapidKeys) => Promise<{ statusCode: number }>;

export const webPushSender: PushSender = async (sub, payload, vapid) => {
  try {
    const r = await webpush.sendNotification(sub, payload, { vapidDetails: vapid, TTL: 24 * 3600, urgency: 'normal', timeout: 10_000 });
    return { statusCode: r.statusCode };
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (typeof status === 'number') return { statusCode: status };
    throw e;
  }
};

/** Claves VAPID del entorno; fuera de producción, efímeras si faltan (las suscripciones no sobreviven al reinicio). */
export function resolveVapid(env: NodeJS.ProcessEnv, logger?: ModuleLogger): VapidKeys | null {
  const { MKT_VAPID_PUBLIC_KEY: publicKey, MKT_VAPID_PRIVATE_KEY: privateKey } = env;
  const subject = env.MKT_VAPID_SUBJECT || 'mailto:soporte@infinite-abyss.local';
  if (publicKey && privateKey) return { publicKey, privateKey, subject };
  if (env.NODE_ENV === 'production') {
    logger?.warn('[marketing:push] sin MKT_VAPID_PUBLIC_KEY/MKT_VAPID_PRIVATE_KEY: los push no se envían');
    return null;
  }
  const k = webpush.generateVAPIDKeys();
  return { publicKey: k.publicKey, privateKey: k.privateKey, subject };
}

/**
 * Push web real (Web Push + VAPID, payload cifrado RFC 8291). Envía a todas las suscripciones del jugador
 * (móvil, escritorio…); las caducadas (404/410) se borran. Entregado si al menos un dispositivo lo aceptó.
 */
export class PushChannel implements Channel {
  readonly kind = 'push' as const;
  constructor(
    private readonly subs: Store<PushSubscription>,
    private readonly vapid: VapidKeys | null,
    private readonly logger?: ModuleLogger,
    private readonly sender: PushSender = webPushSender,
  ) {}

  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    if (!this.vapid) throw new ChannelError('NOT_CONFIGURED', 'Push sin claves VAPID');
    const subs = (await this.subs.list({ operatorId: msg.operatorId, playerId: msg.playerId })).filter((s) => !s.dead);
    if (subs.length === 0) throw new ChannelError('NO_ADDRESS', 'El jugador no tiene suscripciones push');
    const design = (msg.meta?.push ?? {}) as PushDesign;
    const internalPath = (u: unknown) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? u : undefined);
    const url = internalPath(design.url) ?? internalPath(msg.meta?.url) ?? '/lobby';
    const payload = JSON.stringify({
      title: msg.subject || 'Infinite Abyss', body: msg.text.slice(0, 300), url, tag: msg.sendId,
      ...(design.image ? { image: design.image } : {}),
      ...(design.actions?.length ? { actions: design.actions.slice(0, 2).filter((a) => internalPath(a.url)).map((a, i) => ({ action: `a${i}`, title: a.title.slice(0, 24), url: a.url })) } : {}),
    });
    let delivered = 0;
    for (const s of subs) {
      try {
        const r = await this.sender({ endpoint: s.endpoint, keys: s.keys }, payload, this.vapid);
        if (r.statusCode >= 200 && r.statusCode < 300) delivered++;
        // Vencida: se marca (no se borra) para que el navegador del jugador cree una nueva al volver.
        else if (r.statusCode === 404 || r.statusCode === 410) await this.subs.put({ ...s, dead: true });
        else this.logger?.warn('[marketing:push] el servicio de push rechazó el envío', { sendId: msg.sendId, status: r.statusCode });
      } catch (e) {
        this.logger?.warn('[marketing:push] envío fallido', { sendId: msg.sendId, error: (e as Error).message });
      }
    }
    if (!delivered) throw new ChannelError('DELIVERY_FAILED', 'Ningún dispositivo aceptó el push');
    return { providerMessageId: `push-${msg.sendId}-${delivered}` };
  }
}

/** Bandeja in-app en BD + emisión opcional por socket al room del jugador. */
export class InAppChannel implements Channel {
  readonly kind = 'inapp' as const;
  constructor(
    private readonly inbox: Store<InboxMessage>,
    private readonly io: SocketIOServer | undefined,
    private readonly clock: () => Date,
  ) {}
  static room(operatorId: string, playerId: string): string {
    return `player:${operatorId}:${playerId}`;
  }
  async send(msg: ChannelMessage): Promise<{ providerMessageId: string }> {
    const item: InboxMessage = {
      id: msg.sendId, operatorId: msg.operatorId, playerId: msg.playerId, subject: msg.subject, body: msg.text,
      sendId: msg.sendId, createdAt: this.clock().toISOString(),
    };
    await this.inbox.put(item);
    this.io?.to(InAppChannel.room(msg.operatorId, msg.playerId)).emit('marketing:inbox', { id: item.id, subject: item.subject, body: item.body });
    return { providerMessageId: item.id };
  }
}

export type ChannelRegistry = Partial<Record<ChannelKind, Channel>>;

/** Construye los canales según env; sin credenciales usa LogChannel (desarrollo). */
export function buildChannels(opts: {
  env: NodeJS.ProcessEnv;
  inbox: Store<InboxMessage>;
  pushSubs: Store<PushSubscription>;
  vapid?: VapidKeys | null;
  io?: SocketIOServer;
  clock: () => Date;
  logger: ModuleLogger;
  fetchFn?: FetchLike;
}): ChannelRegistry {
  const { env, logger } = opts;
  const pick = (kind: ChannelKind, prefix: string, ctor: new (c: HttpChannelConfig, f?: FetchLike) => Channel, from?: string): Channel => {
    const url = env[`${prefix}_API_URL`];
    const key = env[`${prefix}_API_KEY`];
    if (url && key) return new ctor({ apiUrl: url, apiKey: key, from }, opts.fetchFn);
    logger.warn(`[marketing] canal ${kind} sin credenciales (${prefix}_API_URL/KEY): se usa LogChannel`);
    return new LogChannel(kind, logger);
  };
  return {
    email: pick('email', 'MKT_EMAIL', EmailHttpChannel, env.MKT_EMAIL_FROM),
    sms: pick('sms', 'MKT_SMS', SmsHttpChannel, env.MKT_SMS_FROM),
    whatsapp: pick('whatsapp', 'MKT_WHATSAPP', WhatsAppHttpChannel),
    push: new PushChannel(opts.pushSubs, opts.vapid ?? null, logger),
    inapp: new InAppChannel(opts.inbox, opts.io, opts.clock),
  };
}
