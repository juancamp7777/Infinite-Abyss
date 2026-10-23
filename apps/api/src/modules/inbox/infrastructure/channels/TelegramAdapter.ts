import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { HttpError } from '../../../shared/http/errors';
import { ChannelSendError, fetchGet, fetchPost, header, type ChannelAdapter, type HttpGet, type HttpPost, type InboundMessage } from './ChannelAdapter';

export interface TelegramConfig {
  botToken: string;
  botUsername: string;
}

const schema = z.object({
  botToken: z.string().trim().regex(/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/, 'Token de BotFather (123456:ABC…)'),
  botUsername: z.string().trim().regex(/^@?[A-Za-z0-9_]{3,64}$/).optional(),
});

/**
 * Telegram Bot API. El webhook se registra con setWebhook y `secret_token` (= webhookSecret del canal), que Telegram
 * devuelve en X-Telegram-Bot-Api-Secret-Token en cada update. Solo chats privados.
 */
export class TelegramAdapter implements ChannelAdapter<TelegramConfig> {
  readonly type = 'telegram' as const;

  constructor(private readonly http: HttpPost = fetchPost, private readonly apiBase = 'https://api.telegram.org', private readonly get: HttpGet = fetchGet) {}

  parseConfig(raw: unknown) {
    const r = schema.safeParse(raw);
    if (!r.success) throw new HttpError(400, 'BAD_REQUEST', `Credenciales de Telegram inválidas: ${r.error.issues.map((i) => i.message).join('; ')}`);
    const botUsername = (r.data.botUsername ?? '').replace(/^@/, '');
    return { config: { botToken: r.data.botToken, botUsername }, publicInfo: { bot: botUsername ? `@${botUsername}` : `bot ${r.data.botToken.split(':')[0]}` } };
  }

  verify(req: Parameters<ChannelAdapter['verify']>[0], _config: TelegramConfig, webhookSecret: string): boolean {
    const got = Buffer.from(header(req.headers, 'x-telegram-bot-api-secret-token') ?? '');
    const want = Buffer.from(webhookSecret);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  parse(body: any): InboundMessage[] {
    const m = body?.message ?? body?.edited_message;
    if (!m || m.chat?.type !== 'private' || typeof body.update_id !== 'number') return [];
    const from = m.from ?? {};
    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? `@${from.username}` : `Telegram ${m.chat.id}`);
    const text = typeof m.text === 'string' ? m.text : m.photo ? '📷 Imagen' : m.voice ? '🎤 Audio' : m.document ? '📄 Documento' : m.sticker ? `💬 Sticker ${m.sticker.emoji ?? ''}`.trim() : '[mensaje no soportado]';
    const caption = typeof m.caption === 'string' && m.caption ? `: ${m.caption}` : '';
    // La foto más grande es la última del arreglo; los documentos solo si son imágenes.
    const fileId = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1]?.file_id : /^image\//.test(String(m.document?.mime_type ?? '')) ? m.document?.file_id : undefined;
    return [{ from: String(m.chat.id), name, messageId: `${body.edited_message ? 'edit-' : ''}${body.update_id}`, body: `${text}${m.text ? '' : caption}`, ...(typeof fileId === 'string' ? { media: { ref: fileId } } : {}) }];
  }

  async fetchMedia(config: TelegramConfig, ref: string): Promise<Buffer> {
    const r = await this.http(`${this.apiBase}/bot${config.botToken}/getFile`, { file_id: ref });
    const path = r.json?.result?.file_path;
    if (!r.json?.ok || typeof path !== 'string' || path.includes('..')) throw new ChannelSendError('Telegram no entregó la imagen');
    const file = await this.get(`${this.apiBase}/file/bot${config.botToken}/${path}`);
    if (file.status !== 200) throw new ChannelSendError(`Descarga de imagen fallida (${file.status})`);
    return file.body;
  }

  async send(config: TelegramConfig, to: string, text: string) {
    const r = await this.http(`${this.apiBase}/bot${config.botToken}/sendMessage`, { chat_id: to, text });
    const id = r.json?.result?.message_id;
    if (r.json?.ok && id !== undefined) return { externalMessageId: String(id) };
    throw new ChannelSendError(`Telegram rechazó el envío (${r.status}): ${String(r.json?.description ?? 'sin detalle').slice(0, 200)}`);
  }

  async activate(config: TelegramConfig, webhookUrl: string, webhookSecret: string) {
    const r = await this.http(`${this.apiBase}/bot${config.botToken}/setWebhook`, { url: webhookUrl, secret_token: webhookSecret, allowed_updates: ['message', 'edited_message'], drop_pending_updates: false });
    if (!r.json?.ok) throw new ChannelSendError(`Telegram no aceptó el webhook: ${String(r.json?.description ?? r.status).slice(0, 200)}`);
    await this.setupProfile(config);
  }

  /** Deja el bot presentable sin pasar por BotFather: descripción, texto corto y menú de comandos. Si algo falla, el canal sigue activo. */
  private async setupProfile(config: TelegramConfig) {
    const base = `${this.apiBase}/bot${config.botToken}`;
    const steps: Array<[string, Record<string, unknown>]> = [
      ['setMyShortDescription', { short_description: 'Recargas, retiros y soporte 24/7 del casino. Escríbenos y te atendemos al instante.' }],
      ['setMyDescription', { description: '👋 ¡Bienvenido!\n\nPor aquí puedes:\n• Recargar saldo con los medios de pago de tu país\n• Pedir tu retiro\n• Comprar paquetes y bonos\n• Hablar con una persona, 24/7\n\nToca INICIAR y escríbenos.' }],
      ['setMyCommands', { commands: [{ command: 'start', description: 'Empezar' }, { command: 'recargar', description: 'Recargar saldo' }, { command: 'retirar', description: 'Pedir un retiro' }, { command: 'soporte', description: 'Hablar con una persona' }] }],
    ];
    for (const [method, body] of steps) await this.http(`${base}/${method}`, body).catch(() => undefined);
  }
}
