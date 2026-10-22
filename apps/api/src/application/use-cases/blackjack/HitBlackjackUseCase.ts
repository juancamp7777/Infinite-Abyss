import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { BlackjackGame } from '../../../domain/entities/BlackjackGame';
import { AppError } from '../../../domain/errors/AppError';
import { GameStatus } from '@prisma/client';
import { hydrateBlackjackState, finishOrConflict, loadActiveSession } from '../gameSupport';

export class HitBlackjackUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository
  ) {}

  public async execute(auth: PlayerAuth, sessionId: string) {
    const session = await loadActiveSession(this.gameSessionRepository, auth, sessionId);

    const state = session.state;
    hydrateBlackjackState(state);
    const deckCards = state.deckCards;
    
    if (!deckCards || deckCards.length === 0) {
      throw new AppError('El mazo está vacío', 500);
    }

    // Draw a card
    const drawnCard = deckCards.pop();
    state.playerCards.push(drawnCard);

    let status: GameStatus = GameStatus.ACTIVE;
    const payout = 0n;
    
    const playerScore = BlackjackGame.calculateScore(state.playerCards);

    if (playerScore > 21) {
      // Bust!
      status = GameStatus.FINISHED;
    }

    // Save state
    if (status === GameStatus.FINISHED) {
      await finishOrConflict(this.gameSessionRepository, sessionId, state);
    } else {
      await this.gameSessionRepository.updateSessionState(sessionId, state, status);
    }

    const { cash: newBalance } = await this.walletService.getBalances({
      operatorId: auth.operatorId,
      userId: auth.userId,
    });

    return {
      session: {
        id: session.id,
        status,
        playerScore,
        dealerScore: status === GameStatus.FINISHED ? BlackjackGame.calculateScore(state.dealerCards) : BlackjackGame.calculateScore([state.dealerCards[0]]),
        playerCards: state.playerCards,
        dealerCards: status === GameStatus.FINISHED ? state.dealerCards : [state.dealerCards[0]],
      },
      payout,
      newBalance
    };
  }
}
