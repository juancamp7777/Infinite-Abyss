/**
 * Puerto de billetera común a todos los módulos. La Fase 1 lo implementa sobre el ledger
 * de doble partida; InMemoryWallet lo implementa para pruebas.
 * Montos SIEMPRE en unidades mínimas (bigint). Todas las operaciones son idempotentes por idempotencyKey.
 */

export type DebitReason = 'BET' | 'TOURNAMENT_BUYIN' | 'OTHER';
export type CreditReason = 'WIN' | 'BONUS_GRANT' | 'JACKPOT' | 'TOURNAMENT_PRIZE' | 'CASHBACK' | 'REFUND';

export interface WalletRef {
  provider?: string;
  gameId?: string;
  roundId?: string;
}

interface WalletMovementBase {
  operatorId: string;
  playerId: string;
  currency: string;
  amount: bigint;
  idempotencyKey: string;
  ref: WalletRef;
}

export interface DebitRequest extends WalletMovementBase {
  reason: DebitReason;
}

export interface CreditRequest extends WalletMovementBase {
  reason: CreditReason;
}

export interface RollbackRequest {
  operatorId: string;
  playerId: string;
  originalIdempotencyKey: string;
  idempotencyKey: string;
}

export interface WalletBalance {
  cash: bigint;
  bonus: bigint;
}

export interface WalletResult {
  /** Saldo total (cash + bonus) tras la operación. */
  balance: bigint;
  txId: string;
}

export interface WalletPort {
  getBalance(operatorId: string, playerId: string, currency: string): Promise<WalletBalance>;
  debit(req: DebitRequest): Promise<WalletResult>;
  credit(req: CreditRequest): Promise<WalletResult>;
  rollback(req: RollbackRequest): Promise<WalletResult>;
}

export type WalletErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'UNKNOWN_TRANSACTION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_AMOUNT'
  | 'ALREADY_ROLLED_BACK';

export class WalletError extends Error {
  constructor(public readonly code: WalletErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'WalletError';
  }
}

export const isWalletError = (e: unknown, code?: WalletErrorCode): e is WalletError =>
  e instanceof WalletError && (code === undefined || e.code === code);
