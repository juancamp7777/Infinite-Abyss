import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { CrashGameEngine } from '../../../domain/entities/CrashGame';
import { AppError } from '../../../domain/errors/AppError';
import { GameType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertNotReplay, betIdempotencyKey } from '../gameSupport';

export class PlaceCrashBetUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository,
    /** Inyectable para pruebas; por defecto el motor global. */
    private readonly engine: CrashGameEngine = CrashGameEngine.getInstance()
  ) {}

  public async execute(auth: PlayerAuth, betAmount: bigint, requestId?: string) {
    if (betAmount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);
    const engine = this.engine;
    
    if (engine.state !== 'WAITING') {
      throw new AppError('Solo puedes apostar durante la fase de espera', 400);
    }
    const roundId = engine.currentRoundId;

    // 1. Deduct balance (referencia = id de la sesión)
    const sessionId = randomUUID();
    const betKey = betIdempotencyKey('crash', auth.userId, requestId);
    const bet = await this.walletService.placeBet({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betKey,
      amount: betAmount,
      gameType: 'CRASH',
      referenceId: sessionId,
    });
    assertNotReplay(bet.idempotentReplay);

    // 2. Create Active Game Session to track the bet
    const state = {
      roundId,
      cashedOut: false,
      cashoutMultiplier: null,
      payout: null
    };

    let session;
    try {
      session = await this.gameSessionRepository.createSession({
        id: sessionId,
        operatorId: auth.operatorId,
        userId: auth.userId,
        gameType: GameType.CRASH,
        betAmount,
        currency: auth.currency,
        state,
      });
    } catch (error) {
      await this.walletService.rollback({
        operatorId: auth.operatorId,
        originalIdempotencyKey: betKey,
        idempotencyKey: `rollback:${sessionId}`,
        reason: 'Game session creation failed',
      }).catch(() => undefined);
      throw error;
    }

    return {
      session: {
        id: session.id,
        betAmount: session.betAmount
      },
      newBalance: bet.balance
    };
  }
}
