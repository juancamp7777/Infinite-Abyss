/**
 * Adaptadores de billetera de los módulos (Hub, Studios, promociones, gamificación) sobre el ledger
 * de doble partida de la Fase 1 (PrismaWalletService).
 *
 * Garantías (heredadas de PrismaWalletService.postPlayerMovement / postOperatorTransfer):
 *  - Montos bigint en unidades mínimas; cada operación crea UNA LedgerTransaction cuyas entradas suman 0.
 *  - Idempotencia por (operatorId, idempotencyKey): la repetición devuelve el resultado original
 *    (mismo txId); la misma clave con otro payload (tipo, jugador, monto, moneda o huella reason/ref) → IDEMPOTENCY_CONFLICT.
 *  - Aislamiento por operador: un jugador de otro operador → AppError FORBIDDEN (403).
 *  - SELECT ... FOR UPDATE ORDER BY id dentro de $transaction (maxWait/timeout 30 s), reintento único ante P2002.
 *  - Las cuentas de jugador nunca quedan negativas (→ INSUFFICIENT_FUNDS); las de operador sí pueden.
 *  - Cuentas de operador (HOUSE, BONUS_EXPENSE, JACKPOT_POOL, TOURNAMENT_POOL, CASHBACK_EXPENSE) se crean
 *    perezosamente por operador y moneda.
 *
 * Plan de cuentas (débito = cuenta que disminuye/entrega, crédito = cuenta que recibe):
 *
 * | Operación (reason / ref.gameId)               | Sale de (−)                          | Entra en (+)        | LedgerTxType          |
 * |-----------------------------------------------|--------------------------------------|---------------------|-----------------------|
 * | debit BET                                     | PLAYER_CASH, luego PLAYER_BONUS      | HOUSE               | BET                   |
 * | credit WIN                                    | HOUSE                                | PLAYER_CASH         | WIN                   |
 * | credit REFUND (con BET previa mismo round)    | HOUSE                                | cuentas de la BET   | REFUND                |
 * | credit REFUND (sin BET previa)                | HOUSE                                | PLAYER_CASH         | REFUND                |
 * | rollback(originalKey)                         | inverso exacto de la tx original     |                     | ROLLBACK              |
 * | credit BONUS_GRANT gameId 'bonus-grant'       | BONUS_EXPENSE                        | PLAYER_BONUS        | BONUS_GRANT           |
 * | credit BONUS_GRANT (sin gameId especial)      | BONUS_EXPENSE                        | PLAYER_BONUS        | BONUS_GRANT           |
 * | credit BONUS_GRANT gameId 'bonus-convert'     | PLAYER_BONUS                         | PLAYER_CASH         | BONUS_CONVERT         |
 * | debit OTHER gameId 'bonus-forfeit'            | PLAYER_BONUS                         | BONUS_EXPENSE       | BONUS_FORFEIT         |
 * | credit CASHBACK (incl. gameId 'cashback-cash')| CASHBACK_EXPENSE                     | PLAYER_CASH         | CASHBACK              |
 * | credit JACKPOT                                | JACKPOT_POOL                         | PLAYER_CASH         | JACKPOT_PAYOUT        |
 * | jackpotLedger.recordContribution / recordSeed | HOUSE                                | JACKPOT_POOL        | JACKPOT_CONTRIBUTION  |
 * | debit TOURNAMENT_BUYIN                        | PLAYER_CASH, luego PLAYER_BONUS      | TOURNAMENT_POOL     | TOURNAMENT_BUYIN      |
 * | credit TOURNAMENT_PRIZE                       | TOURNAMENT_POOL (hasta su saldo) y el faltante de BONUS_EXPENSE | PLAYER_CASH | TOURNAMENT_PRIZE |
 * | debit OTHER sin gameId especial               | — rechazado (AppError VALIDATION_ERROR) —                                      |
 *
 * BonusFundsPort (services['wallet.bonusFunds']) usa exactamente las mismas cuentas y claves
 * (`promo:bonus:<bonusId>:<op>`) que las convenciones de ref.gameId, así ambos caminos son intercambiables.
 * JackpotLedgerPort (services['wallet.jackpotLedger']) refleja contribuciones y semillas en JACKPOT_POOL.
 */
