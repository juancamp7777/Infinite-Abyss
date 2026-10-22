import { IWalletService, PlayerAuth } from '../../../domain/contracts';
import { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import { CrashGameEngine } from '../../../domain/entities/CrashGame';
import { AppError } from '../../../domain/errors/AppError';
import { applyMultiplier } from '../../../domain/money';
import { GameStatus } from '@prisma/client';
import { finishOrConflict, loadActiveSession, winIdempotencyKey } from '../gameSupport';

export class CashoutCrashUseCase {
  constructor(
    private readonly walletService: IWalletService,
    private readonly gameSessionRepository: IGameSessionRepository,
    /** Inyectable para pruebas; por defecto el motor global. */
    private readonly engine: CrashGameEngine = CrashGameEngine.getInstance()
  ) {}

  public async execute(auth: PlayerAuth, sessionId: string) {
    const engine = this.engine;
    
    if (engine.state !== 'CRASHING') {
      throw new AppError('Solo puedes retirar mientras el multiplicador está activo', 400);
    }

    const session = await loadActiveSession(this.gameSessionRepository, auth, sessionId);

    const state = session.state;
    if (state.roundId !== engine.currentRoundId) {
      throw new AppError('Esta apuesta pertenece a una ronda de crash anterior.', 400);
    }
    
    if (state.cashedOut) {
            throw new AppError('Ya retiraste esta apuesta', 400);
    }

    // Capture exact multiplier at the moment of the request
    const multiplier = engine.currentMultiplier;
    
    const payout = applyMultiplier(session.betAmount, multiplier);

    state.cashedOut = true;
    state.cashoutMultiplier = multiplier;
    state.payout = payout.toString();

    // Solo paga quien cierra la sesión; el resto recibe 409
    await finishOrConflict(this.gameSessionRepository, sessionId, state);
    
    const win = await this.walletService.settleWin({
      operatorId: auth.operatorId,
      userId: auth.userId,
      currency: session.currency,
      idempotencyKey: winIdempotencyKey(session.id),
      amount: payout,
      gameType: 'CRASH',
      referenceId: session.id,
    });

    return {
      session: {
        id: session.id,
        status: GameStatus.FINISHED,
        cashoutMultiplier: multiplier
      },
      payout,
      newBalance: win.balance
    };
  }
}
