/** Inbox omnicanal: conversaciones con contactos (jugadores o visitantes) atendidas por agentes del operador. */

export type Channel = 'webchat' | 'whatsapp' | 'telegram';
export type ConversationStatus = 'open' | 'pending' | 'closed';
/**
 * Salas: en qué etapa está el contacto. new_lead → client (primer depósito) · vip · deposit_review (comprobante en revisión)
 * · withdraw (retiro pedido) · support (atención humana). En las tres últimas el bot de Tide no responde.
 */
export const STAGES = ['new_lead', 'client', 'vip', 'deposit_review', 'withdraw', 'support'] as const;
export type Stage = (typeof STAGES)[number];
export const BOT_SILENT_STAGES: readonly Stage[] = ['deposit_review', 'withdraw', 'support'];
/** in = del contacto; out = respuesta visible para el contacto; note = nota interna (NUNCA se envía al contacto). */
export type Direction = 'in' | 'out' | 'note';
export type AuthorType = 'contact' | 'agent' | 'bot' | 'system';

export const MAX_BODY = 4000;

export interface Conversation {
  id: string;
  operatorId: string;
  channel: Channel;
  /** Id del contacto en el canal: visitante del webchat, teléfono, chat de Telegram… */
  externalId: string;
  /** Canal configurado por el que entra/sale (WhatsApp o Telegram); webchat no lo usa. */
  channelId?: string;
  /** Jugador del casino si se identificó (identidad única contacto ↔ jugador). */
  playerId?: string;
  contactName: string;
  status: ConversationStatus;
  stage: Stage;
  assigneeId?: string;
  lastMessageAt: Date;
  lastMessagePreview: string;
  /** Mensajes del contacto aún no leídos por los agentes. */
  unread: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  operatorId: string;
  direction: Direction;
  authorType: AuthorType;
  authorId?: string;
  body: string;
  /** Id del cliente para reintentos idempotentes (único por conversación). */
  clientMsgId?: string;
  /** Imagen adjunta (comprobantes, capturas). */
  attachmentId?: string;
  /** Id del mensaje en el canal externo (wamid, message_id de Telegram). */
  externalMessageId?: string;
  /** Entrega de respuestas por canales externos. */
  status?: DeliveryStatus;
  error?: string;
  createdAt: Date;
}

export type DeliveryStatus = 'sent' | 'failed';

/** Archivo enviado por el contacto (solo imágenes; máx. MAX_ATTACHMENT bytes). */
export interface Attachment {
  id: string;
  operatorId: string;
  conversationId: string;
  mime: string;
  size: number;
  sha256: string;
  data: Buffer;
  createdAt: Date;
}

export const MAX_ATTACHMENT = 5 * 1024 * 1024;
const SIGNATURES: Array<[string, (b: Buffer) => boolean]> = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
/** Tipo real por firma de bytes (no se confía en la extensión ni en el Content-Type). */
export const sniffImage = (b: Buffer): string | null => (b.length >= 12 ? SIGNATURES.find(([, ok]) => ok(b))?.[0] ?? null : null);
export type ChannelType = Exclude<Channel, 'webchat'>;

/** Canal externo del operador (un número de WhatsApp Business, un bot de Telegram…). */
export interface InboxChannel {
  id: string;
  operatorId: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  /** Secreto aleatorio del webhook (verify token de Meta / secret_token de Telegram). */
  webhookSecret: string;
  /** Credenciales cifradas (AES-256-GCM); nunca salen por la API. */
  configEnc: string;
  /** Datos no sensibles para mostrar (número, @bot). */
  publicInfo: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuickReply {
  id: string;
  operatorId: string;
  shortcut: string;
  body: string;
  createdAt: Date;
}

export interface Visitor {
  id: string;
  operatorId: string;
  /** sha256 del token del visitante (el token en claro solo lo tiene el navegador). */
  tokenHash: string;
  name: string;
  createdAt: Date;
}

export interface ConversationFilter {
  status?: ConversationStatus;
  stage?: Stage;
  assigneeId?: string | null;
  q?: string;
  limit: number;
}

export interface InboxRepository {
  findConversation(operatorId: string, id: string): Promise<Conversation | null>;
  /** Conversación más reciente del contacto en el canal (cualquier estado: se reabre al escribir). */
  findLatestByExternal(operatorId: string, channel: Channel, externalId: string): Promise<Conversation | null>;
  saveConversation(c: Conversation): Promise<Conversation>;
  listConversations(operatorId: string, f: ConversationFilter): Promise<Conversation[]>;
  addMessage(m: Message): Promise<Message>;
  findMessageByClientId(conversationId: string, clientMsgId: string): Promise<Message | null>;
  listMessages(conversationId: string, opts: { includeNotes: boolean; after?: Date; limit: number }): Promise<Message[]>;
  listQuickReplies(operatorId: string): Promise<QuickReply[]>;
  saveQuickReply(q: QuickReply): Promise<QuickReply>;
  deleteQuickReply(operatorId: string, id: string): Promise<boolean>;
  saveMessage(m: Message): Promise<Message>;
  saveAttachment(a: Attachment): Promise<Attachment>;
  findAttachment(operatorId: string, id: string): Promise<Attachment | null>;
  saveVisitor(v: Visitor): Promise<Visitor>;
  findVisitorByTokenHash(tokenHash: string): Promise<Visitor | null>;
  listChannels(operatorId: string): Promise<InboxChannel[]>;
  /** Sin filtro de operador: lo usa el webhook público (que luego verifica la firma). */
  findChannel(id: string): Promise<InboxChannel | null>;
  saveChannel(c: InboxChannel): Promise<InboxChannel>;
  deleteChannel(operatorId: string, id: string): Promise<boolean>;
}

/** Texto limpio: sin caracteres de control (salvo saltos), recortado y con longitud acotada. */
export function cleanBody(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_BODY);
}

export const preview = (body: string) => body.replace(/\s+/g, ' ').slice(0, 140);
