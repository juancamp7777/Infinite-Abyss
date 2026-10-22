import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { Deck } from '../../../domain/entities/Deck';
import { AppError } from '../../../domain/errors/AppError';
import { BlackjackGame } from '../../../domain/entities/BlackjackGame';
import { GameType, GameStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertNotReplay, betIdempotencyKey, winIdempotencyKey } from '../gameSupport';

export class StartBlackjackHandUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository,
    /** Inyectable para pruebas deterministas (mazo conocido). */
    private readonly deckFactory: () => Deck = () => new Deck()
  ) {}

  public async execute(auth: PlayerAuth, betAmount: bigint, requestId?: string) {
    if (betAmount <= 0n) throw new AppError('El monto de la apuesta debe ser positivo', 400);

    // 1. Deduct balance first (referencia = id de la sesión)
    const sessionId = randomUUID();
    const betKey = betIdempotencyKey('blackjack', auth.userId, requestId);
    const bet = await this.walletService.placeBet({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: auth.currency,
      idempotencyKey: betKey,
      amount: betAmount,
      gameType: 'BLACKJACK',
      referenceId: sessionId,
    });
    assertNotReplay(bet.idempotentReplay);

    // 2. Initialize deck and deal
    const deck = this.deckFactory();
    const playerCards = [deck.draw(), deck.draw()];
    const dealerCards = [deck.draw(), deck.draw()]; // In real rules, second card is hidden

    let status: GameStatus = GameStatus.ACTIVE;
    let payout = 0n;
    
    // Check for instant player blackjack
    const isPlayerBJ = BlackjackGame.isBlackjack(playerCards);
    const isDealerBJ = BlackjackGame.isBlackjack(dealerCards);

    if (isPlayerBJ) {
      status = GameStatus.FINISHED;
      if (isDealerBJ) {
        // Push
        payout = betAmount;
      } else {
        // Blackjack pays 3:2 (apuesta + 1.5x, redondeo hacia abajo)
        payout = betAmount + (betAmount * 3n) / 2n;
      }
    } else if (isDealerBJ) {
      // Dealer has blackjack, game over
      status = GameStatus.FINISHED;
    }

    // 3. Save Game State
    const state = {
      deck: deck.remainingCards(),
      deckCards: (deck as any).cards, // Extract internal state for simplicity in this demo
      playerCards,
      dealerCards
    };

    let session;
    try {
      session = await this.gameSessionRepository.createSession({
        id: sessionId,
        operatorId: auth.operatorId,
        userId: auth.userId,
        gameType: GameType.BLACKJACK,
        betAmount,
        currency: auth.currency,
        state,
        status,
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

    // 4. If game finished instantly, pay out (la sesión ya nace FINISHED; el pago es idempotente por win:<sessionId>)
    let finalBalance = bet.balance;
    if (payout > 0n) {
      const win = await this.walletService.settleWin({
        operatorId: auth.operatorId,
        userId: auth.userId,
        currency: auth.currency,
        idempotencyKey: winIdempotencyKey(session.id),
        amount: payout,
        gameType: 'BLACKJACK',
        referenceId: session.id,
      });
      finalBalance = win.balance;
    }

    return {
      session: {
        id: session.id,
        status: session.status,
        playerScore: BlackjackGame.calculateScore(playerCards),
        dealerScore: status === GameStatus.FINISHED ? BlackjackGame.calculateScore(dealerCards) : BlackjackGame.calculateScore([dealerCards[0]]),
        playerCards,
        dealerCards: status === GameStatus.FINISHED ? dealerCards : [dealerCards[0]], // Hide second card if active
      },
      payout,
      newBalance: finalBalance
    };
  }
}
