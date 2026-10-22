import type { ChannelType } from '../../domain/types';

/** Mensaje entrante normalizado de un canal externo. */
export interface InboundMessage {
  /** Id del contacto en el canal (teléfono E.164 sin +, chat_id de Telegram). */
  from: string;
  name: string;
  /** Id único del mensaje en el canal: base de la idempotencia ante reintentos del webhook. */
  messageId: string;
  body: string;
  /** Imagen a descargar del proveedor (id de media de WhatsApp, file_id de Telegram). */
  media?: { ref: string };
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: Buffer;
  body: unknown;
}

/** POST JSON hacia la API del canal (inyectable en pruebas). */
export type HttpPost = (url: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>;

export const fetchPost: HttpPost = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** GET binario (descarga de imágenes), con tope de tamaño. Inyectable en pruebas. */
export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: Buffer }>;

export const fetchGet: HttpGet = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > 6 * 1024 * 1024) throw new ChannelSendError('Archivo demasiado grande');
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
};

export class ChannelSendError extends Error {}

export interface ChannelAdapter<C = Record<string, string>> {
  type: ChannelType;
  /** Valida y normaliza las credenciales que escribe el admin; devuelve también los datos públicos. */
  parseConfig(raw: unknown): { config: C; publicInfo: Record<string, string> };
  /** Respuesta al GET de verificación del webhook (WhatsApp); null = no aplica / rechazado. */
  handshake?(req: WebhookRequest, webhookSecret: string): string | null;
  /** Autenticidad del POST del webhook. */
  verify(req: WebhookRequest, config: C, webhookSecret: string): boolean;
  parse(body: unknown): InboundMessage[];
  /** Envía texto; devuelve el id del mensaje en el canal o lanza ChannelSendError. */
  send(config: C, to: string, text: string): Promise<{ externalMessageId: string }>;
  /** Descarga una imagen recibida. */
  fetchMedia?(config: C, ref: string): Promise<Buffer>;
  /** Tras guardar el canal (p. ej. registrar el webhook del bot de Telegram). */
  activate?(config: C, webhookUrl: string, webhookSecret: string): Promise<void>;
}

export const header = (h: WebhookRequest['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
