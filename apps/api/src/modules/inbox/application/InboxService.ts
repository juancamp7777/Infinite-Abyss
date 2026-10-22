import { createHash, randomBytes, randomUUID } from 'crypto';
import { HttpError } from '../../shared/http/errors';
import { cleanBody, MAX_ATTACHMENT, preview, sniffImage, type Attachment, type Channel, type Conversation, type ConversationFilter, type ConversationStatus, type InboxRepository, type Message, type QuickReply } from '../domain/types';

/** Recibe cambios para los sockets: agentes del operador y el contacto de cada conversación. */
export interface InboxNotifier {
  toAgents(operatorId: string, event: 'inbox:conversation' | 'inbox:message', payload: unknown): void;
  /** Solo mensajes visibles para el contacto (nunca notas internas). */
  toContact(conversation: Conversation, message: Message): void;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ContactIdentity {
  operatorId: string;
  channel: Channel;
  externalId: string;
  name: string;
  playerId?: string;
  channelId?: string;
}

/** Eventos para automatizaciones (Tide): se esperan dentro de la operación y sus errores nunca la rompen. */
export type InboxEvent =
  | { type: 'contact_message'; conversation: Conversation; message: Message }
  | { type: 'agent_message'; conversation: Conversation; message: Message }
  | { type: 'closed'; conversation: Conversation };
/** Un listener que devuelve 'handled' consume el evento (los de menor prioridad no lo reciben). */
export type InboxListener = (e: InboxEvent) => Promise<void | 'handled'> | void | 'handled';

/** Entrega por canal externo (WhatsApp, Telegram); lanza si el canal rechaza el envío. */
export type InboxDispatcher = (conversation: Conversation, message: Message) => Promise<{ externalMessageId: string }>;

const RATE_WINDOW_MS = 60_000;

export class InboxService {
  private notifier?: InboxNotifier;
  private dispatcher?: InboxDispatcher;
  private readonly listeners: Array<{ l: InboxListener; priority: number }> = [];
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly repo: InboxRepository,
    private readonly opts: { contactRatePerMinute?: number; now?: () => Date } = {},
  ) {}

  setNotifier(n: InboxNotifier): void {
    this.notifier = n;
  }

  setDispatcher(d: InboxDispatcher): void {
    this.dispatcher = d;
  }

  /** Mayor prioridad primero (Pearl atiende comprobantes antes que los flujos de Tide). */
  onEvent(l: InboxListener, priority = 0): void {
    this.listeners.push({ l, priority });
    this.listeners.sort((a, b) => b.priority - a.priority);
  }

