/**
 * Cuentas de jugador para el CRM y la caja por chat: alta de leads (usuario + contraseña generados) y retiros
 * solicitados por chat sobre el circuito real de la Fase 1 (reserva de saldo + revisión humana + pago manual).
 */
export interface LeadAccount {
  playerId: string;
  username: string;
  /** Contraseña inicial en claro: se entrega UNA vez al contacto por el chat. */
  password: string;
}

export interface ChatWithdrawalRequest {
  operatorId: string;
  playerId: string;
  /** Unidades mínimas. */
  amount: bigint;
  destination: { account: string; holderName: string };
}

export interface ChatWithdrawalResult {
  withdrawalId: string;
  amount: bigint;
  currency: string;
}

export type PlayerAccountErrorCode = 'PLAYER_NOT_FOUND' | 'KYC_REQUIRED' | 'INSUFFICIENT_FUNDS' | 'LIMIT_EXCEEDED' | 'SELF_EXCLUDED' | 'BLOCKED' | 'INVALID';

export class PlayerAccountError extends Error {
  constructor(public readonly code: PlayerAccountErrorCode, message: string) {
    super(message);
  }
}

export interface PlayerAccountsPort {
  createLead(operatorId: string, displayName: string): Promise<LeadAccount>;
  exists(operatorId: string, playerId: string): Promise<boolean>;
  currency(operatorId: string, playerId: string): Promise<string | null>;
  requestWithdrawal(req: ChatWithdrawalRequest): Promise<ChatWithdrawalResult>;
}
