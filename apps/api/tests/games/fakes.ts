import { GameStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppError } from '../../src/domain/errors/AppError';
import {
  BetAndSettleInput,
  BetAndSettleResult,
  IWalletService,
  PlaceBetInput,
  PlayerAuth,
  PlayerBalances,
  RollbackInput,
  SettleWinInput,
  WalletOpResult,
} from '../../src/domain/contracts';
import {
  CreateGameSessionInput,
  GameSessionData,
  GameSessionScope,
  IGameSessionRepository,
} from '../../src/domain/repositories/IGameSessionRepository';

/** Billetera en memoria con saldos bigint, idempotencia y registro de llamadas. */
export class FakeWalletService implements IWalletService {
  public balances = new Map<string, bigint>();
  public calls: Array<{ op: string; input: any }> = [];
  private results = new Map<string, WalletOpResult>();

  constructor(initial: Record<string, bigint> = {}) {
    for (const [userId, amount] of Object.entries(initial)) this.balances.set(userId, amount);
  }

  private key(operatorId: string, k: string) {
    return `${operatorId}:${k}`;
  }

  private bal(userId: string) {
    return this.balances.get(userId) ?? 0n;
  }

  public callsOf(op: string) {
    return this.calls.filter((c) => c.op === op).map((c) => c.input);
  }

  async getBalances(input: { operatorId: string; userId: string }): Promise<PlayerBalances> {
    return { currency: 'COP', cash: this.bal(input.userId), bonus: 0n };
  }

  async placeBet(input: PlaceBetInput): Promise<WalletOpResult> {
    this.calls.push({ op: 'placeBet', input });
    const k = this.key(input.operatorId, input.idempotencyKey);
    const prev = this.results.get(k);
    if (prev) return { ...prev, idempotentReplay: true };
    if (this.bal(input.userId) < input.amount) throw AppError.insufficientFunds();
    this.balances.set(input.userId, this.bal(input.userId) - input.amount);
    const res = { ledgerTransactionId: randomUUID(), balance: this.bal(input.userId), idempotentReplay: false };
    this.results.set(k, res);
    return res;
  }

  async settleWin(input: SettleWinInput): Promise<WalletOpResult> {
    this.calls.push({ op: 'settleWin', input });
    const k = this.key(input.operatorId, input.idempotencyKey);
    const prev = this.results.get(k);
    if (prev) return { ...prev, idempotentReplay: true };
    this.balances.set(input.userId, this.bal(input.userId) + input.amount);
    const res = { ledgerTransactionId: randomUUID(), balance: this.bal(input.userId), idempotentReplay: false };
    this.results.set(k, res);
    return res;
  }

  async betAndSettle(input: BetAndSettleInput): Promise<BetAndSettleResult> {
    this.calls.push({ op: 'betAndSettle', input });
    const k = this.key(input.operatorId, input.idempotencyKey);
    const prev = this.results.get(k);
    if (prev) return { ...(prev as BetAndSettleResult), idempotentReplay: true };
    if (this.bal(input.userId) < input.betAmount) throw AppError.insufficientFunds();
    this.balances.set(input.userId, this.bal(input.userId) - input.betAmount + input.winAmount);
    const res: BetAndSettleResult = {
      ledgerTransactionId: randomUUID(),
      betLedgerTransactionId: randomUUID(),
      winLedgerTransactionId: input.winAmount > 0n ? randomUUID() : null,
      balance: this.bal(input.userId),
      idempotentReplay: false,
    };
    this.results.set(k, res);
    return res;
  }

  async rollback(input: RollbackInput): Promise<WalletOpResult> {
    this.calls.push({ op: 'rollback', input });
    return { ledgerTransactionId: randomUUID(), balance: 0n, idempotentReplay: false };
  }

  private unsupported(): never {
    throw new Error('not used in game tests');
  }
  creditDeposit = async () => this.unsupported();
  reserveWithdrawal = async () => this.unsupported();
  releaseWithdrawal = async () => this.unsupported();
  completeWithdrawal = async () => this.unsupported();
  manualAdjustment = async () => this.unsupported();
  creditDemo = async () => this.unsupported();
}

/** Repositorio de sesiones en memoria con la misma semántica que el de Prisma. */
export class InMemoryGameSessionRepository implements IGameSessionRepository {
  public sessions = new Map<string, GameSessionData>();

  async createSession(input: CreateGameSessionInput): Promise<GameSessionData> {
    const session: GameSessionData = {
      id: input.id ?? randomUUID(),
      operatorId: input.operatorId,
      userId: input.userId,
      gameType: input.gameType,
      status: input.status ?? GameStatus.ACTIVE,
      betAmount: input.betAmount,
      currency: input.currency,
      state: structuredClone(input.state),
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async getSession(sessionId: string, scope: GameSessionScope): Promise<GameSessionData | null> {
    const s = this.sessions.get(sessionId);
    if (!s || s.operatorId !== scope.operatorId || s.userId !== scope.userId) return null;
    return structuredClone(s);
  }

  async updateSessionState(sessionId: string, state: any, status?: GameStatus): Promise<GameSessionData> {
    const s = this.sessions.get(sessionId)!;
    s.state = structuredClone(state);
    if (status) s.status = status;
    return structuredClone(s);
  }

  async finishIfActive(sessionId: string, state: any): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== GameStatus.ACTIVE) return false;
    s.state = structuredClone(state);
    s.status = GameStatus.FINISHED;
    return true;
  }
}

export function makeAuth(overrides: Partial<PlayerAuth> = {}): PlayerAuth {
  return { kind: 'player', userId: 'user-1', operatorId: 'op-1', currency: 'COP', isDemo: false, ...overrides };
}

/** RNG determinista: devuelve la secuencia dada en bucle (acotada a [min,max]). */
export class SequenceRng {
  private i = 0;
  constructor(private readonly values: number[]) {}
  generateRandomNumber(min: number, max: number): number {
    const v = this.values[this.i++ % this.values.length];
    return Math.min(max, Math.max(min, v));
  }
}
