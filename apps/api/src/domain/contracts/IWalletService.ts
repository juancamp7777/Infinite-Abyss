/**
 * Contrato de la billetera (ledger de doble partida). Implementa s2.
 *
 * Reglas comunes:
 *  - Montos: bigint en unidades mínimas de `currency`, siempre > 0 (salvo manualAdjustment, con signo).
 *  - Todas las operaciones son idempotentes por (operatorId, idempotencyKey):
 *      misma clave y mismo payload → devuelve el resultado original con idempotentReplay=true;
 *      misma clave con otro payload → AppError CONFLICT (409).
 *  - Aislamiento: si userId no pertenece a operatorId → AppError FORBIDDEN.
 *  - Saldo insuficiente → AppError INSUFFICIENT_FUNDS. Nunca saldo negativo.
 */

import type { LedgerAccountKind, LedgerPosting } from '../ledger/LedgerPosting';

export interface WalletOpBase {
  operatorId: string;
  userId: string;
  currency: string;
  idempotencyKey: string;
}

export interface WalletOpResult {
  ledgerTransactionId: string;
  /** Saldo CASH del jugador tras la operación (unidades mínimas). */
  balance: bigint;
  idempotentReplay: boolean;
}

export interface PlayerBalances {
  currency: string;
  cash: bigint;
  bonus: bigint;
}

export interface PlaceBetInput extends WalletOpBase {
  amount: bigint;
  gameType: string;
  /** Id de GameSession/ronda para trazabilidad. */
  referenceId?: string;
}

export interface SettleWinInput extends WalletOpBase {
  /** Ganancia total pagada (stake incluido si el juego lo devuelve). 0 no genera movimiento. */
  amount: bigint;
  gameType: string;
  referenceId?: string;
}

/** Juegos instantáneos: apuesta y resultado en UNA transacción SQL. */
export interface BetAndSettleInput extends WalletOpBase {
  betAmount: bigint;
  /** Pago total (puede ser 0n si pierde). */
  winAmount: bigint;
  gameType: string;
  referenceId?: string;
}

export interface BetAndSettleResult extends WalletOpResult {
  betLedgerTransactionId: string;
  winLedgerTransactionId: string | null;
}

export interface RollbackInput {
  operatorId: string;
  /** idempotencyKey de la transacción original que se anula. */
  originalIdempotencyKey: string;
  /** Clave de idempotencia del rollback. */
  idempotencyKey: string;
  reason: string;
}

export interface CreditDepositInput extends WalletOpBase {
  amount: bigint;
  depositId: string;
  /** PEARL = caja asistida (comprobante conciliado contra el banco del operador). */
  provider: 'PASSIMPAY' | 'WOMPI' | 'PEARL' | 'BOLD';
}

export interface WithdrawalLedgerInput extends WalletOpBase {
  amount: bigint;
  withdrawalId: string;
}

export interface ManualAdjustmentInput extends WalletOpBase {
  /** Con signo: >0 acredita al jugador, <0 debita. */
  amount: bigint;
  /** Obligatorio, no vacío. Se guarda además en AuditLog. */
  reason: string;
  actorBackofficeUserId: string;
}

export interface CreditDemoInput extends WalletOpBase {
  amount: bigint;
}

export interface IWalletService {
  getBalances(input: { operatorId: string; userId: string }): Promise<PlayerBalances>;
  placeBet(input: PlaceBetInput): Promise<WalletOpResult>;
  settleWin(input: SettleWinInput): Promise<WalletOpResult>;
  betAndSettle(input: BetAndSettleInput): Promise<BetAndSettleResult>;
  rollback(input: RollbackInput): Promise<WalletOpResult>;
  /** CASH +X / PSP_CLEARING −X */
  creditDeposit(input: CreditDepositInput): Promise<WalletOpResult>;
  /** CASH −X / WITHDRAWAL_PENDING +X (solo CASH, nunca bono) */
  reserveWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult>;
  /** Rechazo/fallo: WITHDRAWAL_PENDING −X / CASH +X */
  releaseWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult>;
  /** Pagado: WITHDRAWAL_PENDING −X / PSP_CLEARING +X */
  completeWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult>;
  manualAdjustment(input: ManualAdjustmentInput): Promise<WalletOpResult>;
  /** Solo para User.isDemo = true; si no → FORBIDDEN. */
  creditDemo(input: CreditDemoInput): Promise<WalletOpResult>;
}

// ───────────── Movimientos genéricos (adaptadores de módulos: Hub, Studios, promociones, gamificación) ─────────────

/** Tipos de LedgerTransaction que pueden registrar los adaptadores de módulos. */
export type ModuleLedgerTxType =
  | 'BET'
  | 'WIN'
  | 'REFUND'
  | 'BONUS_GRANT'
  | 'BONUS_CONVERT'
  | 'BONUS_FORFEIT'
  | 'CASHBACK'
  | 'JACKPOT_CONTRIBUTION'
  | 'JACKPOT_PAYOUT'
  | 'TOURNAMENT_BUYIN'
  | 'TOURNAMENT_PRIZE';

/** Saldos de las cuentas bloqueadas dentro de la transacción (para asientos que dependen del saldo). */
export interface LockedBalances {
  cash: bigint;
  bonus: bigint;
  /** Saldo de cualquier cuenta bloqueada (de jugador o de operador) por tipo; 0 si no está bloqueada. */
  of(kind: LedgerAccountKind): bigint;
}

export interface PlayerMovementInput extends WalletOpBase {
  type: ModuleLedgerTxType;
  /** Monto positivo de la operación (se compara en reintentos). */
  amount: bigint;
  /** Cuentas a bloquear (además de PLAYER_CASH y PLAYER_BONUS, que siempre se bloquean). */
  accounts: readonly LedgerAccountKind[];
  /** Asiento a registrar; se construye con las cuentas ya bloqueadas. Debe sumar 0. */
  posting: (balances: LockedBalances) => LedgerPosting;
  /** Huella adicional del payload: misma clave con otra huella → CONFLICT. */
  fingerprint?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  /** Exige jugador ACTIVE y evalúa la política de juego responsable (apuestas). */
  enforceBetPolicy?: boolean;
}

export interface PlayerMovementResult {
  ledgerTransactionId: string;
  idempotentReplay: boolean;
  cash: bigint;
  bonus: bigint;
}

/** Traspaso entre cuentas de operador (sin jugador), p. ej. contribución HOUSE → JACKPOT_POOL. */
export interface OperatorTransferInput {
  operatorId: string;
  currency: string;
  idempotencyKey: string;
  type: ModuleLedgerTxType;
  amount: bigint;
  posting: LedgerPosting;
  fingerprint?: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}
