/**
 * Depósitos confirmados fuera de una pasarela (p. ej. Pearl: comprobante conciliado contra el banco del operador).
 * La Fase 1 los registra como Deposit + asiento DEPOSIT del ledger + evento deposit.completed, aplicando juego responsable.
 * Idempotente por `reference`: repetir la misma referencia nunca acredita dos veces.
 */
export interface ExternalDepositRequest {
  operatorId: string;
  playerId: string;
  currency: string;
  /** Unidades mínimas. */
  amount: bigint;
  /** Única por depósito (p. ej. `pearl:<receiptId>`). */
  reference: string;
  /** Id del movimiento bancario conciliado (externalId del depósito). */
  externalId?: string;
}

export interface ExternalDepositResult {
  depositId: string;
  txId: string;
  /** true si ya estaba acreditado (reintento). */
  duplicate: boolean;
}

export class ExternalDepositError extends Error {
  constructor(public readonly code: 'PLAYER_NOT_FOUND' | 'CURRENCY_MISMATCH' | 'RG_BLOCKED' | 'DEMO_ACCOUNT', message: string) {
    super(message);
  }
}

export interface ExternalDepositPort {
  credit(req: ExternalDepositRequest): Promise<ExternalDepositResult>;
}