import type { PrismaClient } from '@prisma/client';
import type { LedgerAccountKind, LedgerPosting, PostingLine } from '../../../domain/ledger/LedgerPosting';
import { postings } from '../../../domain/ledger/LedgerPosting';
import type { LockedBalances, ModuleLedgerTxType } from '../../../domain/contracts/IWalletService';
import { AppError } from '../../../domain/errors/AppError';
import type { PrismaWalletService } from '../../ledger/PrismaWalletService';
import type { ModuleLogger } from '../../../modules/shared/module';
import {
  WalletError,
  type CreditRequest,
  type DebitRequest,
  type RollbackRequest,
  type WalletBalance,
  type WalletPort,
  type WalletRef,
  type WalletResult,
} from '../../../modules/shared/ports/WalletPort';
import { bonusKey, type BonusFundsPort } from '../../../modules/promotions/application/BonusFunds';
import type { PlayerBonus } from '../../../modules/promotions/domain/bonus';
import { PROMO_PROVIDER } from '../../../modules/promotions/domain/common';
import type { JackpotLedgerPort } from '../../../modules/promotions/application/JackpotLedger';

export interface ModuleWalletAdapterDeps {
  prisma: PrismaClient;
  wallet: PrismaWalletService;
  logger?: ModuleLogger;
}

export interface ModuleWalletAdapters {
  wallet: WalletPort;
  bonusFunds: BonusFundsPort;
  jackpotLedger: JackpotLedgerPort;
}

/** Asiento lógico de un movimiento de módulo. */
interface MovementPlan {
  type: ModuleLedgerTxType;
  accounts: LedgerAccountKind[];
  posting: (b: LockedBalances) => LedgerPosting;
  referenceType: string;
  metadata?: Record<string, unknown>;
}

const debitPlayerFirstCash = (to: LedgerAccountKind) => (amount: bigint) => (b: LockedBalances): LedgerPosting => {
  if (b.cash + b.bonus < amount) throw AppError.insufficientFunds();
  const fromCash = b.cash >= amount ? amount : b.cash;
  return postings.split(
    [
      { from: 'PLAYER_CASH', amount: fromCash },
      { from: 'PLAYER_BONUS', amount: amount - fromCash },
    ],
    to,
  );
};

/** Plan para un débito del WalletPort. */
function planDebit(req: DebitRequest): MovementPlan {
  switch (req.reason) {
    case 'BET':
      return { type: 'BET', accounts: ['HOUSE'], posting: debitPlayerFirstCash('HOUSE')(req.amount), referenceType: 'GAME' };
    case 'TOURNAMENT_BUYIN':
      return {
        type: 'TOURNAMENT_BUYIN',
        accounts: ['TOURNAMENT_POOL'],
        posting: debitPlayerFirstCash('TOURNAMENT_POOL')(req.amount),
        referenceType: 'TOURNAMENT',
      };
    case 'OTHER':
      if (req.ref.gameId === 'bonus-forfeit') return bonusPlans.forfeit(req.amount);
      throw AppError.validation("Debit reason OTHER requires a supported ref.gameId ('bonus-forfeit')");
    default:
      throw AppError.validation(`Unsupported debit reason ${String((req as { reason: unknown }).reason)}`);
  }
}

const bonusPlans = {
  grant: (amount: bigint): MovementPlan => ({
    type: 'BONUS_GRANT',
    accounts: ['BONUS_EXPENSE'],
    posting: () => postings.transfer('BONUS_EXPENSE', 'PLAYER_BONUS', amount),
    referenceType: 'BONUS',
  }),
  convert: (amount: bigint): MovementPlan => ({
    type: 'BONUS_CONVERT',
    accounts: [],
    posting: () => postings.transfer('PLAYER_BONUS', 'PLAYER_CASH', amount),
    referenceType: 'BONUS',
  }),
  forfeit: (amount: bigint): MovementPlan => ({
    type: 'BONUS_FORFEIT',
    accounts: ['BONUS_EXPENSE'],
    posting: () => postings.transfer('PLAYER_BONUS', 'BONUS_EXPENSE', amount),
    referenceType: 'BONUS',
  }),
  cashback: (amount: bigint): MovementPlan => ({
    type: 'CASHBACK',
    accounts: ['CASHBACK_EXPENSE'],
    posting: () => postings.transfer('CASHBACK_EXPENSE', 'PLAYER_CASH', amount),
    referenceType: 'BONUS',
  }),
};

