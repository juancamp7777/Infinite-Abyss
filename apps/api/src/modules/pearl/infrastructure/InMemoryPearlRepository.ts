import { DUPLICATE_RECEIPT, type AiConfig, type BankAccount, type BankTx, type Feed, type FeedType, type PearlRepository, type PearlSettings, type Receipt, type ReceiptStatus } from '../domain/types';

const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryPearlRepository implements PearlRepository {
  private readonly settings = new Map<string, PearlSettings>();
  private readonly accounts = new Map<string, BankAccount>();
  private readonly feeds = new Map<string, Feed>();
  private readonly txs = new Map<string, BankTx>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly ai = new Map<string, AiConfig>();

  async getSettings(op: string) {
    const s = this.settings.get(op);
    return s ? clone(s) : null;
  }
  async saveSettings(s: PearlSettings) {
    this.settings.set(s.operatorId, clone(s));
    return clone(s);
  }
  async listAccounts(op: string) {
    return [...this.accounts.values()].filter((a) => a.operatorId === op).map(clone);
  }
  async saveAccount(a: BankAccount) {
    this.accounts.set(a.id, clone(a));
    return clone(a);
  }
  async deleteAccount(op: string, id: string) {
    return this.accounts.get(id)?.operatorId === op && this.accounts.delete(id);
  }
  async listFeeds(op: string) {
    return [...this.feeds.values()].filter((f) => f.operatorId === op).map(clone);
  }
  async enabledFeedsOfType(type: FeedType) {
    return [...this.feeds.values()].filter((f) => f.type === type && f.enabled).map(clone);
  }
  async findFeed(id: string) {
    const f = this.feeds.get(id);
    return f ? clone(f) : null;
  }
  async saveFeed(f: Feed) {
    this.feeds.set(f.id, clone(f));
    return clone(f);
  }
  async deleteFeed(op: string, id: string) {
    return this.feeds.get(id)?.operatorId === op && this.feeds.delete(id);
  }
  async insertBankTx(tx: BankTx) {
    const prev = [...this.txs.values()].find((t) => t.feedId === tx.feedId && t.externalId === tx.externalId);
    if (prev) return { tx: clone(prev), created: false };
    this.txs.set(tx.id, clone(tx));
    return { tx: clone(tx), created: true };
  }
  async listBankTxs(op: string, f: { status?: BankTx['status']; since?: Date; amount?: bigint; limit: number }) {
    return [...this.txs.values()]
      .filter((t) => t.operatorId === op && (!f.status || t.status === f.status) && (!f.since || t.occurredAt >= f.since) && (f.amount === undefined || t.amount === f.amount))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, f.limit)
      .map(clone);
  }
  async findBankTx(op: string, id: string) {
    const t = this.txs.get(id);
    return t && t.operatorId === op ? clone(t) : null;
  }
  async claimBankTx(op: string, id: string, receiptId: string) {
    const t = this.txs.get(id);
    if (!t || t.operatorId !== op || t.status !== 'available') return false;
    this.txs.set(id, { ...t, status: 'used', receiptId });
    return true;
  }
  async releaseBankTx(op: string, id: string, receiptId: string) {
    const t = this.txs.get(id);
    if (t && t.operatorId === op && t.receiptId === receiptId) this.txs.set(id, { ...t, status: 'available', receiptId: undefined });
  }
  async findReceipt(op: string, id: string) {
    const r = this.receipts.get(id);
    return r && r.operatorId === op ? clone(r) : null;
  }
  async findReceiptBy(op: string, f: { imageHash?: string; key?: string }) {
    const r = [...this.receipts.values()].find((x) => x.operatorId === op && ((f.imageHash && x.imageHash === f.imageHash) || (f.key && x.key === f.key)));
    return r ? clone(r) : null;
  }
  async insertReceipt(r: Receipt) {
    if (await this.findReceiptBy(r.operatorId, { imageHash: r.imageHash, key: r.key })) throw Object.assign(new Error('Comprobante duplicado'), { code: DUPLICATE_RECEIPT });
    this.receipts.set(r.id, clone(r));
    return clone(r);
  }
  async transitionReceipt(r: Receipt, from: ReceiptStatus[]) {
    const cur = this.receipts.get(r.id);
    if (!cur || !from.includes(cur.status)) return false;
    this.receipts.set(r.id, clone(r));
    return true;
  }
  async listReceipts(op: string, f: { status?: ReceiptStatus; limit: number }) {
    return [...this.receipts.values()]
      .filter((r) => r.operatorId === op && (!f.status || r.status === f.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, f.limit)
      .map(clone);
  }
  async waitingReceipts(limit: number) {
    return [...this.receipts.values()].filter((r) => r.status === 'waiting_bank').slice(0, limit).map(clone);
  }
  async latestReceiptForConversation(op: string, conversationId: string) {
    const r = [...this.receipts.values()].filter((x) => x.operatorId === op && x.conversationId === conversationId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return r ? clone(r) : null;
  }
  async latestReceiptForPlayer(op: string, playerId: string) {
    const r = [...this.receipts.values()].filter((x) => x.operatorId === op && x.playerId === playerId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return r ? clone(r) : null;
  }
  async getAi(op: string) {
    const c = this.ai.get(op);
    return c ? clone(c) : null;
  }
  async saveAi(c: AiConfig) {
    this.ai.set(c.operatorId, clone(c));
    return clone(c);
  }
  async knownSenderNames(op: string, playerId: string) {
    return [...new Set([...this.receipts.values()].filter((r) => r.operatorId === op && r.playerId === playerId && r.status === 'credited').map((r) => r.extracted.senderName))];
  }
}