  private async emit(e: InboxEvent): Promise<void> {
    for (const { l } of this.listeners) {
      try {
        if ((await l(e)) === 'handled') return;
      } catch {
        /* una automatización rota no debe tumbar el inbox (el motor registra sus propios errores) */
      }
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // ------------------------------------------------------------ contactos

  /** Crea un visitante anónimo del webchat: devuelve el token en claro UNA vez (se guarda solo su hash). */
  async createVisitor(operatorId: string, name?: string): Promise<{ visitorId: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const v = await this.repo.saveVisitor({ id: randomUUID(), operatorId, tokenHash: hashToken(token), name: (name && cleanBody(name).slice(0, 60)) || 'Visitante', createdAt: this.now() });
    return { visitorId: v.id, token };
  }

  async visitorByToken(token: string) {
    return token ? this.repo.findVisitorByTokenHash(hashToken(token)) : null;
  }

  /** Última conversación del contacto en el canal (sin crearla). */
  findFor(id: Pick<ContactIdentity, 'operatorId' | 'channel' | 'externalId'>): Promise<Conversation | null> {
    return this.repo.findLatestByExternal(id.operatorId, id.channel, id.externalId);
  }

  /** Última conversación del contacto en el canal, o una nueva. */
  async conversationFor(id: ContactIdentity): Promise<Conversation> {
    const latest = await this.findFor(id);
    if (latest) return latest;
    const now = this.now();
    const c = await this.repo.saveConversation({
      id: randomUUID(), operatorId: id.operatorId, channel: id.channel, externalId: id.externalId,
      ...(id.playerId ? { playerId: id.playerId } : {}), ...(id.channelId ? { channelId: id.channelId } : {}), contactName: id.name, status: 'open',
      lastMessageAt: now, lastMessagePreview: '', unread: 0, createdAt: now, updatedAt: now,
    });
    this.notifier?.toAgents(c.operatorId, 'inbox:conversation', c);
    return c;
  }

  /** Mensaje del contacto. Idempotente por clientMsgId; reabre la conversación si estaba cerrada. */
  /** Imagen del contacto (comprobante, captura): se valida por firma de bytes y queda como adjunto del mensaje. */
  async contactAttachment(conv: Conversation, data: Buffer, caption?: string, clientMsgId?: string, opts: { skipRateLimit?: boolean } = {}): Promise<Message> {
    if (clientMsgId) {
      const prev = await this.repo.findMessageByClientId(conv.id, clientMsgId);
      if (prev) return prev;
    }
    if (data.length > MAX_ATTACHMENT) throw new HttpError(413, 'TOO_LARGE', 'La imagen supera los 5 MB');
    const mime = sniffImage(data);
    if (!mime) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Solo se aceptan imágenes JPG, PNG o WEBP');
    const att = await this.repo.saveAttachment({ id: randomUUID(), operatorId: conv.operatorId, conversationId: conv.id, mime, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data, createdAt: this.now() });
    return this.contactMessage(conv, caption?.trim() || '📷 Imagen', clientMsgId, { ...opts, attachmentId: att.id });
  }

  async attachment(operatorId: string, id: string): Promise<Attachment> {
    const a = await this.repo.findAttachment(operatorId, id);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Adjunto no encontrado');
    return a;
  }

  async contactMessage(conv: Conversation, rawBody: string, clientMsgId?: string, opts: { skipRateLimit?: boolean; attachmentId?: string } = {}): Promise<Message> {
    if (clientMsgId) {
      const prev = await this.repo.findMessageByClientId(conv.id, clientMsgId);
      if (prev) return prev;
    }
    const body = this.validBody(rawBody);
    if (!opts.skipRateLimit) this.rateLimit(conv.id);
    let msg: Message;
    try {
      msg = await this.repo.addMessage({ id: randomUUID(), conversationId: conv.id, operatorId: conv.operatorId, direction: 'in', authorType: 'contact', body, ...(opts.attachmentId ? { attachmentId: opts.attachmentId } : {}), ...(clientMsgId ? { clientMsgId } : {}), createdAt: this.now() });
    } catch (e) {
      // Reintento concurrente con el mismo clientMsgId: devolver el que ganó.
      const prev = clientMsgId && (e as { code?: string }).code === 'DUPLICATE_CLIENT_MSG' ? await this.repo.findMessageByClientId(conv.id, clientMsgId) : null;
      if (prev) return prev;
      throw e;
    }
    const updated = await this.repo.saveConversation({ ...conv, status: 'open', unread: conv.unread + 1, lastMessageAt: msg.createdAt, lastMessagePreview: preview(body), updatedAt: msg.createdAt });
    this.notifier?.toAgents(conv.operatorId, 'inbox:message', msg);
    this.notifier?.toAgents(conv.operatorId, 'inbox:conversation', updated);
    this.notifier?.toContact(updated, msg);
    await this.emit({ type: 'contact_message', conversation: updated, message: msg });
    return msg;
  }

  contactMessages(conv: Conversation, after?: Date): Promise<Message[]> {
    return this.repo.listMessages(conv.id, { includeNotes: false, after, limit: 200 });
  }

  // ------------------------------------------------------------ agentes

  list(operatorId: string, f: ConversationFilter): Promise<Conversation[]> {
    return this.repo.listConversations(operatorId, f);
  }

  async get(operatorId: string, id: string): Promise<{ conversation: Conversation; messages: Message[] }> {
    const conversation = await this.must(operatorId, id);
    return { conversation, messages: await this.repo.listMessages(id, { includeNotes: true, limit: 500 }) };
  }

  /** Respuesta (visible para el contacto) o nota interna (solo agentes). */
  async agentMessage(operatorId: string, id: string, agentId: string, rawBody: string, kind: 'reply' | 'note'): Promise<Message> {
    const conv = await this.must(operatorId, id);
    const body = this.validBody(rawBody);
    let msg = await this.repo.addMessage({ id: randomUUID(), conversationId: id, operatorId, direction: kind === 'note' ? 'note' : 'out', authorType: 'agent', authorId: agentId, body, createdAt: this.now() });
    if (kind === 'reply' && conv.channel !== 'webchat') msg = await this.dispatch(conv, msg);
    const updated = kind === 'note'
      ? { ...conv, updatedAt: msg.createdAt }
      : { ...conv, status: (conv.status === 'closed' ? 'open' : 'pending') as ConversationStatus, unread: 0, assigneeId: conv.assigneeId ?? agentId, lastMessageAt: msg.createdAt, lastMessagePreview: preview(body), updatedAt: msg.createdAt };
    const saved = await this.repo.saveConversation(updated);
    this.notifier?.toAgents(operatorId, 'inbox:message', msg);
    this.notifier?.toAgents(operatorId, 'inbox:conversation', saved);
    if (kind === 'reply') {
      this.notifier?.toContact(saved, msg);
      await this.emit({ type: 'agent_message', conversation: saved, message: msg });
    }
    return msg;
  }

  /** Reintenta la entrega de una respuesta que el canal externo rechazó. */
  async retryDelivery(operatorId: string, id: string, messageId: string): Promise<Message> {
    const conv = await this.must(operatorId, id);
    const msg = (await this.repo.listMessages(id, { includeNotes: false, limit: 500 })).find((m) => m.id === messageId);
    if (!msg || msg.direction !== 'out') throw new HttpError(404, 'NOT_FOUND', 'Mensaje no encontrado');
    if (msg.status !== 'failed') throw new HttpError(409, 'NOT_FAILED', 'El mensaje no está pendiente de reintento');
    const saved = await this.dispatch(conv, msg);
    this.notifier?.toAgents(operatorId, 'inbox:message', saved);
    return saved;
  }

  async update(operatorId: string, id: string, patch: { status?: ConversationStatus; assigneeId?: string | null }): Promise<Conversation> {
    const conv = await this.must(operatorId, id);
    const next: Conversation = { ...conv, updatedAt: this.now() };
    if (patch.status) next.status = patch.status;
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null) delete next.assigneeId;
      else next.assigneeId = patch.assigneeId;
    }
    const saved = await this.repo.saveConversation(next);
    this.notifier?.toAgents(operatorId, 'inbox:conversation', saved);
    if (saved.status === 'closed' && conv.status !== 'closed') await this.emit({ type: 'closed', conversation: saved });
    return saved;
  }

