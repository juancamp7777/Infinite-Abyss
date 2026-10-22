import { PlayerAuth } from './AuthContext';

/**
 * Política de juego responsable. Cada método lanza AppError
 * (selfExcluded / limitExceeded / kycRequired) si no se permite; si pasa, resuelve void.
 */
export interface IResponsibleGamingPolicy {
  assertCanDeposit(ctx: PlayerAuth, amount: bigint): Promise<void>;
  assertCanBet(ctx: PlayerAuth, amount: bigint): Promise<void>;
  /** Requiere KYC VERIFIED, sin autoexclusión. */
  assertCanWithdraw(ctx: PlayerAuth): Promise<void>;
}
