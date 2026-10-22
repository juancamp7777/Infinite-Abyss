/** Inbox omnicanal: conversaciones con contactos (jugadores o visitantes) atendidas por agentes del operador. */

export type Channel = 'webchat' | 'whatsapp' | 'telegram';
export type ConversationStatus = 'open' | 'pending' | 'closed';
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
  /** Id del mensaje en el canal externo (wamid, message_id de Telegram). */
  externalMessageId?: string;
  /** Entrega de respuestas por canales externos. */
  status?: DeliveryStatus;
  error?: string;
  createdAt: Date;
}

export type DeliveryStatus = 'sent' | 'failed';
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
