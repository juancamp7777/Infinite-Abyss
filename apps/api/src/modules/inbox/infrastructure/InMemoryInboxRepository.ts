import type { Channel, Conversation, ConversationFilter, InboxChannel, InboxRepository, Message, QuickReply, Visitor } from '../domain/types';

const clone = <T>(v: T): T => structuredClone(v);

/** Repositorio en memoria (dev-server y pruebas). Mismo contrato que el de Prisma. */
export class InMemoryInboxRepository implements InboxRepository {
  private readonly convs = new Map<string, Conversation>();
  private readonly msgs: Message[] = [];
  private readonly replies = new Map<string, QuickReply>();
  private readonly visitors = new Map<string, Visitor>();
  private readonly channels = new Map<string, InboxChannel>();

  async findConversation(operatorId: string, id: string) {
    const c = this.convs.get(id);
    return c && c.operatorId === operatorId ? clone(c) : null;
  }
  async findLatestByExternal(operatorId: string, channel: Channel, externalId: string) {
    const c = [...this.convs.values()]
      .filter((x) => x.operatorId === operatorId && x.channel === channel && x.externalId === externalId)
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())[0];
    return c ? clone(c) : null;
  }
  async saveConversation(c: Conversation) {
    this.convs.set(c.id, clone(c));
    return clone(c);
  }
  async listConversations(operatorId: string, f: ConversationFilter) {
    const q = f.q?.toLowerCase();
    return [...this.convs.values()]
      .filter((c) => c.operatorId === operatorId)
      .filter((c) => (f.status ? c.status === f.status : true))
      .filter((c) => (f.assigneeId === undefined ? true : f.assigneeId === null ? !c.assigneeId : c.assigneeId === f.assigneeId))
      .filter((c) => (q ? `${c.contactName} ${c.lastMessagePreview} ${c.playerId ?? ''}`.toLowerCase().includes(q) : true))
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
      .slice(0, f.limit)
      .map(clone);
  }
  async addMessage(m: Message) {
    if (m.clientMsgId && this.msgs.some((x) => x.conversationId === m.conversationId && x.clientMsgId === m.clientMsgId)) {
      throw Object.assign(new Error('clientMsgId duplicado'), { code: 'DUPLICATE_CLIENT_MSG' });
    }
    this.msgs.push(clone(m));
    return clone(m);
  }
  async findMessageByClientId(conversationId: string, clientMsgId: string) {
    const m = this.msgs.find((x) => x.conversationId === conversationId && x.clientMsgId === clientMsgId);
    return m ? clone(m) : null;
  }
  async listMessages(conversationId: string, opts: { includeNotes: boolean; after?: Date; limit: number }) {
    return this.msgs
      .filter((m) => m.conversationId === conversationId && (opts.includeNotes || m.direction !== 'note') && (!opts.after || m.createdAt > opts.after))
      .slice(-opts.limit)
      .map(clone);
  }
  async listQuickReplies(operatorId: string) {
    return [...this.replies.values()].filter((r) => r.operatorId === operatorId).sort((a, b) => a.shortcut.localeCompare(b.shortcut)).map(clone);
  }
  async saveQuickReply(q: QuickReply) {
    this.replies.set(q.id, clone(q));
    return clone(q);
  }
  async deleteQuickReply(operatorId: string, id: string) {
    const r = this.replies.get(id);
    if (!r || r.operatorId !== operatorId) return false;
    return this.replies.delete(id);
  }
  async saveMessage(m: Message) {
    const i = this.msgs.findIndex((x) => x.id === m.id);
    if (i < 0) throw new Error('Mensaje inexistente');
    this.msgs[i] = clone(m);
    return clone(m);
  }
  async listChannels(operatorId: string) {
    return [...this.channels.values()].filter((c) => c.operatorId === operatorId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }
  async findChannel(id: string) {
    const c = this.channels.get(id);
    return c ? clone(c) : null;
  }
  async saveChannel(c: InboxChannel) {
    this.channels.set(c.id, clone(c));
    return clone(c);
  }
  async deleteChannel(operatorId: string, id: string) {
    const c = this.channels.get(id);
    return !!c && c.operatorId === operatorId && this.channels.delete(id);
  }
  async saveVisitor(v: Visitor) {
    this.visitors.set(v.tokenHash, clone(v));
    return clone(v);
  }
  async findVisitorByTokenHash(tokenHash: string) {
    const v = this.visitors.get(tokenHash);
    return v ? clone(v) : null;
  }
}
