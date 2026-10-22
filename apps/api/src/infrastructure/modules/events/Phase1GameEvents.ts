import type { GameType, PrismaClient } from '@prisma/client';
import type {
  BetAndSettleInput,
  BetAndSettleResult,
  IWalletService,
  PlaceBetInput,
  SettleWinInput,
  WalletOpResult,
} from '../../../domain/contracts';
import type { IGameSessionRepository } from '../../../domain/repositories/IGameSessionRepository';
import type { GameCategory } from '../../../modules/shared/events/EventBus';
import { publishInBackground, type DomainEventSink, type ErrorLogger } from './publishSafe';

/** Proveedor con el que se etiquetan los juegos propios de la Fase 1 en los eventos. */
export const PHASE1_PROVIDER = 'nymfo-originals';

const CATEGORY: Record<string, GameCategory> = {
  SLOTS: 'slots',
  ROULETTE: 'table',
  BLACKJACK: 'table',
  MINES: 'originals',
  CRASH: 'originals',
  PLINKO: 'originals',
};

export function phase1GameId(gameType: string): string {
  return `nymfo-${gameType.toLowerCase()}`;
}

interface RoundInfo {
  operatorId: string;
  userId: string;
  currency: string;
  gameType: string;
  betAmount: bigint;
}

/**
 * Emite bet.placed / bet.settled para los juegos de la Fase 1 (ruleta, slots, blackjack, mines, crash, plinko)
 * sin tocar sus casos de uso: decora la billetera y el repositorio de sesiones que reciben.
 *
 * - placeBet → bet.placed; betAndSettle → bet.placed + bet.settled.
 * - settleWin → bet.settled con la ganancia (el stake sale de la GameSession).
 * - Cierre de sesión sin pago (finishIfActive=true y ningún settleWin inmediato) → bet.settled con win=0.
 *   Los casos de uso llaman a settleWin justo después de finishOrConflict (misma cadena de microtareas), así que la
 *   decisión se toma en el siguiente macrotask (setImmediate).
 * - Los replays idempotentes no emiten. Todo se publica después del commit y los fallos solo se registran.
 *
 * La billetera de los módulos (Hub/Studios) NO pasa por aquí: esos módulos emiten sus propios eventos.
 */
export class Phase1GameEvents {
  private readonly pendingClose = new Map<string, RoundInfo>();

  constructor(
    private readonly bus: DomainEventSink,
    private readonly prisma: PrismaClient,
    private readonly logger?: ErrorLogger,
  ) {}

  wrapWallet(inner: IWalletService): IWalletService {
    const self = this;
    // Proxy: se delega todo lo que no sea apuesta/pago (depósitos, retiros, saldos, ajustes…).
    return new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'placeBet') return (input: PlaceBetInput) => self.placeBet(target, input);
        if (prop === 'settleWin') return (input: SettleWinInput) => self.settleWin(target, input);
        if (prop === 'betAndSettle') return (input: BetAndSettleInput) => self.betAndSettle(target, input);
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  wrapSessions(inner: IGameSessionRepository): IGameSessionRepository {
    return {
      createSession: (input) => inner.createSession(input),
      getSession: (id, scope) => inner.getSession(id, scope),
      updateSessionState: (id, state, status) => inner.updateSessionState(id, state, status),
      finishIfActive: async (id, state) => {
        const closed = await inner.finishIfActive(id, state);
        if (closed) await this.markClosed(id);
        return closed;
      },
    };
  }

  // ───────────── internos ─────────────

  private async placeBet(w: IWalletService, input: PlaceBetInput): Promise<WalletOpResult> {
    const res = await w.placeBet(input);
    if (!res.idempotentReplay) this.emitPlaced(input, input.amount, input.referenceId ?? res.ledgerTransactionId);
    return res;
  }

  private async betAndSettle(w: IWalletService, input: BetAndSettleInput): Promise<BetAndSettleResult> {
    const res = await w.betAndSettle(input);
    if (!res.idempotentReplay) {
      const roundId = input.referenceId ?? res.betLedgerTransactionId;
      this.emitPlaced(input, input.betAmount, roundId);
      this.emitSettled(
        { operatorId: input.operatorId, userId: input.userId, currency: input.currency, gameType: input.gameType, betAmount: input.betAmount },
        input.winAmount,
        roundId,
      );
    }
    return res;
  }

  private async settleWin(w: IWalletService, input: SettleWinInput): Promise<WalletOpResult> {
    // Se reclama el cierre pendiente de forma síncrona, antes de que dispare el setImmediate de "sin pago".
    const pending = input.referenceId ? this.pendingClose.get(input.referenceId) : undefined;
    if (input.referenceId) this.pendingClose.delete(input.referenceId);
    const res = await w.settleWin(input);
    if (!res.idempotentReplay && input.amount > 0n) {
      const round = pending ?? (input.referenceId ? await this.loadRound(input.referenceId) : null);
      this.emitSettled(
        round ?? { operatorId: input.operatorId, userId: input.userId, currency: input.currency, gameType: input.gameType, betAmount: 0n },
        input.amount,
        input.referenceId ?? res.ledgerTransactionId,
      );
    }
    return res;
  }

  private async markClosed(sessionId: string): Promise<void> {
    const round = await this.loadRound(sessionId);
    if (!round) return;
    this.pendingClose.set(sessionId, round);
    setImmediate(() => {
      const still = this.pendingClose.get(sessionId);
      if (!still) return; // hubo settleWin: ya emitió bet.settled con la ganancia
      this.pendingClose.delete(sessionId);
      this.emitSettled(still, 0n, sessionId);
    });
  }

  private async loadRound(sessionId: string): Promise<RoundInfo | null> {
    try {
      const s = await this.prisma.gameSession.findUnique({
        where: { id: sessionId },
        select: { operatorId: true, userId: true, currency: true, gameType: true, betAmount: true },
      });
      return s ? { ...s, gameType: s.gameType as GameType } : null;
    } catch (e) {
      this.logger?.error('game session lookup for events failed', { sessionId, error: String(e) });
      return null;
    }
  }

  private emitPlaced(input: { operatorId: string; userId: string; currency: string; gameType: string }, amount: bigint, roundId: string): void {
    publishInBackground(
      this.bus,
      'bet.placed',
      {
        operatorId: input.operatorId,
        playerId: input.userId,
        at: new Date().toISOString(),
        amount,
        currency: input.currency,
        gameId: phase1GameId(input.gameType),
        provider: PHASE1_PROVIDER,
        category: CATEGORY[input.gameType] ?? 'other',
        roundId,
        isBonusMoney: false,
      },
      this.logger,
    );
  }

  private emitSettled(round: RoundInfo, win: bigint, roundId: string): void {
    const multiplier = round.betAmount > 0n ? Number((win * 10_000n) / round.betAmount) / 10_000 : 0;
    publishInBackground(
      this.bus,
      'bet.settled',
      {
        operatorId: round.operatorId,
        playerId: round.userId,
        at: new Date().toISOString(),
        amount: round.betAmount,
        win,
        currency: round.currency,
        gameId: phase1GameId(round.gameType),
        provider: PHASE1_PROVIDER,
        category: CATEGORY[round.gameType] ?? 'other',
        roundId,
        multiplier,
      },
      this.logger,
    );
  }
}
