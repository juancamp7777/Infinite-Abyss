import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { AppError } from '../../../domain/errors/AppError';
import { applyMultiplier } from '../../../domain/money';
import { GameStatus } from '@prisma/client';
import { finishOrConflict, loadActiveSession, winIdempotencyKey } from '../gameSupport';

export class CashoutMinesUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository
  ) {}

  public async execute(auth: PlayerAuth, sessionId: string) {
    const session = await loadActiveSession(this.gameSessionRepository, auth, sessionId);

    const state = session.state;

    if (state.revealedDiamonds === 0) {
      throw new AppError('No puedes retirar sin revelar diamantes', 400);
    }

    const payout = applyMultiplier(session.betAmount, state.multiplier);
    state.gameOver = true;

    // Solo paga quien cierra la sesión; el resto recibe 409
    await finishOrConflict(this.gameSessionRepository, sessionId, state);

    const win = await this.walletService.settleWin({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: session.currency,
      idempotencyKey: winIdempotencyKey(session.id),
      amount: payout,
      gameType: 'MINES',
      referenceId: session.id,
    });

    return {
      session: {
        id: session.id,
        status: GameStatus.FINISHED,
        revealed: state.revealed,
        numMines: state.numMines,
        multiplier: state.multiplier,
        revealedDiamonds: state.revealedDiamonds,
        grid: state.grid // Reveal full grid
      },
      payout,
      newBalance: win.balance
    };
  }
}
