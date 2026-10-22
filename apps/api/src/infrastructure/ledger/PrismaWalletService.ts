import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { LedgerTransaction, LedgerTxType, User } from '@prisma/client';
import { AppError } from '../../domain/errors/AppError';
import {
  assertBalancedPosting,
  assertSameCurrency,
  isPlayerAccount,
  postings,
  reverseEntries,
} from '../../domain/ledger';
import type { ConcreteEntry, LedgerAccountKind, LedgerPosting } from '../../domain/ledger';
import type {
  BetAndSettleInput,
  BetAndSettleResult,
  CreditDemoInput,
  CreditDepositInput,
  IResponsibleGamingPolicy,
  IWalletService,
  ManualAdjustmentInput,
  OperatorTransferInput,
  PlaceBetInput,
  PlayerAuth,
  PlayerBalances,
  PlayerMovementInput,
  PlayerMovementResult,
  RollbackInput,
  SettleWinInput,
  WalletOpResult,
  WithdrawalLedgerInput,
} from '../../domain/contracts';

type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_OPTIONS = { maxWait: 30_000, timeout: 30_000 } as const;
const OPERATOR_OWNER_KEY = 'OPERATOR';

interface AccountState {
  id: string;
  type: LedgerAccountKind;
  balance: bigint;
}

/** Política sin restricciones (tests y entornos sin juego responsable). */
export class NoopResponsibleGamingPolicy implements IResponsibleGamingPolicy {
  async assertCanDeposit(): Promise<void> {}
  async assertCanBet(): Promise<void> {}
  async assertCanWithdraw(): Promise<void> {}
}

interface Fingerprint {
  type: LedgerTxType;
  userId: string;
  amount: bigint;
  currency: string;
}

interface PostParams {
  operatorId: string;
  currency: string;
  type: LedgerTxType;
  key: string;
  entries: ConcreteEntry[];
  referenceType?: string;
  referenceId?: string;
  metadata: Record<string, unknown>;
  createdBy?: string;
  reversesId?: string;
}

