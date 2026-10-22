import { Bet } from '../../domain/entities/Bet';
import { RouletteResult } from '../../domain/entities/RouletteResult';
import { IRNGService } from '../../domain/services/IRNGService';
import { IWalletService, PlayerAuth } from '../../domain/contracts';
import { AppError } from '../../domain/errors/AppError';
import { assertNotReplay, betIdempotencyKey } from './gameSupport';

export interface ProcessBetResponse {
  result: RouletteResult;
  payout: bigint;
  newBalance: bigint;
}

export class ProcessBetUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly rngService: IRNGService
  ) {}

  public async execute(auth: PlayerAuth, bet: Bet, requestId?: string): Promise<ProcessBetResponse> {
    if (bet.amount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);
    // 1. Ejecutar el giro de la ruleta (0 a 36)
    const spinNumber = this.rngService.generateRandomNumber(0, 36);
    const resultColor = RouletteResult.getColorForNumber(spinNumber);
    const result = new RouletteResult(spinNumber, resultColor);

    // 2. Calcular el pago según la lógica de dominio
    let payout = 0n;
    
    if (bet.type === 'pleno') {
      if (bet.value === result.number) {
        // Pleno pays 35:1 (returns original bet + 35x the bet = 36)
        payout = bet.amount * 36n;
      }
    } else if (bet.type === 'color') {
      if (bet.value === result.color) {
        // Color pays 1:1 (returns original bet + 1x the bet = 2)
        payout = bet.amount * 2n;
      }
    }

    // 3. Apuesta y pago en una sola transacción atómica del ledger.
    // Lanza AppError (fondos insuficientes) si es necesario.
    const settled = await this.walletService.betAndSettle({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betIdempotencyKey('roulette', auth.userId, requestId),
      gameType: 'ROULETTE',
      betAmount: bet.amount,
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