  // ------------------------------------------------------------ bot (Tide)

  conversation(operatorId: string, id: string): Promise<Conversation> {
    return this.must(operatorId, id);
  }

  /** Mensaje del bot: visible para el contacto y entregado por el canal; no asigna la conversación a nadie. */
  async botMessage(operatorId: string, id: string, rawBody: string): Promise<Message> {
    const conv = await this.must(operatorId, id);
    const body = this.validBody(rawBody);
    let msg = await this.repo.addMessage({ id: randomUUID(), conversationId: id, operatorId, direction: 'out', authorType: 'bot', body, createdAt: this.now() });
    if (conv.channel !== 'webchat') msg = await this.dispatch(conv, msg);
    const saved = await this.repo.saveConversation({ ...conv, lastMessageAt: msg.createdAt, lastMessagePreview: preview(body), updatedAt: msg.createdAt });
    this.notifier?.toAgents(operatorId, 'inbox:message', msg);
    this.notifier?.toAgents(operatorId, 'inbox:conversation', saved);
    this.notifier?.toContact(saved, msg);
    return msg;
  }

  /** El bot cede la conversación: nota interna para el equipo y queda abierta, sin asignar, en la cola. */
  async botHandoff(operatorId: string, id: string, note: string): Promise<Conversation> {
    const conv = await this.must(operatorId, id);
    const body = cleanBody(`🤖 El bot pasó la conversación a un agente${note ? `: ${note}` : ''}`);
    const msg = await this.repo.addMessage({ id: randomUUID(), conversationId: id, operatorId, direction: 'note', authorType: 'bot', body, createdAt: this.now() });
    const saved = await this.repo.saveConversation({ ...conv, status: 'open', updatedAt: msg.createdAt });
    this.notifier?.toAgents(operatorId, 'inbox:message', msg);
    this.notifier?.toAgents(operatorId, 'inbox:conversation', saved);
    return saved;
  }

