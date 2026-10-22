import { IWalletService, PlayerAuth } from '../../domain/contracts';
import { IRNGService } from '../../domain/services/IRNGService';
import { SlotMachine, SlotResult } from '../../domain/entities/SlotMachine';
import { AppError } from '../../domain/errors/AppError';
import { applyMultiplier } from '../../domain/money';
import { assertNotReplay, betIdempotencyKey } from './gameSupport';

export interface PlaySlotsResponse {
  result: SlotResult;
  payout: bigint;
  newBalance: bigint;
}

export class PlaySlotsUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly rngService: IRNGService
  ) {}

  public async execute(auth: PlayerAuth, amount: bigint, requestId?: string): Promise<PlaySlotsResponse> {
    if (amount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);

    const slotMachine = new SlotMachine(this.rngService);
    
    // 1. Spin the reels
    const result = slotMachine.spin();

    // 2. Calculate payout (redondeo hacia abajo, sin floats sobre el monto)
    const payout = applyMultiplier(amount, result.payoutMultiplier);

    // 3. Apuesta y pago en una sola transacción atómica del ledger.
    // Lanza AppError si no hay fondos suficientes.
    const settled = await this.walletService.betAndSettle({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betIdempotencyKey('slots', auth.userId, requestId),
      gameType: 'SLOTS',
      betAmount: amount,
      winAmount: payout,
    });
    assertNotReplay(settled.idempotentReplay);

    return {
      result,
      payout,
      newBalance: settled.balance
    };
  }
}