/** Plan para un crédito del WalletPort. `refundOf` = reparto cash/bono de la apuesta original (si existe). */
function planCredit(req: CreditRequest, refundOf?: { cash: bigint; bonus: bigint; betTxId: string }): MovementPlan {
  const amount = req.amount;
  switch (req.reason) {
    case 'WIN':
      return { type: 'WIN', accounts: ['HOUSE'], posting: () => postings.transfer('HOUSE', 'PLAYER_CASH', amount), referenceType: 'GAME' };
    case 'REFUND': {
      if (refundOf) {
        return {
          type: 'REFUND',
          accounts: ['HOUSE'],
          posting: () => {
            const lines: PostingLine[] = [{ account: { type: 'HOUSE' }, amount: -amount }];
            if (refundOf.cash > 0n) lines.push({ account: { type: 'PLAYER_CASH' }, amount: refundOf.cash });
            if (refundOf.bonus > 0n) lines.push({ account: { type: 'PLAYER_BONUS' }, amount: refundOf.bonus });
            return lines;
          },
          referenceType: 'GAME',
          metadata: { refundOfTxId: refundOf.betTxId },
        };
      }
      return { type: 'REFUND', accounts: ['HOUSE'], posting: () => postings.transfer('HOUSE', 'PLAYER_CASH', amount), referenceType: 'GAME' };
    }
    case 'BONUS_GRANT':
      if (req.ref.gameId === 'bonus-convert') return bonusPlans.convert(amount);
      return bonusPlans.grant(amount);
    case 'CASHBACK':
      return bonusPlans.cashback(amount);
    case 'JACKPOT':
      return {
        type: 'JACKPOT_PAYOUT',
        accounts: ['JACKPOT_POOL'],
        posting: () => postings.transfer('JACKPOT_POOL', 'PLAYER_CASH', amount),
        referenceType: 'JACKPOT',
      };
    case 'TOURNAMENT_PRIZE':
      return {
        type: 'TOURNAMENT_PRIZE',
        accounts: ['TOURNAMENT_POOL', 'BONUS_EXPENSE'],
        posting: (b) => {
          const pool = b.of('TOURNAMENT_POOL');
          const fromPool = pool <= 0n ? 0n : pool >= amount ? amount : pool;
          return postings.split(
            [
              { from: 'TOURNAMENT_POOL', amount: fromPool },
              { from: 'BONUS_EXPENSE', amount: amount - fromPool },
            ],
            'PLAYER_CASH',
          );
        },
        referenceType: 'TOURNAMENT',
      };
    default:
      throw AppError.validation(`Unsupported credit reason ${String((req as { reason: unknown }).reason)}`);
  }
}

/** Traduce los errores de la Fase 1 a los WalletError que esperan los módulos; el resto pasa tal cual. */
function mapError(e: unknown): unknown {
  if (!(e instanceof AppError)) return e;
  if (e.code === 'INSUFFICIENT_FUNDS') return new WalletError('INSUFFICIENT_FUNDS', 'Saldo insuficiente');
  if (e.code === 'CONFLICT') {
    if (/already reversed/i.test(e.message)) return new WalletError('ALREADY_ROLLED_BACK', e.message);
    if (/different payload|reused/i.test(e.message)) return new WalletError('IDEMPOTENCY_CONFLICT', e.message);
  }
  if (e.code === 'VALIDATION_ERROR' && /positive bigint/i.test(e.message)) return new WalletError('INVALID_AMOUNT', e.message);
  return e;
}

const fingerprint = (reason: string, ref: WalletRef): string =>
  [reason, ref.provider ?? '', ref.gameId ?? '', ref.roundId ?? ''].join('|');

