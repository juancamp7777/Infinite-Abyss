import { randomUUID } from 'crypto';
import {
  CreditRequest,
  DebitRequest,
  RollbackRequest,
  WalletBalance,
  WalletError,
  WalletPort,
  WalletResult,
} from '../ports/WalletPort';

export type WalletTxType = 'DEBIT' | 'CREDIT' | 'ROLLBACK';

export interface WalletTxRecord {
  txId: string;
  type: WalletTxType;
  operatorId: string;
  playerId: string;
  currency: string;
  /** Monto absoluto de la operación. */
  amount: bigint;
  /** Variación aplicada a cada sub-saldo (negativo en débitos). */
  cashDelta: bigint;
  bonusDelta: bigint;
  reason: string;
  idempotencyKey: string;
  originalIdempotencyKey?: string;
  ref: DebitRequest['ref'];
  balanceAfter: bigint;
  /** Clave del rollback que anuló esta transacción, si existe. */
  rolledBackBy?: string;
  at: string;
}

interface StoredTx {
  fingerprint: string;
  result: WalletResult;
  record: WalletTxRecord;
}

const accKey = (o: string, p: string, c: string) => `${o}\u0000${p}\u0000${c}`;
const txKey = (o: string, k: string) => `${o}\u0000${k}`;

/**
 * Billetera en memoria, idempotente, para pruebas y desarrollo.
 * - Misma idempotencyKey + mismo payload → resultado original; otro payload → IDEMPOTENCY_CONFLICT.
 * - debit consume primero cash y luego bonus. BONUS_GRANT acredita en bonus; el resto en cash.
 * - rollback de clave desconocida → UNKNOWN_TRANSACTION; rollback repetido (misma clave) es idempotente;
 *   anular de nuevo con otra clave → ALREADY_ROLLED_BACK.
 * Las operaciones son síncronas internamente, por lo que son atómicas dentro del event loop.
 */
export class InMemoryWallet implements WalletPort {
  private readonly accounts = new Map<string, WalletBalance>();
  private readonly txs = new Map<string, StoredTx>();
  private readonly history: WalletTxRecord[] = [];

  seed(operatorId: string, playerId: string, currency: string, cash: bigint, bonus: bigint = 0n): void {
    this.accounts.set(accKey(operatorId, playerId, currency), { cash, bonus });
  }

  async getBalance(operatorId: string, playerId: string, currency: string): Promise<WalletBalance> {
    const a = this.accounts.get(accKey(operatorId, playerId, currency));
    return a ? { cash: a.cash, bonus: a.bonus } : { cash: 0n, bonus: 0n };
  }

  async debit(req: DebitRequest): Promise<WalletResult> {
    return this.apply('DEBIT', req);
  }

  async credit(req: CreditRequest): Promise<WalletResult> {
    return this.apply('CREDIT', req);
  }

  async rollback(req: RollbackRequest): Promise<WalletResult> {
    const fp = JSON.stringify(['ROLLBACK', req.playerId, req.originalIdempotencyKey]);
    const existing = this.txs.get(txKey(req.operatorId, req.idempotencyKey));
    if (existing) {
      if (existing.fingerprint !== fp) throw new WalletError('IDEMPOTENCY_CONFLICT', 'idempotencyKey reutilizada con otro payload');
      return existing.result;
    }
    const original = this.txs.get(txKey(req.operatorId, req.originalIdempotencyKey));
    if (!original || original.record.playerId !== req.playerId || original.record.type === 'ROLLBACK') {
      throw new WalletError('UNKNOWN_TRANSACTION', 'Transacción original desconocida');
    }
    if (original.record.rolledBackBy) throw new WalletError('ALREADY_ROLLED_BACK', 'La transacción ya fue anulada');

    const o = original.record;
    const acc = this.account(o.operatorId, o.playerId, o.currency);
    const cashDelta = -o.cashDelta;
    const bonusDelta = -o.bonusDelta;
    if (acc.cash + cashDelta < 0n || acc.bonus + bonusDelta < 0n) {
      throw new WalletError('INSUFFICIENT_FUNDS', 'Saldo insuficiente para anular el crédito');
    }
    acc.cash += cashDelta;
    acc.bonus += bonusDelta;
    o.rolledBackBy = req.idempotencyKey;
    return this.store(fp, {
      type: 'ROLLBACK',
      operatorId: o.operatorId,
      playerId: o.playerId,
      currency: o.currency,
      amount: o.amount,
      cashDelta,
      bonusDelta,
      reason: 'ROLLBACK',
      idempotencyKey: req.idempotencyKey,
      originalIdempotencyKey: req.originalIdempotencyKey,
      ref: o.ref,
      balanceAfter: acc.cash + acc.bonus,
    });
  }

