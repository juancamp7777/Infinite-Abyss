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
  createdAt: Date;
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
  saveVisitor(v: Visitor): Promise<Visitor>;
  findVisitorByTokenHash(tokenHash: string): Promise<Visitor | null>;
}

/** Texto limpio: sin caracteres de control (salvo saltos), recortado y con longitud acotada. */
export function cleanBody(raw: string): string {
  return raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_BODY);
}

export const preview = (body: string) => body.replace(/\s+/g, ' ').slice(0, 140);