export function createModuleWalletAdapters(deps: ModuleWalletAdapterDeps): ModuleWalletAdapters {
  const { prisma, wallet } = deps;

  const run = async (
    req: { operatorId: string; playerId: string; currency: string; amount: bigint; idempotencyKey: string; ref: WalletRef },
    reason: string,
    plan: MovementPlan,
    enforceBetPolicy = false,
  ): Promise<WalletResult> => {
    if (typeof req.amount !== 'bigint' || req.amount <= 0n) throw new WalletError('INVALID_AMOUNT');
    try {
      const r = await wallet.postPlayerMovement({
        operatorId: req.operatorId,
        userId: req.playerId,
        currency: req.currency,
        idempotencyKey: req.idempotencyKey,
        type: plan.type,
        amount: req.amount,
        accounts: plan.accounts,
        posting: plan.posting,
        fingerprint: fingerprint(reason, req.ref),
        referenceType: plan.referenceType,
        referenceId: req.ref.roundId,
        metadata: { reason, provider: req.ref.provider ?? null, gameId: req.ref.gameId ?? null, roundId: req.ref.roundId ?? null, ...(plan.metadata ?? {}) },
        enforceBetPolicy,
      });
      return { balance: r.cash + r.bonus, txId: r.ledgerTransactionId };
    } catch (e) {
      throw mapError(e);
    }
  };

  /** Reparto de la apuesta original de la misma ronda (para REFUND), si existe y no fue revertida. */
  const findBetSplit = async (req: CreditRequest): Promise<{ cash: bigint; bonus: bigint; betTxId: string } | undefined> => {
    if (!req.ref.roundId) return undefined;
    const bet = await prisma.ledgerTransaction.findFirst({
      where: {
        operatorId: req.operatorId,
        type: 'BET',
        referenceId: req.ref.roundId,
        AND: [
          { metadata: { path: ['userId'], equals: req.playerId } },
          { metadata: { path: ['amount'], equals: req.amount.toString() } },
          ...(req.ref.gameId ? [{ metadata: { path: ['gameId'], equals: req.ref.gameId } }] : []),
        ],
      },
      include: { entries: { include: { account: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!bet) return undefined;
    const reversed = await prisma.ledgerTransaction.findUnique({ where: { reversesId: bet.id }, select: { id: true } });
    if (reversed) return undefined;
    let cash = 0n;
    let bonus = 0n;
    for (const en of bet.entries) {
      if (en.account.type === 'PLAYER_CASH') cash -= en.amount;
      if (en.account.type === 'PLAYER_BONUS') bonus -= en.amount;
    }
    if (cash < 0n || bonus < 0n || cash + bonus !== req.amount) return undefined;
    return { cash, bonus, betTxId: bet.id };
  };

  const balanceOf = async (operatorId: string, playerId: string): Promise<WalletBalance> => {
    const b = await wallet.getBalances({ operatorId, userId: playerId });
    return { cash: b.cash, bonus: b.bonus };
  };

  const walletPort: WalletPort = {
    async getBalance(operatorId, playerId, currency) {
      const b = await wallet.getBalances({ operatorId, userId: playerId });
      // Las cuentas del jugador solo existen en su moneda.
      if (b.currency !== currency) return { cash: 0n, bonus: 0n };
      return { cash: b.cash, bonus: b.bonus };
    },

    async debit(req) {
      if (typeof req.amount !== 'bigint' || req.amount <= 0n) throw new WalletError('INVALID_AMOUNT');
      return run(req, req.reason, planDebit(req), req.reason === 'BET');
    },

    async credit(req) {
      if (typeof req.amount !== 'bigint' || req.amount <= 0n) throw new WalletError('INVALID_AMOUNT');
      const refundOf = req.reason === 'REFUND' ? await findBetSplit(req) : undefined;
      return run(req, req.reason, planCredit(req, refundOf));
    },

    async rollback(req: RollbackRequest) {
      // Valida el jugador (FORBIDDEN si es de otro operador) y que la tx original sea suya.
      await wallet.getBalances({ operatorId: req.operatorId, userId: req.playerId });
      const original = await prisma.ledgerTransaction.findUnique({
        where: { operatorId_idempotencyKey: { operatorId: req.operatorId, idempotencyKey: req.originalIdempotencyKey } },
        select: { metadata: true, type: true },
      });
      const owner = (original?.metadata as { userId?: string } | null)?.userId;
      if (!original || owner !== req.playerId || original.type === 'ROLLBACK') throw new WalletError('UNKNOWN_TRANSACTION');
      try {
        const r = await wallet.rollback({
          operatorId: req.operatorId,
          originalIdempotencyKey: req.originalIdempotencyKey,
          idempotencyKey: req.idempotencyKey,
          reason: 'module rollback',
        });
        const b = await balanceOf(req.operatorId, req.playerId);
        return { balance: b.cash + b.bonus, txId: r.ledgerTransactionId };
      } catch (e) {
        if (e instanceof AppError && e.code === 'NOT_FOUND') throw new WalletError('UNKNOWN_TRANSACTION');
        throw mapError(e);
      }
    },
  };

  const bonusReq = (b: PlayerBonus, amount: bigint, op: 'grant' | 'convert' | 'forfeit', gameId: string) => ({
    operatorId: b.operatorId,
    playerId: b.playerId,
    currency: b.currency,
    amount,
    idempotencyKey: bonusKey(b.id, op),
    ref: { provider: PROMO_PROVIDER, gameId, roundId: b.id },
  });

  // Mismas huellas (reason + ref) que WalletBonusFunds: ambos caminos son intercambiables y re-ejecutables.
  const bonusFunds: BonusFundsPort = {
    async bonusBalance(operatorId, playerId, currency) {
      return (await walletPort.getBalance(operatorId, playerId, currency)).bonus;
    },
    async grant(b, amount) {
      const r = await run(bonusReq(b, amount, 'grant', 'bonus-grant'), 'BONUS_GRANT', bonusPlans.grant(amount));
      return { txId: r.txId };
    },
    async grantCash(b, amount) {
      const r = await run(bonusReq(b, amount, 'grant', 'cashback-cash'), 'CASHBACK', bonusPlans.cashback(amount));
      return { txId: r.txId };
    },
    async convert(b, amount) {
      const r = await run(bonusReq(b, amount, 'convert', 'bonus-convert'), 'BONUS_GRANT', bonusPlans.convert(amount));
      return { txId: r.txId };
    },
    async forfeit(b, amount) {
      const r = await run(bonusReq(b, amount, 'forfeit', 'bonus-forfeit'), 'OTHER', bonusPlans.forfeit(amount));
      return { txId: r.txId };
    },
  };

  const jackpotLedger: JackpotLedgerPort = {
    async recordContribution(input) {
      if (input.amount <= 0n) return;
      await wallet.postOperatorTransfer({
        operatorId: input.operatorId,
        currency: input.currency,
        idempotencyKey: input.key,
        type: 'JACKPOT_CONTRIBUTION',
        amount: input.amount,
        posting: postings.transfer('HOUSE', 'JACKPOT_POOL', input.amount),
        fingerprint: `contribution|${input.jackpotId}|${input.roundId}`,
        referenceType: 'JACKPOT',
        referenceId: input.jackpotId,
        metadata: { kind: 'CONTRIBUTION', roundId: input.roundId, gameId: input.gameId, playerId: input.playerId },
      });
    },
    async recordSeed(input) {
      if (input.amount <= 0n) return;
      await wallet.postOperatorTransfer({
        operatorId: input.operatorId,
        currency: input.currency,
        idempotencyKey: input.key,
        type: 'JACKPOT_CONTRIBUTION',
        amount: input.amount,
        posting: postings.transfer('HOUSE', 'JACKPOT_POOL', input.amount),
        fingerprint: `seed|${input.jackpotId}|${input.levelKey}|${input.reason}`,
        referenceType: 'JACKPOT',
        referenceId: input.jackpotId,
        metadata: { kind: 'SEED', levelKey: input.levelKey, seedReason: input.reason },
      });
    },
  };

  deps.logger?.debug?.('module wallet adapters ready (Prisma ledger)');
  return { wallet: walletPort, bonusFunds, jackpotLedger };
}