  /** Historial (copia) con filtro opcional. */
  getHistory(filter: Partial<Pick<WalletTxRecord, 'operatorId' | 'playerId' | 'type' | 'reason'>> = {}): WalletTxRecord[] {
    return this.history
      .filter((r) => Object.entries(filter).every(([k, v]) => v === undefined || (r as unknown as Record<string, unknown>)[k] === v))
      .map((r) => ({ ...r, ref: { ...r.ref } }));
  }

  findTransaction(operatorId: string, idempotencyKey: string): WalletTxRecord | undefined {
    const t = this.txs.get(txKey(operatorId, idempotencyKey));
    return t ? { ...t.record } : undefined;
  }

  private apply(type: 'DEBIT' | 'CREDIT', req: DebitRequest | CreditRequest): Promise<WalletResult> {
    const fp = JSON.stringify([
      type,
      req.playerId,
      req.currency,
      req.amount.toString(),
      req.reason,
      req.ref?.provider ?? null,
      req.ref?.gameId ?? null,
      req.ref?.roundId ?? null,
    ]);
    const existing = this.txs.get(txKey(req.operatorId, req.idempotencyKey));
    if (existing) {
      if (existing.fingerprint !== fp) {
        return Promise.reject(new WalletError('IDEMPOTENCY_CONFLICT', 'idempotencyKey reutilizada con otro payload'));
      }
      return Promise.resolve(existing.result);
    }
    if (typeof req.amount !== 'bigint' || req.amount <= 0n) {
      return Promise.reject(new WalletError('INVALID_AMOUNT', 'El monto debe ser un bigint positivo'));
    }
    const acc = this.account(req.operatorId, req.playerId, req.currency);
    let cashDelta = 0n;
    let bonusDelta = 0n;
    if (type === 'DEBIT') {
      if (acc.cash + acc.bonus < req.amount) {
        return Promise.reject(new WalletError('INSUFFICIENT_FUNDS', 'Saldo insuficiente'));
      }
      const fromCash = acc.cash >= req.amount ? req.amount : acc.cash;
      cashDelta = -fromCash;
      bonusDelta = -(req.amount - fromCash);
    } else if (req.reason === 'BONUS_GRANT') {
      bonusDelta = req.amount;
    } else {
      cashDelta = req.amount;
    }
    acc.cash += cashDelta;
    acc.bonus += bonusDelta;
    return Promise.resolve(
      this.store(fp, {
        type,
        operatorId: req.operatorId,
        playerId: req.playerId,
        currency: req.currency,
        amount: req.amount,
        cashDelta,
        bonusDelta,
        reason: req.reason,
        idempotencyKey: req.idempotencyKey,
        ref: { ...(req.ref ?? {}) },
        balanceAfter: acc.cash + acc.bonus,
      }),
    );
  }

  private store(fingerprint: string, rec: Omit<WalletTxRecord, 'txId' | 'at'>): WalletResult {
    const record: WalletTxRecord = { ...rec, txId: randomUUID(), at: new Date().toISOString() };
    const result: WalletResult = { balance: record.balanceAfter, txId: record.txId };
    this.txs.set(txKey(record.operatorId, record.idempotencyKey), { fingerprint, result, record });
    this.history.push(record);
    return result;
  }

  private account(o: string, p: string, c: string): WalletBalance {
    const k = accKey(o, p, c);
    let a = this.accounts.get(k);
    if (!a) {
      a = { cash: 0n, bonus: 0n };
      this.accounts.set(k, a);
    }
    return a;
  }
}
