import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { PlinkoGameEngine, PlinkoRows, PlinkoRisk, PlinkoResult } from '../../../domain/entities/PlinkoGameEngine';
import { AppError } from '../../../domain/errors/AppError';
import { applyMultiplier } from '../../../domain/money';
import { GameType, GameStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertNotReplay, betIdempotencyKey } from '../gameSupport';

export interface PlayPlinkoResponse {
  session: any;
  result: {
    path: ('L' | 'R')[];
    bin: number;
    multiplier: number;
  };
  payout: bigint;
  newBalance: bigint;
}

export type PlinkoDropFn = (rows: PlinkoRows, risk: PlinkoRisk) => PlinkoResult;

export class PlayPlinkoUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository,
    /** Inyectable para pruebas deterministas; por defecto el motor criptográfico. */
    private readonly dropBall: PlinkoDropFn = (rows, risk) => PlinkoGameEngine.dropBall(rows, risk)
  ) {}

  public async execute(
    auth: PlayerAuth,
    betAmount: bigint,
    rows: PlinkoRows,
    risk: PlinkoRisk,
    requestId?: string
  ): Promise<PlayPlinkoResponse> {
    if (betAmount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);
    if (![8, 12, 16].includes(rows)) throw new AppError('Número de filas inválido', 400);
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(risk)) throw new AppError('Nivel de riesgo inválido', 400);

    // 1. Calculate Provably Fair Result
    const dropResult = this.dropBall(rows, risk);
    const payout = applyMultiplier(betAmount, dropResult.multiplier);

    // 2. Transacción atómica (apuesta + pago) referenciando la sesión de auditoría
    const sessionId = randomUUID();
    const settled = await this.walletService.betAndSettle({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betIdempotencyKey('plinko', auth.userId, requestId),
      gameType: 'PLINKO',
      betAmount,
      winAmount: payout,
      referenceId: sessionId,
    });
    assertNotReplay(settled.idempotentReplay);

    // 3. Save Game Session for Audit (ya finalizada)
    const session = await this.gameSessionRepository.createSession({
      id: sessionId,
      operatorId: auth.operatorId,
      userId: auth.userId,
      gameType: GameType.PLINKO,
      betAmount,
      currency: auth.currency,
      status: GameStatus.FINISHED,
      state: {
        rows,
        risk,
        path: dropResult.path,
        bin: dropResult.bin,
        multiplier: dropResult.multiplier,
        payout: payout.toString()
      }
    });

    return {
      session,
      result: dropResult,
      payout,
      newBalance: settled.balance
    };
  }
}
