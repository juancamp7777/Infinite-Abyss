import { DUPLICATE_RECEIPT, type BankAccount, type BankTx, type Feed, type PearlRepository, type PearlSettings, type Receipt, type ReceiptStatus } from '../domain/types';

/** Subconjunto del PrismaClient usado (evita depender de los tipos generados). */
interface Delegate {
  findFirst(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  findMany(args?: any): Promise<any[]>;
  upsert(args: any): Promise<any>;
  create(args: any): Promise<any>;
  updateMany(args: any): Promise<{ count: number }>;
  deleteMany(args: any): Promise<{ count: number }>;
}
export interface PearlPrismaLike {
  pearlSettings: Delegate;
  pearlBankAccount: Delegate;
  pearlFeed: Delegate;
  pearlBankTx: Delegate;
  pearlReceipt: Delegate;
}

const noNulls = <T>(r: any): T => {
  const o = { ...r };
  for (const k of Object.keys(o)) if (o[k] === null) delete o[k];
  return o as T;
};
const receipt = (r: any): Receipt => noNulls<Receipt>({ ...r, extracted: r.extracted, checks: r.checks ?? [] });
const isUnique = (e: unknown) => (e as { code?: string }).code === 'P2002';

export class PrismaPearlRepository implements PearlRepository {
  constructor(private readonly db: PearlPrismaLike) {}

  async getSettings(operatorId: string) {
    const r = await this.db.pearlSettings.findUnique({ where: { operatorId } });
    return r ? (r as PearlSettings) : null;
  }
  async saveSettings(s: PearlSettings) {
    const { operatorId, ...rest } = s;
    return (await this.db.pearlSettings.upsert({ where: { operatorId }, create: s, update: rest })) as PearlSettings;
  }

  async listAccounts(operatorId: string) {
    return (await this.db.pearlBankAccount.findMany({ where: { operatorId }, orderBy: { createdAt: 'asc' } })).map((r) => noNulls<BankAccount>(r));
  }
  async saveAccount(a: BankAccount) {
    const data = { ...a, alias: a.alias ?? null, bank: a.bank ?? null };
    const { id, createdAt: _c, ...rest } = data;
    return noNulls<BankAccount>(await this.db.pearlBankAccount.upsert({ where: { id }, create: data, update: rest }));
  }
  async deleteAccount(operatorId: string, id: string) {
    return (await this.db.pearlBankAccount.deleteMany({ where: { id, operatorId } })).count > 0;
  }

  async listFeeds(operatorId: string) {
    return (await this.db.pearlFeed.findMany({ where: { operatorId }, orderBy: { createdAt: 'asc' } })).map((r) => noNulls<Feed>(r));
  }
  async findFeed(id: string) {
    const r = await this.db.pearlFeed.findUnique({ where: { id } });
    return r ? noNulls<Feed>(r) : null;
  }
  async saveFeed(f: Feed) {
    const data = { ...f, lastEventAt: f.lastEventAt ?? null };
    const { id, ...rest } = data;
    return noNulls<Feed>(await this.db.pearlFeed.upsert({ where: { id }, create: data, update: rest }));
  }
  async deleteFeed(operatorId: string, id: string) {
    return (await this.db.pearlFeed.deleteMany({ where: { id, operatorId } })).count > 0;
  }

  async insertBankTx(tx: BankTx) {
    try {
      const data = { ...tx, senderTaxId: tx.senderTaxId ?? null, senderAccount: tx.senderAccount ?? null, receiverAccount: tx.receiverAccount ?? null, receiptId: tx.receiptId ?? null };
      return { tx: noNulls<BankTx>(await this.db.pearlBankTx.create({ data })), created: true };
    } catch (e) {
      if (!isUnique(e)) throw e;
      const prev = await this.db.pearlBankTx.findFirst({ where: { feedId: tx.feedId, externalId: tx.externalId } });
      return { tx: noNulls<BankTx>(prev), created: false };
    }
  }
  async listBankTxs(operatorId: string, f: { status?: BankTx['status']; since?: Date; amount?: bigint; limit: number }) {
    const where: Record<string, unknown> = { operatorId };
    if (f.status) where.status = f.status;
    if (f.since) where.occurredAt = { gte: f.since };
    if (f.amount !== undefined) where.amount = f.amount;
    return (await this.db.pearlBankTx.findMany({ where, orderBy: { occurredAt: 'desc' }, take: f.limit })).map((r) => noNulls<BankTx>(r));
  }
  async findBankTx(operatorId: string, id: string) {
    const r = await this.db.pearlBankTx.findFirst({ where: { id, operatorId } });
    return r ? noNulls<BankTx>(r) : null;
  }
  async claimBankTx(operatorId: string, id: string, receiptId: string) {
    return (await this.db.pearlBankTx.updateMany({ where: { id, operatorId, status: 'available' }, data: { status: 'used', receiptId } })).count === 1;
  }
  async releaseBankTx(operatorId: string, id: string, receiptId: string) {
    await this.db.pearlBankTx.updateMany({ where: { id, operatorId, receiptId }, data: { status: 'available', receiptId: null } });
  }

  async findReceipt(operatorId: string, id: string) {
    const r = await this.db.pearlReceipt.findFirst({ where: { id, operatorId } });
    return r ? receipt(r) : null;
  }
  async findReceiptBy(operatorId: string, f: { imageHash?: string; key?: string }) {
    const or = [f.imageHash ? { imageHash: f.imageHash } : null, f.key ? { key: f.key } : null].filter(Boolean);
    if (!or.length) return null;
    const r = await this.db.pearlReceipt.findFirst({ where: { operatorId, OR: or } });
    return r ? receipt(r) : null;
  }
  async insertReceipt(r: Receipt) {
    try {
      return receipt(await this.db.pearlReceipt.create({ data: this.data(r) }));
    } catch (e) {
      if (isUnique(e)) throw Object.assign(new Error('Comprobante duplicado'), { code: DUPLICATE_RECEIPT });
      throw e;
    }
  }
  async transitionReceipt(r: Receipt, from: ReceiptStatus[]) {
    const { id, operatorId, createdAt: _c, ...rest } = this.data(r);
    return (await this.db.pearlReceipt.updateMany({ where: { id, operatorId, status: { in: from } }, data: rest })).count === 1;
  }
  async listReceipts(operatorId: string, f: { status?: ReceiptStatus; limit: number }) {
    return (await this.db.pearlReceipt.findMany({ where: { operatorId, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: 'desc' }, take: f.limit })).map(receipt);
  }
  async waitingReceipts(limit: number) {
    return (await this.db.pearlReceipt.findMany({ where: { status: 'waiting_bank' }, orderBy: { createdAt: 'asc' }, take: limit })).map(receipt);
  }
  async knownSenderNames(operatorId: string, playerId: string) {
    const rows = await this.db.pearlReceipt.findMany({ where: { operatorId, playerId, status: 'credited' }, select: { extracted: true }, take: 50, orderBy: { createdAt: 'desc' } });
    return [...new Set(rows.map((r) => String((r.extracted as { senderName?: string })?.senderName ?? '')).filter(Boolean))];
  }

  private data(r: Receipt) {
    return {
      ...r, extracted: r.extracted as object, checks: r.checks as object[], conversationId: r.conversationId ?? null, playerId: r.playerId ?? null, imageHash: r.imageHash ?? null,
      key: r.key ?? null, amount: r.amount ?? null, reason: r.reason ?? null, bankTxId: r.bankTxId ?? null, depositId: r.depositId ?? null, reviewerId: r.reviewerId ?? null,
    };
  }
}
