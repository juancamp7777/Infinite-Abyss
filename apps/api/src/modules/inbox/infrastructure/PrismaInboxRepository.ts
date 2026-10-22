import type { Attachment, Channel, Conversation, ConversationFilter, InboxChannel, InboxRepository, Message, QuickReply, Visitor } from '../domain/types';

/** Subconjunto del PrismaClient usado (evita depender de los tipos generados). */
interface Delegate {
  findFirst(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  upsert(args: any): Promise<any>;
  create(args: any): Promise<any>;
  deleteMany(args: any): Promise<{ count: number }>;
}
export interface InboxPrismaLike {
  inboxConversation: Delegate;
  inboxMessage: Delegate;
  inboxQuickReply: Delegate;
  inboxVisitor: Delegate;
  inboxChannel: Delegate;
  inboxAttachment: Delegate;
}

const strip = <T extends Record<string, unknown>>(row: T): T => {
  for (const k of Object.keys(row)) if (row[k] === null) delete row[k];
  return row;
};
const conv = (r: any): Conversation => strip({ ...r }) as Conversation;
const msg = (r: any): Message => strip({ ...r }) as Message;
const nullable = (m: Message) => ({ ...m, attachmentId: m.attachmentId ?? null, authorId: m.authorId ?? null, clientMsgId: m.clientMsgId ?? null, externalMessageId: m.externalMessageId ?? null, status: m.status ?? null, error: m.error ?? null });

export class PrismaInboxRepository implements InboxRepository {
  constructor(private readonly db: InboxPrismaLike) {}

  async findConversation(operatorId: string, id: string) {
    const r = await this.db.inboxConversation.findFirst({ where: { id, operatorId } });
    return r ? conv(r) : null;
  }

  async findLatestByExternal(operatorId: string, channel: Channel, externalId: string) {
    const r = await this.db.inboxConversation.findFirst({ where: { operatorId, channel, externalId }, orderBy: { lastMessageAt: 'desc' } });
    return r ? conv(r) : null;
  }

  async saveConversation(c: Conversation) {
    const data = { ...c, playerId: c.playerId ?? null, assigneeId: c.assigneeId ?? null, channelId: c.channelId ?? null };
    const { id, ...rest } = data;
    return conv(await this.db.inboxConversation.upsert({ where: { id }, create: data, update: rest }));
  }

  async listConversations(operatorId: string, f: ConversationFilter) {
    const where: Record<string, unknown> = { operatorId };
    if (f.status) where.status = f.status;
    if (f.stage) where.stage = f.stage;
    if (f.assigneeId !== undefined) where.assigneeId = f.assigneeId;
    if (f.q) {
      where.OR = ['contactName', 'lastMessagePreview', 'playerId'].map((k) => ({ [k]: { contains: f.q, mode: 'insensitive' } }));
    }
    const rows = await this.db.inboxConversation.findMany({ where, orderBy: { lastMessageAt: 'desc' }, take: f.limit });
    return rows.map(conv);
  }

  async addMessage(m: Message) {
    try {
      return msg(await this.db.inboxMessage.create({ data: nullable(m) }));
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw Object.assign(new Error('clientMsgId duplicado'), { code: 'DUPLICATE_CLIENT_MSG' });
      throw e;
    }
  }

  async findMessageByClientId(conversationId: string, clientMsgId: string) {
    const r = await this.db.inboxMessage.findFirst({ where: { conversationId, clientMsgId } });
    return r ? msg(r) : null;
  }

  async listMessages(conversationId: string, opts: { includeNotes: boolean; after?: Date; limit: number }) {
    const where: Record<string, unknown> = { conversationId };
    if (!opts.includeNotes) where.direction = { not: 'note' };
    if (opts.after) where.createdAt = { gt: opts.after };
    // Los últimos `limit`, devueltos en orden cronológico.
    const rows = await this.db.inboxMessage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: opts.limit });
    return rows.reverse().map(msg);
  }

  async listQuickReplies(operatorId: string) {
    return (await this.db.inboxQuickReply.findMany({ where: { operatorId }, orderBy: { shortcut: 'asc' } })) as QuickReply[];
  }

  async saveQuickReply(q: QuickReply) {
    const { id, ...rest } = q;
    return (await this.db.inboxQuickReply.upsert({ where: { id }, create: q, update: { shortcut: rest.shortcut, body: rest.body } })) as QuickReply;
  }

  async deleteQuickReply(operatorId: string, id: string) {
    return (await this.db.inboxQuickReply.deleteMany({ where: { id, operatorId } })).count > 0;
  }

  async saveMessage(m: Message) {
    const { id, ...rest } = nullable(m);
    return msg(await this.db.inboxMessage.upsert({ where: { id }, create: nullable(m), update: rest }));
  }

  async saveAttachment(a: Attachment) {
    await this.db.inboxAttachment.create({ data: a });
    return a;
  }

  async findAttachment(operatorId: string, id: string) {
    const r = await this.db.inboxAttachment.findFirst({ where: { id, operatorId } });
    return r ? ({ ...r, data: Buffer.from(r.data) } as Attachment) : null;
  }

  async listChannels(operatorId: string) {
    return (await this.db.inboxChannel.findMany({ where: { operatorId }, orderBy: { createdAt: 'asc' } })) as InboxChannel[];
  }

  async findChannel(id: string) {
    return ((await this.db.inboxChannel.findUnique({ where: { id } })) as InboxChannel | null) ?? null;
  }

  async saveChannel(c: InboxChannel) {
    const { id, ...rest } = c;
    return (await this.db.inboxChannel.upsert({ where: { id }, create: c, update: rest })) as InboxChannel;
  }

  async deleteChannel(operatorId: string, id: string) {
    return (await this.db.inboxChannel.deleteMany({ where: { id, operatorId } })).count > 0;
  }

  async saveVisitor(v: Visitor) {
    return (await this.db.inboxVisitor.create({ data: v })) as Visitor;
  }

  async findVisitorByTokenHash(tokenHash: string) {
    return ((await this.db.inboxVisitor.findUnique({ where: { tokenHash } })) as Visitor | null) ?? null;
  }
}
