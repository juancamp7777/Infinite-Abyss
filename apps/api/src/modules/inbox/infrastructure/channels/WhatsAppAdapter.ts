import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { HttpError } from '../../../shared/http/errors';
import { ChannelSendError, fetchPost, header, type ChannelAdapter, type HttpPost, type InboundMessage } from './ChannelAdapter';

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  displayPhone: string;
  apiVersion: string;
}

const schema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'phoneNumberId numérico'),
  accessToken: z.string().trim().min(20).max(1000),
  appSecret: z.string().trim().regex(/^[0-9a-f]{32}$/i, 'App secret de 32 caracteres hexadecimales'),
  displayPhone: z.string().trim().max(30).default(''),
  apiVersion: z.string().trim().regex(/^v\d{1,3}\.\d$/).default('v21.0'),
});

/** Etiqueta legible para mensajes no textuales (el contenido multimedia llega en una fase posterior). */
const KIND_LABEL: Record<string, string> = {
  image: '📷 Imagen', audio: '🎤 Audio', video: '🎬 Video', document: '📄 Documento', sticker: '💬 Sticker', location: '📍 Ubicación', contacts: '👤 Contacto',
};

/**
 * WhatsApp Business Cloud API (Meta).
 * Webhook: GET con hub.verify_token (= webhookSecret del canal) y POST firmado con X-Hub-Signature-256 = sha256 HMAC del
 * cuerpo crudo con el App Secret. Envío: POST graph.facebook.com/<versión>/<phoneNumberId>/messages.
 */
export class WhatsAppAdapter implements ChannelAdapter<WhatsAppConfig> {
  readonly type = 'whatsapp' as const;

  constructor(private readonly http: HttpPost = fetchPost, private readonly graphBase = 'https://graph.facebook.com') {}

  parseConfig(raw: unknown) {
    const r = schema.safeParse(raw);
    if (!r.success) throw new HttpError(400, 'BAD_REQUEST', `Credenciales de WhatsApp inválidas: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return { config: r.data, publicInfo: { phone: r.data.displayPhone || `id ${r.data.phoneNumberId}`, phoneNumberId: r.data.phoneNumberId } };
  }

  handshake(req: Parameters<NonNullable<ChannelAdapter['handshake']>>[0], webhookSecret: string): string | null {
    const q = req.query;
    if (q['hub.mode'] !== 'subscribe' || typeof q['hub.challenge'] !== 'string') return null;
    return safeEqual(String(q['hub.verify_token'] ?? ''), webhookSecret) ? q['hub.challenge'] : null;
  }

  verify(req: Parameters<ChannelAdapter['verify']>[0], config: WhatsAppConfig): boolean {
    const sig = header(req.headers, 'x-hub-signature-256');
    if (!sig?.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', config.appSecret).update(req.rawBody).digest('hex');
    return safeEqual(sig.slice(7), expected);
  }

  parse(body: any): InboundMessage[] {
    const out: InboundMessage[] = [];
    if (body?.object !== 'whatsapp_business_account') return out;
    for (const entry of Array.isArray(body.entry) ? body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = change?.value;
        if (change?.field !== 'messages' || !v) continue;
        const names = new Map<string, string>();
        for (const c of Array.isArray(v.contacts) ? v.contacts : []) if (c?.wa_id) names.set(String(c.wa_id), String(c.profile?.name ?? ''));
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          if (typeof m?.from !== 'string' || typeof m?.id !== 'string') continue;
          const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
          const caption = m[m.type]?.caption;
          const body = typeof text === 'string' && text ? text : `${KIND_LABEL[m.type] ?? `[${m.type}]`}${typeof caption === 'string' && caption ? `: ${caption}` : ''}`;
          out.push({ from: m.from, name: names.get(m.from) || `+${m.from}`, messageId: m.id, body });
        }
      }
    }
    return out;
  }

  async send(config: WhatsAppConfig, to: string, text: string) {
    const url = `${this.graphBase}/${config.apiVersion}/${config.phoneNumberId}/messages`;
    const r = await this.http(url, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }, { authorization: `Bearer ${config.accessToken}` });
    const id = r.json?.messages?.[0]?.id;
    if (r.status >= 200 && r.status < 300 && typeof id === 'string') return { externalMessageId: id };
    const e = r.json?.error;
    // 131047: fuera de la ventana de 24 h → solo plantillas aprobadas.
    if (e?.code === 131047) throw new ChannelSendError('Pasaron más de 24 h desde el último mensaje del contacto: WhatsApp solo permite plantillas aprobadas');
    throw new ChannelSendError(`WhatsApp rechazó el envío (${r.status}${e?.code ? ` · ${e.code}` : ''}): ${String(e?.message ?? 'sin detalle').slice(0, 200)}`);
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