interface SingleSpec {
  operatorId: string;
  userId: string;
  currency: string;
  key: string;
  type: LedgerTxType;
  posting: LedgerPosting;
  /** Monto (con signo) usado para comparar el payload en reintentos. */
  amount: bigint;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  requireActive?: boolean;
  /** Validaciones dentro de la transacción, con las cuentas ya bloqueadas. */
  precheck?: (tx: Tx, user: User) => Promise<void>;
  /** Efectos en la misma transacción SQL (auditoría, marcar depósito…). */
  afterPost?: (tx: Tx, ledgerTx: { id: string }) => Promise<void>;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export class PrismaWalletService implements IWalletService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly rgPolicy: IResponsibleGamingPolicy = new NoopResponsibleGamingPolicy(),
  ) {}

  // ───────────────────────── Lecturas ─────────────────────────

  async getBalances(input: { operatorId: string; userId: string }): Promise<PlayerBalances> {
    const user = await this.loadUser(this.prisma, input.operatorId, input.userId);
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: {
        operatorId: input.operatorId,
        ownerKey: user.id,
        currency: user.currency,
        type: { in: ['PLAYER_CASH', 'PLAYER_BONUS'] },
      },
    });
    const bal = (t: string) => accounts.find((a) => a.type === t)?.balance ?? 0n;
    return { currency: user.currency, cash: bal('PLAYER_CASH'), bonus: bal('PLAYER_BONUS') };
  }

  // ───────────────────────── Juego ─────────────────────────

  async placeBet(input: PlaceBetInput): Promise<WalletOpResult> {
    this.assertPositive(input.amount);
    const user = await this.loadUser(this.prisma, input.operatorId, input.userId);
    await this.runPolicyUnlessReplay(input.operatorId, input.idempotencyKey, user, input.amount);
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'BET',
      posting: postings.bet(input.amount),
      amount: input.amount,
      referenceType: 'GAME',
      referenceId: input.referenceId,
      metadata: { gameType: input.gameType },
      requireActive: true,
    });
  }

  async settleWin(input: SettleWinInput): Promise<WalletOpResult> {
    if (typeof input.amount !== 'bigint' || input.amount < 0n) throw AppError.validation('Invalid win amount');
    if (input.amount === 0n) {
      // Sin movimiento: no se crea transacción de ledger (ledgerTransactionId vacío).
      const b = await this.getBalances({ operatorId: input.operatorId, userId: input.userId });
      return { ledgerTransactionId: '', balance: b.cash, idempotentReplay: false };
    }
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'WIN',
      posting: postings.win(input.amount),
      amount: input.amount,
      referenceType: 'GAME',
      referenceId: input.referenceId,
      metadata: { gameType: input.gameType },
    });
  }

  async betAndSettle(input: BetAndSettleInput): Promise<BetAndSettleResult> {
    this.assertPositive(input.betAmount);
    if (typeof input.winAmount !== 'bigint' || input.winAmount < 0n) throw AppError.validation('Invalid win amount');
    const user = await this.loadUser(this.prisma, input.operatorId, input.userId);
    await this.runPolicyUnlessReplay(input.operatorId, input.idempotencyKey, user, input.betAmount);

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.betAndSettleTx(tx, input), TX_OPTIONS);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (attempt >= 1) throw AppError.conflict('Concurrent ledger conflict');
      }
    }
  }

  private async betAndSettleTx(tx: Tx, input: BetAndSettleInput): Promise<BetAndSettleResult> {
    const user = await this.loadUser(tx, input.operatorId, input.userId);
    this.assertUserCurrency(user, input.currency);
    if (user.status !== 'ACTIVE') throw AppError.forbidden('Player is not active');

    const kinds: LedgerAccountKind[] = ['PLAYER_CASH', 'HOUSE'];
    const { ids, state } = await this.prepareAccounts(tx, input.operatorId, user.id, input.currency, kinds);
    const cashId = ids.get('PLAYER_CASH')!;
    const winKey = `${input.idempotencyKey}:win`;

    const existingBet = await tx.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: input.idempotencyKey } },
    });
    if (existingBet) {
      const betOk = this.matches(existingBet, { type: 'BET', userId: user.id, amount: input.betAmount, currency: input.currency });
      const existingWin = await tx.ledgerTransaction.findUnique({
        where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: winKey } },
      });
      const winOk = input.winAmount === 0n
        ? existingWin === null
        : existingWin !== null &&
          this.matches(existingWin, { type: 'WIN', userId: user.id, amount: input.winAmount, currency: input.currency });
      if (!betOk || !winOk) throw AppError.conflict('Idempotency key reused with a different payload');
      return {
        ledgerTransactionId: existingWin?.id ?? existingBet.id,
        betLedgerTransactionId: existingBet.id,
        winLedgerTransactionId: existingWin?.id ?? null,
        balance: state.get(cashId)!.balance,
        idempotentReplay: true,
      };
    }

    const common = { operatorId: input.operatorId, currency: input.currency };
    const betTx = await this.post(
      tx,
      {
        ...common,
        type: 'BET',
        key: input.idempotencyKey,
        entries: this.resolve(postings.bet(input.betAmount), ids, state),
        referenceType: 'GAME',
        referenceId: input.referenceId,
        metadata: this.meta(user.id, input.betAmount, { gameType: input.gameType }),
      },
      state,
    );
    let winTxId: string | null = null;
    if (input.winAmount > 0n) {
      const winTx = await this.post(
        tx,
        {
          ...common,
          type: 'WIN',
          key: winKey,
          entries: this.resolve(postings.win(input.winAmount), ids, state),
          referenceType: 'GAME',
          referenceId: input.referenceId,
          metadata: this.meta(user.id, input.winAmount, { gameType: input.gameType, betKey: input.idempotencyKey }),
        },
        state,
      );
      winTxId = winTx.id;
    }
    return {
      ledgerTransactionId: winTxId ?? betTx.id,
      betLedgerTransactionId: betTx.id,
      winLedgerTransactionId: winTxId,
      balance: state.get(cashId)!.balance,
      idempotentReplay: false,
    };
  }

  // ───────────────────────── Rollback ─────────────────────────

  async rollback(input: RollbackInput): Promise<WalletOpResult> {
    if (!input.reason || input.reason.trim() === '') throw AppError.validation('Rollback reason is required');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.rollbackTx(tx, input), TX_OPTIONS);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (attempt >= 1) throw AppError.conflict('Transaction already reversed');
      }
    }
  }

  private async rollbackTx(tx: Tx, input: RollbackInput): Promise<WalletOpResult> {
    const original = await tx.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: input.originalIdempotencyKey } },
      include: { entries: { include: { account: true } } },
    });
    if (!original) throw AppError.notFound('Original transaction not found');
    if (original.type === 'ROLLBACK') throw AppError.conflict('A rollback cannot be rolled back');
    const userId = (original.metadata as { userId?: string } | null)?.userId;

    // Bloquear todas las cuentas involucradas, en orden de id.
    const accountIds = [...new Set(original.entries.map((e) => e.accountId))];
    const locked = await this.lock(tx, accountIds);
    const state = new Map<string, AccountState>();
    for (const e of original.entries) {
      state.set(e.accountId, { id: e.accountId, type: e.account.type as LedgerAccountKind, balance: locked.get(e.accountId)! });
    }

    const cashBalance = async (): Promise<bigint> => {
      if (!userId) return 0n;
      const cash = await tx.ledgerAccount.findFirst({
        where: { operatorId: input.operatorId, ownerKey: userId, type: 'PLAYER_CASH', currency: original.currency },
      });
      return cash?.balance ?? 0n;
    };

    const existing = await tx.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.type !== 'ROLLBACK' || existing.reversesId !== original.id) {
        throw AppError.conflict('Idempotency key reused with a different payload');
      }
      return { ledgerTransactionId: existing.id, balance: await cashBalance(), idempotentReplay: true };
    }
    const alreadyReversed = await tx.ledgerTransaction.findUnique({ where: { reversesId: original.id } });
    if (alreadyReversed) throw AppError.conflict('Transaction already reversed');

    const entries = reverseEntries(original.entries.map((e) => ({ accountId: e.accountId, amount: e.amount })));
    const rb = await this.post(
      tx,
      {
        operatorId: input.operatorId,
        currency: original.currency,
        type: 'ROLLBACK',
        key: input.idempotencyKey,
        entries,
        referenceType: original.referenceType ?? undefined,
        referenceId: original.referenceId ?? undefined,
        reversesId: original.id,
        metadata: {
          userId: userId ?? null,
          amount: '0',
          originalIdempotencyKey: input.originalIdempotencyKey,
          reason: input.reason.trim(),
        },
      },
      state,
    );
    return { ledgerTransactionId: rb.id, balance: await cashBalance(), idempotentReplay: false };
  }

  // ───────────────────────── Movimientos de módulos ─────────────────────────

  /**
   * Movimiento genérico de jugador para los adaptadores de módulos (Hub, Studios, promociones,
   * gamificación). Mismas garantías que el resto: idempotencia por (operatorId, clave) con huella
   * del payload, aislamiento por operador, SELECT ... FOR UPDATE ORDER BY id, cuentas de jugador
   * nunca negativas y reintento ante P2002. PLAYER_CASH y PLAYER_BONUS siempre se bloquean, así el
   * asiento puede depender del saldo (p. ej. apuesta que consume primero cash y luego bono).
   */
  async postPlayerMovement(input: PlayerMovementInput): Promise<PlayerMovementResult> {
    this.assertPositive(input.amount);
    if (!input.idempotencyKey) throw AppError.validation('idempotencyKey is required');
    if (input.enforceBetPolicy) {
      const user = await this.loadUser(this.prisma, input.operatorId, input.userId);
      await this.runPolicyUnlessReplay(input.operatorId, input.idempotencyKey, user, input.amount);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.playerMovementTx(tx, input), TX_OPTIONS);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (attempt >= 1) throw AppError.conflict('Concurrent ledger conflict');
      }
    }
  }

  private async playerMovementTx(tx: Tx, input: PlayerMovementInput): Promise<PlayerMovementResult> {
    const user = await this.loadUser(tx, input.operatorId, input.userId);
    this.assertUserCurrency(user, input.currency);
    const kinds = [...new Set<LedgerAccountKind>(['PLAYER_CASH', 'PLAYER_BONUS', ...input.accounts])];
    const { ids, state } = await this.prepareAccounts(tx, input.operatorId, user.id, input.currency, kinds);
    const balanceOf = (k: LedgerAccountKind) => {
      const id = ids.get(k);
      return id ? state.get(id)!.balance : 0n;
    };
    const snapshot = () => ({ cash: balanceOf('PLAYER_CASH'), bonus: balanceOf('PLAYER_BONUS') });

    const existing = await tx.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      const fp = (existing.metadata as { fp?: string } | null)?.fp;
      const same =
        this.matches(existing, { type: input.type, userId: user.id, amount: input.amount, currency: input.currency }) &&
        (input.fingerprint === undefined || fp === input.fingerprint);
      if (!same) throw AppError.conflict('Idempotency key reused with a different payload');
      return { ledgerTransactionId: existing.id, idempotentReplay: true, ...snapshot() };
    }
    if (input.enforceBetPolicy && user.status !== 'ACTIVE') throw AppError.forbidden('Player is not active');

    const posting = input.posting({ ...snapshot(), of: balanceOf });
    for (const l of posting) {
      if (!kinds.includes(l.account.type)) throw new AppError('Posting uses an unlocked account', 500, false, 'APP_ERROR');
    }
    const created = await this.post(
      tx,
      {
        operatorId: input.operatorId,
        currency: input.currency,
        type: input.type,
        key: input.idempotencyKey,
        entries: this.resolve(posting, ids, state),
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        metadata: this.meta(user.id, input.amount, {
          ...(input.metadata ?? {}),
          ...(input.fingerprint !== undefined ? { fp: input.fingerprint } : {}),
        }),
      },
      state,
    );
    return { ledgerTransactionId: created.id, idempotentReplay: false, ...snapshot() };
  }

  /**
   * Traspaso entre cuentas de operador (sin jugador): contribuciones a jackpots, fondeo de pozos…
   * Idempotente por (operatorId, clave); las cuentas de operador pueden quedar negativas.
   */
  async postOperatorTransfer(input: OperatorTransferInput): Promise<{ ledgerTransactionId: string; idempotentReplay: boolean }> {
    this.assertPositive(input.amount);
    if (!input.idempotencyKey) throw AppError.validation('idempotencyKey is required');
    if (input.posting.some((l) => isPlayerAccount(l.account.type))) {
      throw AppError.validation('Operator transfers cannot touch player accounts');
    }
    if (!UUID_RE.test(input.operatorId)) throw AppError.forbidden('Unknown operator');
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const op = await tx.operator.findUnique({ where: { id: input.operatorId }, select: { id: true } });
          if (!op) throw AppError.forbidden('Unknown operator');
          const kinds = [...new Set(input.posting.map((l) => l.account.type))];
          const ids = new Map<LedgerAccountKind, string>();
          for (const k of kinds) ids.set(k, await this.ensureAccount(tx, input.operatorId, null, k, input.currency));
          const locked = await this.lock(tx, [...ids.values()]);
          const state = new Map<string, AccountState>();
          for (const [k, id] of ids) state.set(id, { id, type: k, balance: locked.get(id)! });

          const existing = await tx.ledgerTransaction.findUnique({
            where: { operatorId_idempotencyKey: { operatorId: input.operatorId, idempotencyKey: input.idempotencyKey } },
          });
          if (existing) {
            const m = existing.metadata as { amount?: string; fp?: string; userId?: string | null } | null;
            const same =
              existing.type === input.type &&
              existing.currency === input.currency &&
              m?.amount === input.amount.toString() &&
              !m?.userId &&
              (input.fingerprint === undefined || m?.fp === input.fingerprint);
            if (!same) throw AppError.conflict('Idempotency key reused with a different payload');
            return { ledgerTransactionId: existing.id, idempotentReplay: true };
          }
          const created = await this.post(
            tx,
            {
              operatorId: input.operatorId,
              currency: input.currency,
              type: input.type,
              key: input.idempotencyKey,
              entries: this.resolve(input.posting, ids, state),
              referenceType: input.referenceType,
              referenceId: input.referenceId,
              metadata: {
                userId: null,
                amount: input.amount.toString(),
                ...(input.metadata ?? {}),
                ...(input.fingerprint !== undefined ? { fp: input.fingerprint } : {}),
              },
            },
            state,
          );
          return { ledgerTransactionId: created.id, idempotentReplay: false };
        }, TX_OPTIONS);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (attempt >= 1) throw AppError.conflict('Concurrent ledger conflict');
      }
    }
  }

  // ───────────────────────── Cajero ─────────────────────────

  async creditDeposit(input: CreditDepositInput): Promise<WalletOpResult> {
    this.assertPositive(input.amount);
    const depositId = input.depositId;
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'DEPOSIT',
      posting: postings.deposit(input.amount),
      amount: input.amount,
      referenceType: 'DEPOSIT',
      referenceId: depositId,
      metadata: { provider: input.provider, depositId },
      precheck: async (tx) => {
        if (!UUID_RE.test(depositId)) return;
        const dep = await tx.deposit.findFirst({ where: { id: depositId, operatorId: input.operatorId } });
        if (!dep) return;
        if (
          dep.userId !== input.userId ||
          dep.amount !== input.amount ||
          dep.currency !== input.currency ||
          dep.provider !== input.provider
        ) {
          throw AppError.conflict('Deposit does not match the credited payload');
        }
        if (dep.ledgerTransactionId) throw AppError.conflict('Deposit already credited');
      },
      afterPost: async (tx, ledgerTx) => {
        if (!UUID_RE.test(depositId)) return;
        await tx.deposit.updateMany({
          where: { id: depositId, operatorId: input.operatorId, ledgerTransactionId: null },
          data: { status: 'CONFIRMED', confirmedAt: new Date(), ledgerTransactionId: ledgerTx.id },
        });
      },
    });
  }

  async reserveWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult> {
    this.assertPositive(input.amount);
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'WITHDRAWAL_RESERVE',
      posting: postings.withdrawalReserve(input.amount),
      amount: input.amount,
      referenceType: 'WITHDRAWAL',
      referenceId: input.withdrawalId,
      metadata: { withdrawalId: input.withdrawalId },
    });
  }

  async releaseWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult> {
    return this.settleWithdrawal(input, 'WITHDRAWAL_RELEASE', postings.withdrawalRelease);
  }

  async completeWithdrawal(input: WithdrawalLedgerInput): Promise<WalletOpResult> {
    return this.settleWithdrawal(input, 'WITHDRAWAL_PAYOUT', postings.withdrawalPayout);
  }

  private settleWithdrawal(
    input: WithdrawalLedgerInput,
    type: 'WITHDRAWAL_RELEASE' | 'WITHDRAWAL_PAYOUT',
    template: (x: bigint) => LedgerPosting,
  ): Promise<WalletOpResult> {
    this.assertPositive(input.amount);
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type,
      posting: template(input.amount),
      amount: input.amount,
      referenceType: 'WITHDRAWAL',
      referenceId: input.withdrawalId,
      metadata: { withdrawalId: input.withdrawalId },
      precheck: async (tx) => {
        // Debe mover exactamente lo reservado y no liquidarse dos veces.
        const reserve = await tx.ledgerTransaction.findFirst({
          where: {
            operatorId: input.operatorId,
            type: 'WITHDRAWAL_RESERVE',
            referenceType: 'WITHDRAWAL',
            referenceId: input.withdrawalId,
          },
        });
        if (!reserve) throw AppError.notFound('Withdrawal reserve not found');
        const meta = reserve.metadata as { userId?: string; amount?: string } | null;
        if (meta?.userId !== input.userId || meta?.amount !== input.amount.toString() || reserve.currency !== input.currency) {
          throw AppError.conflict('Amount, user or currency differ from the reserved withdrawal');
        }
        const other = await tx.ledgerTransaction.findFirst({
          where: {
            operatorId: input.operatorId,
            referenceType: 'WITHDRAWAL',
            referenceId: input.withdrawalId,
            type: { in: ['WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAYOUT'] },
            NOT: { idempotencyKey: input.idempotencyKey },
          },
        });
        if (other) throw AppError.conflict('Withdrawal already settled');
      },
    });
  }

  // ───────────────────────── Ajustes y demo ─────────────────────────

  async manualAdjustment(input: ManualAdjustmentInput): Promise<WalletOpResult> {
    const reason = (input.reason ?? '').trim();
    if (!reason) throw AppError.validation('Adjustment reason is required');
    if (!input.actorBackofficeUserId) throw AppError.validation('Adjustment actor is required');
    if (typeof input.amount !== 'bigint' || input.amount === 0n) throw AppError.validation('Invalid adjustment amount');
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'MANUAL_ADJUSTMENT',
      posting: postings.manualAdjustment(input.amount),
      amount: input.amount,
      referenceType: 'PLAYER',
      referenceId: input.userId,
      metadata: { reason, actorBackofficeUserId: input.actorBackofficeUserId },
      createdBy: input.actorBackofficeUserId,
      afterPost: async (tx, ledgerTx) => {
        await tx.auditLog.create({
          data: {
            operatorId: input.operatorId,
            actorType: 'BACKOFFICE_USER',
            actorId: input.actorBackofficeUserId,
            action: 'LEDGER_MANUAL_ADJUSTMENT',
            targetType: 'USER',
            targetId: input.userId,
            reason,
            after: {
              ledgerTransactionId: ledgerTx.id,
              amount: input.amount.toString(),
              currency: input.currency,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
      },
    });
  }

  async creditDemo(input: CreditDemoInput): Promise<WalletOpResult> {
    this.assertPositive(input.amount);
    return this.runSingle({
      operatorId: input.operatorId,
      userId: input.userId,
      currency: input.currency,
      key: input.idempotencyKey,
      type: 'DEMO_CREDIT',
      posting: postings.demoCredit(input.amount),
      amount: input.amount,
      referenceType: 'PLAYER',
      referenceId: input.userId,
      metadata: { demo: true },
      precheck: async (_tx, user) => {
        if (!user.isDemo) throw AppError.forbidden('Demo credit is only allowed for demo players');
      },
    });
  }

  // ───────────────────────── Núcleo ─────────────────────────

  private assertPositive(amount: bigint): void {
    if (typeof amount !== 'bigint' || amount <= 0n) throw AppError.validation('Amount must be a positive bigint');
  }

  private assertUserCurrency(user: User, currency: string): void {
    if (user.currency !== currency) throw AppError.validation('Currency does not match the player currency');
  }

  private async loadUser(db: Tx | PrismaClient, operatorId: string, userId: string): Promise<User> {
    if (!UUID_RE.test(userId) || !UUID_RE.test(operatorId)) throw AppError.forbidden('Player does not belong to operator');
    const user = await db.user.findUnique({ where: { id: userId } });
    // Aislamiento estricto: no revelar si el usuario existe en otro operador.
    if (!user || user.operatorId !== operatorId) throw AppError.forbidden('Player does not belong to operator');
    return user;
  }

  private toPlayerAuth(user: User): PlayerAuth {
    return { kind: 'player', userId: user.id, operatorId: user.operatorId, currency: user.currency, isDemo: user.isDemo };
  }

  /** Las repeticiones idempotentes no se vuelven a evaluar contra los límites. */
  private async runPolicyUnlessReplay(operatorId: string, key: string, user: User, amount: bigint): Promise<void> {
    const existing = await this.prisma.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId, idempotencyKey: key } },
      select: { id: true },
    });
    if (existing) return;
    if (user.status !== 'ACTIVE') throw AppError.forbidden('Player is not active');
    await this.rgPolicy.assertCanBet(this.toPlayerAuth(user), amount);
  }

  private meta(userId: string, amount: bigint, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { userId, amount: amount.toString(), ...extra };
  }

  private matches(existing: LedgerTransaction, fp: Fingerprint): boolean {
    const m = existing.metadata as { userId?: string; amount?: string } | null;
    return (
      existing.type === fp.type &&
      existing.currency === fp.currency &&
      m?.userId === fp.userId &&
      m?.amount === fp.amount.toString()
    );
  }

  /** Operación de un solo asiento con idempotencia, bloqueo y reintento ante P2002. */
  private async runSingle(spec: SingleSpec): Promise<WalletOpResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.singleTx(tx, spec), TX_OPTIONS);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        // Otra petición con la misma clave ganó la carrera: reintenta y devolverá la original.
        if (attempt >= 1) throw AppError.conflict('Concurrent ledger conflict');
      }
    }
  }

  private async singleTx(tx: Tx, spec: SingleSpec): Promise<WalletOpResult> {
    const user = await this.loadUser(tx, spec.operatorId, spec.userId);
    this.assertUserCurrency(user, spec.currency);
    if (spec.requireActive && user.status !== 'ACTIVE') throw AppError.forbidden('Player is not active');

    const kinds = [...new Set(spec.posting.map((l) => l.account.type))];
    const { ids, state } = await this.prepareAccounts(tx, spec.operatorId, user.id, spec.currency, kinds);
    const cashId = ids.get('PLAYER_CASH');
    const cashBalance = () => (cashId ? state.get(cashId)!.balance : 0n);

    const existing = await tx.ledgerTransaction.findUnique({
      where: { operatorId_idempotencyKey: { operatorId: spec.operatorId, idempotencyKey: spec.key } },
    });
    if (existing) {
      if (!this.matches(existing, { type: spec.type, userId: user.id, amount: spec.amount, currency: spec.currency })) {
        throw AppError.conflict('Idempotency key reused with a different payload');
      }
      return { ledgerTransactionId: existing.id, balance: cashBalance(), idempotentReplay: true };
    }

    if (spec.precheck) await spec.precheck(tx, user);

    const created = await this.post(
      tx,
      {
        operatorId: spec.operatorId,
        currency: spec.currency,
        type: spec.type,
        key: spec.key,
        entries: this.resolve(spec.posting, ids, state),
        referenceType: spec.referenceType,
        referenceId: spec.referenceId,
        createdBy: spec.createdBy,
        metadata: this.meta(user.id, spec.amount, spec.metadata),
      },
      state,
    );
    if (spec.afterPost) await spec.afterPost(tx, created);
    return { ledgerTransactionId: created.id, balance: cashBalance(), idempotentReplay: false };
  }

  /** Crea (perezosamente) y bloquea, en orden de id, las cuentas necesarias. */
  private async prepareAccounts(
    tx: Tx,
    operatorId: string,
    userId: string,
    currency: string,
    kinds: LedgerAccountKind[],
  ): Promise<{ ids: Map<LedgerAccountKind, string>; state: Map<string, AccountState> }> {
    const ids = new Map<LedgerAccountKind, string>();
    for (const kind of kinds) {
      const player = isPlayerAccount(kind);
      ids.set(kind, await this.ensureAccount(tx, operatorId, player ? userId : null, kind, currency));
    }
    const locked = await this.lock(tx, [...ids.values()]);
    const state = new Map<string, AccountState>();
    for (const [kind, id] of ids) state.set(id, { id, type: kind, balance: locked.get(id)! });
    return { ids, state };
  }

  private async ensureAccount(
    tx: Tx,
    operatorId: string,
    userId: string | null,
    type: LedgerAccountKind,
    currency: string,
  ): Promise<string> {
    const ownerKey = userId ?? OPERATOR_OWNER_KEY;
    const where = { operatorId_ownerKey_type_currency: { operatorId, ownerKey, type, currency } };
    const found = await tx.ledgerAccount.findUnique({ where, select: { id: true } });
    if (found) return found.id;
    const ownerType = userId ? 'PLAYER' : 'OPERATOR';
    await tx.$executeRaw`
      INSERT INTO "LedgerAccount" ("id","operatorId","ownerType","userId","ownerKey","type","currency","balance","updatedAt")
      VALUES (${randomUUID()}::uuid, ${operatorId}::uuid, ${ownerType}::"LedgerOwnerType", ${userId}::uuid,
              ${ownerKey}, ${type}::"LedgerAccountType", ${currency}, 0, now())
      ON CONFLICT ("operatorId","ownerKey","type","currency") DO NOTHING`;
    const row = await tx.ledgerAccount.findUnique({ where, select: { id: true } });
    if (!row) throw new AppError('Could not create ledger account', 500, false, 'APP_ERROR');
    return row.id;
  }

  /** SELECT ... FOR UPDATE ordenado por id (evita deadlocks). Devuelve id → saldo. */
  private async lock(tx: Tx, accountIds: string[]): Promise<Map<string, bigint>> {
    const rows = await tx.$queryRaw<{ id: string; balance: bigint }[]>`
      SELECT "id", "balance" FROM "LedgerAccount"
      WHERE "id" = ANY(${accountIds}::uuid[])
      ORDER BY "id" FOR UPDATE`;
    const map = new Map<string, bigint>();
    for (const r of rows) map.set(r.id, BigInt(r.balance));
    if (map.size !== new Set(accountIds).size) throw AppError.notFound('Ledger account not found');
    return map;
  }

  private resolve(
    posting: LedgerPosting,
    ids: Map<LedgerAccountKind, string>,
    state: Map<string, AccountState>,
  ): ConcreteEntry[] {
    assertBalancedPosting(posting);
    return posting.map((l) => {
      const id = ids.get(l.account.type);
      if (!id || !state.has(id)) throw new AppError('Unresolved ledger account', 500, false, 'APP_ERROR');
      return { accountId: id, amount: l.amount };
    });
  }

  /**
   * Inserta LedgerTransaction + LedgerEntry y actualiza los saldos cacheados en la MISMA
   * transacción SQL. Las cuentas de jugador nunca quedan negativas.
   */
  private async post(
    tx: Tx,
    p: PostParams,
    state: Map<string, AccountState>,
  ): Promise<{ id: string }> {
    assertBalancedPosting(
      p.entries.map((e) => ({ account: { type: this.accountOf(state, e.accountId).type }, amount: e.amount })),
    );
    assertSameCurrency(p.currency, p.entries.map(() => p.currency));

    const delta = new Map<string, bigint>();
    for (const e of p.entries) delta.set(e.accountId, (delta.get(e.accountId) ?? 0n) + e.amount);
    for (const [id, d] of delta) {
      const acc = this.accountOf(state, id);
      if (isPlayerAccount(acc.type) && acc.balance + d < 0n) throw AppError.insufficientFunds();
    }

    const created = await tx.ledgerTransaction.create({
      data: {
        operatorId: p.operatorId,
        type: p.type,
        idempotencyKey: p.key,
        currency: p.currency,
        referenceType: p.referenceType,
        referenceId: p.referenceId,
        reversesId: p.reversesId,
        metadata: p.metadata as Prisma.InputJsonValue,
        createdByBackofficeUserId: p.createdBy,
        entries: {
          create: p.entries.map((e) => ({
            accountId: e.accountId,
            operatorId: p.operatorId,
            amount: e.amount,
            currency: p.currency,
          })),
        },
      },
      select: { id: true },
    });

    for (const [id, d] of delta) {
      await tx.$executeRaw`UPDATE "LedgerAccount" SET "balance" = "balance" + ${d}, "updatedAt" = now() WHERE "id" = ${id}::uuid`;
      const acc = this.accountOf(state, id);
      acc.balance += d;
    }
    return created;
  }

  private accountOf(state: Map<string, AccountState>, id: string): AccountState {
    const acc = state.get(id);
    if (!acc) throw new AppError('Ledger account not locked', 500, false, 'APP_ERROR');
    return acc;
  }
}
