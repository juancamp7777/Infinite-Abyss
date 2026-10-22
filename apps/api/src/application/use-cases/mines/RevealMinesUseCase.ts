import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { MinesGame } from '../../../domain/entities/MinesGame';
import { AppError } from '../../../domain/errors/AppError';
import { applyMultiplier } from '../../../domain/money';
import { GameStatus } from '@prisma/client';
import { finishOrConflict, loadActiveSession, winIdempotencyKey } from '../gameSupport';

export class RevealMinesUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository
  ) {}

  public async execute(auth: PlayerAuth, sessionId: string, index: number) {
    if (index < 0 || index >= 25) throw new AppError('Índice de casilla inválido', 400);

    const session = await loadActiveSession(this.gameSessionRepository, auth, sessionId);

    const state = session.state;

    if (state.revealed[index]) {
      throw new AppError('La casilla ya fue revelada', 400);
    }

    state.revealed[index] = true;
    const isMine = state.grid[index];

    let status: GameStatus = GameStatus.ACTIVE;
    let payout = 0n;
    
    if (isMine) {
      // BUST!
      status = GameStatus.FINISHED;
      state.gameOver = true;
    } else {
      // DIAMOND!
      state.revealedDiamonds += 1;
      state.multiplier = MinesGame.calculateMultiplier(state.numMines, state.revealedDiamonds);
      
      // Auto cashout if they found all diamonds
      if (state.revealedDiamonds === (25 - state.numMines)) {
        status = GameStatus.FINISHED;
        state.gameOver = true;
        payout = applyMultiplier(session.betAmount, state.multiplier);
      }
    }

    if (status === GameStatus.FINISHED) {
      // Solo la petición que cierra la sesión puede pagar
      await finishOrConflict(this.gameSessionRepository, sessionId, state);
    } else {
      await this.gameSessionRepository.updateSessionState(sessionId, state, status);
    }

    let finalBalance: bigint;
    if (payout > 0n) {
      const win = await this.walletService.settleWin({
        operatorId: auth.operatorId,
        userId: auth.userId,
        currency: session.currency,
        idempotencyKey: winIdempotencyKey(session.id),
        amount: payout,
        gameType: 'MINES',
        referenceId: session.id,
      });
      finalBalance = win.balance;
    } else {
      finalBalance = (await this.walletService.getBalances({ operatorId: auth.operatorId, userId: auth.userId })).cash;
    }

    return {
      session: {
        id: session.id,
        status,
        revealed: state.revealed,
        numMines: state.numMines,
        multiplier: state.multiplier,
        revealedDiamonds: state.revealedDiamonds,
        // If game over, reveal the entire grid
        grid: status === GameStatus.FINISHED ? state.grid : []
      },
      payout,
      isMine,
      newBalance: finalBalance
    };
  }
}