  async markRead(operatorId: string, id: string): Promise<Conversation> {
    const conv = await this.must(operatorId, id);
    if (conv.unread === 0) return conv;
    const saved = await this.repo.saveConversation({ ...conv, unread: 0 });
    this.notifier?.toAgents(operatorId, 'inbox:conversation', saved);
    return saved;
  }

  // ------------------------------------------------------------ respuestas rápidas

  quickReplies(operatorId: string): Promise<QuickReply[]> {
    return this.repo.listQuickReplies(operatorId);
  }

  async saveQuickReply(operatorId: string, shortcut: string, body: string, id?: string): Promise<QuickReply> {
    if (!/^[a-z0-9_-]{1,32}$/.test(shortcut)) throw new HttpError(400, 'BAD_REQUEST', 'Atajo inválido: minúsculas, números, - y _ (máx. 32)');
    const all = await this.repo.listQuickReplies(operatorId);
    if (id && !all.some((q) => q.id === id)) throw new HttpError(404, 'NOT_FOUND', 'Respuesta rápida no encontrada');
    const existing = all.find((q) => q.shortcut === shortcut && q.id !== id);
    if (existing) throw new HttpError(409, 'DUPLICATE', `Ya existe el atajo /${shortcut}`);
    return this.repo.saveQuickReply({ id: id ?? randomUUID(), operatorId, shortcut, body: this.validBody(body).slice(0, 2000), createdAt: this.now() });
  }

  deleteQuickReply(operatorId: string, id: string): Promise<boolean> {
    return this.repo.deleteQuickReply(operatorId, id);
  }

  // ------------------------------------------------------------ internos

  private async dispatch(conv: Conversation, msg: Message): Promise<Message> {
    const next: Message = { ...msg };
    try {
      if (!this.dispatcher) throw new Error('Canal externo no disponible');
      next.externalMessageId = (await this.dispatcher(conv, msg)).externalMessageId;
      next.status = 'sent';
      delete next.error;
    } catch (e) {
      next.status = 'failed';
      next.error = ((e as Error).message || 'Error de entrega').slice(0, 300);
    }
    return this.repo.saveMessage(next);
  }

  private async must(operatorId: string, id: string): Promise<Conversation> {
    const c = await this.repo.findConversation(operatorId, id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Conversación no encontrada');
    return c;
  }

  private validBody(raw: string): string {
    const body = cleanBody(typeof raw === 'string' ? raw : '');
    if (!body) throw new HttpError(400, 'BAD_REQUEST', 'El mensaje está vacío');
    return body;
  }

  /** Antiabuso del webchat público: como mucho N mensajes del contacto por minuto y conversación. */
  private rateLimit(conversationId: string): void {
    const max = this.opts.contactRatePerMinute ?? 20;
    const t = this.now().getTime();
    const list = (this.recent.get(conversationId) ?? []).filter((x) => t - x < RATE_WINDOW_MS);
    if (list.length >= max) throw new HttpError(429, 'RATE_LIMITED', 'Demasiados mensajes; espera un momento');
    list.push(t);
    this.recent.set(conversationId, list);
    if (this.recent.size > 50_000) this.recent.delete(this.recent.keys().next().value as string);
  }
}
