import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { MinesGame } from '../../../domain/entities/MinesGame';
import { GameType } from '@prisma/client';
import { AppError } from '../../../domain/errors/AppError';
import { randomUUID } from 'crypto';
import { assertNotReplay, betIdempotencyKey } from '../gameSupport';

export class StartMinesUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository,
    /** Inyectable para pruebas deterministas. */
    private readonly generateGrid: (numMines: number) => boolean[] = (n) => MinesGame.generateGrid(n)
  ) {}

  public async execute(auth: PlayerAuth, betAmount: bigint, numMines: number, requestId?: string) {
    if (betAmount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);
    if (numMines < 1 || numMines > 24) throw new Error("Invalid number of mines");

    // 1. Deduct balance (referencia = id de la sesión)
    const sessionId = randomUUID();
    const betKey = betIdempotencyKey('mines', auth.userId, requestId);
    const bet = await this.walletService.placeBet({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betKey,
      amount: betAmount,
      gameType: 'MINES',
      referenceId: sessionId,
    });
    assertNotReplay(bet.idempotentReplay);

    // 2. Generate Grid
    const grid = this.generateGrid(numMines);
    
    // 3. Save State (hidden grid)
    const state = {
      grid,
      numMines,
      revealed: new Array(25).fill(false), // true if user clicked
      revealedDiamonds: 0,
      gameOver: false,
      multiplier: 1.0
    };

    let session;
    try {
      session = await this.gameSessionRepository.createSession({
        id: sessionId,
        operatorId: auth.operatorId,
        userId: auth.userId,
        gameType: GameType.MINES,
        betAmount,
        currency: auth.currency,
        state,
      });
    } catch (error) {
      // No dejar al jugador cobrado sin sesión: anular la apuesta
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
        status: session.status,
        revealed: state.revealed,
        numMines: state.numMines,
        multiplier: state.multiplier,
        revealedDiamonds: state.revealedDiamonds,
        // The actual `grid` is never sent to the frontend.
        grid: [] 
      },
      newBalance: bet.balance
    };
  }
}
