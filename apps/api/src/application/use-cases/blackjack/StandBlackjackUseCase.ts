import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { BlackjackGame } from '../../../domain/entities/BlackjackGame';
import { GameStatus } from '@prisma/client';
import { hydrateBlackjackState, finishOrConflict, loadActiveSession, winIdempotencyKey } from '../gameSupport';

export class StandBlackjackUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository
  ) {}

  public async execute(auth: PlayerAuth, sessionId: string) {
    const session = await loadActiveSession(this.gameSessionRepository, auth, sessionId);

    const state = session.state;
    hydrateBlackjackState(state);
    const deckCards = state.deckCards;
    
    const playerScore = BlackjackGame.calculateScore(state.playerCards);
    let dealerScore = BlackjackGame.calculateScore(state.dealerCards);

    // Dealer hits until 17
    while (dealerScore < 17 && deckCards.length > 0) {
      const drawnCard = deckCards.pop();
      state.dealerCards.push(drawnCard);
      dealerScore = BlackjackGame.calculateScore(state.dealerCards);
    }

    let payout = 0n;
    
    if (dealerScore > 21 || playerScore > dealerScore) {
      // Player wins
      payout = session.betAmount * 2n;
    } else if (playerScore === dealerScore) {
      // Push
      payout = session.betAmount;
    }
    // Else dealer wins, payout = 0

    // Save state: solo paga quien cierra la sesión; el resto recibe 409
    await finishOrConflict(this.gameSessionRepository, sessionId, state);

    // Pay out if needed
    let finalBalance: bigint;
    if (payout > 0n) {
      const win = await this.walletService.settleWin({
        operatorId: auth.operatorId,
        userId: auth.userId,
        currency: session.currency,
        idempotencyKey: winIdempotencyKey(session.id),
        amount: payout,
        gameType: 'BLACKJACK',
        referenceId: session.id,
      });
      finalBalance = win.balance;
    } else {
      finalBalance = (await this.walletService.getBalances({ operatorId: auth.operatorId, userId: auth.userId })).cash;
    }

    return {
      session: {
        id: session.id,
        status: GameStatus.FINISHED,
        playerScore,
        dealerScore,
        playerCards: state.playerCards,
        dealerCards: state.dealerCards,
      },
      payout,
      newBalance: finalBalance
    };
  }
}
