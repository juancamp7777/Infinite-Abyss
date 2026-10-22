import type { EventBus } from '../../shared/events/EventBus';
import type { ModuleLogger } from '../../shared/module';
import type { BetGuardPort } from '../../shared/ports/BetGuardPort';
import { isWalletError, WalletPort } from '../../shared/ports/WalletPort';
import { randomUUID } from 'crypto';
import { hubError } from '../domain/errors';
import type { ProviderAdapter } from '../domain/ProviderAdapter';
import { DuplicateTransactionError, WalletTxRepository } from '../domain/repositories';
import type { Game, HubRound, HubSession, HubTransaction, HubTxType } from '../domain/types';
import type { BalanceRequest, BetRequest, RollbackRequest, WalletOkResponse, WinRequest } from '../domain/walletProtocol';
import type { CatalogService } from './CatalogService';
import type { SessionService } from './SessionService';

/** Serializa operaciones por clave dentro del proceso (entre instancias protege la unicidad en BD + idempotencia de la billetera). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Clave de idempotencia en la billetera para una transacción de proveedor. */
export const walletKey = (providerId: string, providerTxId: string): string => `hub:${providerId}:${providerTxId}`;

/**
 * API seamless wallet entrante (proveedor externo → Infinite Abyss).
 * Reglas:
 * - Idempotencia por (providerId, transactionId): el reintento con el mismo payload devuelve la misma respuesta;
 *   con otro payload → DUPLICATE.
 * - Rollback de una transacción desconocida: se registra un TOMBSTONE con su transactionId y se responde OK
 *   sin mover dinero; si después llega esa apuesta se rechaza con BET_ROLLED_BACK.
 * - Win sin apuesta previa en la ronda → ROUND_NOT_FOUND salvo que el adaptador lo permita (giros gratis).
 * - bet exige sesión vigente; win/rollback/balance aceptan sesiones expiradas (liquidación tardía).
 */
export class SeamlessWalletService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly txs: WalletTxRepository,
    private readonly sessions: SessionService,
    private readonly catalog: CatalogService,
    private readonly bus: EventBus,
    private readonly logger: ModuleLogger,
    private readonly betGuard?: BetGuardPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async balance(adapter: ProviderAdapter, req: BalanceRequest): Promise<WalletOkResponse> {
    const session = await this.loadSession(adapter.id, req.sessionToken, true, req.playerId);
    if (req.currency && req.currency !== session.currency) throw hubError('CURRENCY_MISMATCH', 'Moneda distinta a la de la sesión');
    const wallet = await this.sessions.walletFor(session);
    return this.okResponse(wallet, session);
  }

  async bet(adapter: ProviderAdapter, req: BetRequest): Promise<WalletOkResponse> {
    const providerId = adapter.id;
    const session = await this.loadSession(providerId, req.sessionToken, false);
    return this.mutex.run(lockKey(session), async () => {
      const fp = fingerprint('BET', session.playerId, req.roundId, req.amount, req.gameId);
      const replay = await this.replay(providerId, req.transactionId, 'BET', fp);
      if (replay) return replay;
      if (req.currency && req.currency !== session.currency) throw hubError('CURRENCY_MISMATCH', 'Moneda distinta a la de la sesión');

      const game = await this.resolveGame(providerId, session, req.gameId);
      const round = await this.txs.findRound(providerId, req.roundId);
      if (round && round.playerId !== session.playerId) throw hubError('SESSION_MISMATCH', 'La ronda pertenece a otro jugador');
      if (round && round.status !== 'open') throw hubError('ROUND_CLOSED', 'La ronda ya está cerrada');

      if (this.betGuard) {
        const check = await this.betGuard.checkBet({
          operatorId: session.operatorId,
          playerId: session.playerId,
          gameId: game.id,
          category: game.category,
          amount: req.amount,
          currency: session.currency,
        });
        if (!check.allowed) throw hubError('BET_REJECTED', check.reason ?? 'Apuesta rechazada por límites del jugador');
      }

      const wallet = await this.sessions.walletFor(session);
      const roundId = round?.id ?? randomUUID();
      const res = await this.walletCall(() =>
        wallet.debit({
          operatorId: session.operatorId,
          playerId: session.playerId,
          currency: session.currency,
          amount: req.amount,
          idempotencyKey: walletKey(providerId, req.transactionId),
          reason: 'BET',
          ref: { provider: providerId, gameId: game.id, roundId: req.roundId },
        }),
      );

      const txId = randomUUID();
      const response = await this.okResponse(wallet, session, txId, req.transactionId);
      const saved = await this.persistTx({
        id: txId,
        providerId,
        providerTxId: req.transactionId,
        type: 'BET',
        status: 'ok',
        operatorId: session.operatorId,
        playerId: session.playerId,
        currency: session.currency,
        amount: req.amount,
        providerRoundId: req.roundId,
        gameId: game.id,
        sessionId: session.id,
        walletTxId: res.txId,
        fingerprint: fp,
        response: serialize(response),
        createdAt: this.now(),
      });
      if (saved !== 'inserted') return saved;

      await this.txs.saveRound(
        round
          ? { ...round, betAmount: round.betAmount + req.amount }
          : {
              id: roundId,
              providerId,
              providerRoundId: req.roundId,
              operatorId: session.operatorId,
              playerId: session.playerId,
              gameId: game.id,
              currency: session.currency,
              sessionId: session.id,
              betAmount: req.amount,
              winAmount: 0n,
              status: 'open',
              createdAt: this.now(),
            },
      );
      await this.sessions.touch(session);
      await this.publish(() =>
        this.bus.publish('bet.placed', {
          operatorId: session.operatorId,
          playerId: session.playerId,
          at: this.now().toISOString(),
          amount: req.amount,
          currency: session.currency,
          gameId: game.id,
          provider: providerId,
          category: game.category,
          roundId: req.roundId,
        }),
      );
      return response;
    });
  }

  async win(adapter: ProviderAdapter, req: WinRequest): Promise<WalletOkResponse> {
    const providerId = adapter.id;
    const session = await this.loadSession(providerId, req.sessionToken, true);
    return this.mutex.run(lockKey(session), async () => {
      const fp = fingerprint('WIN', session.playerId, req.roundId, req.amount, req.gameId, req.roundClosed, req.bonus?.id);
      const replay = await this.replay(providerId, req.transactionId, 'WIN', fp);
      if (replay) return replay;
      if (req.currency && req.currency !== session.currency) throw hubError('CURRENCY_MISMATCH', 'Moneda distinta a la de la sesión');

      const game = await this.resolveGame(providerId, session, req.gameId);
      let round = await this.txs.findRound(providerId, req.roundId);
      if (!round) {
        if (!adapter.allowsWinWithoutBet(req)) throw hubError('ROUND_NOT_FOUND', 'Win sin apuesta previa en la ronda');
        round = {
          id: randomUUID(),
          providerId,
          providerRoundId: req.roundId,
          operatorId: session.operatorId,
          playerId: session.playerId,
          gameId: game.id,
          currency: session.currency,
          sessionId: session.id,
          betAmount: 0n,
          winAmount: 0n,
          status: 'open',
          createdAt: this.now(),
        };
      }
      if (round.playerId !== session.playerId) throw hubError('SESSION_MISMATCH', 'La ronda pertenece a otro jugador');
      if (round.status !== 'open') throw hubError('ROUND_CLOSED', 'La ronda ya está cerrada');

      const wallet = await this.sessions.walletFor(session);
      let walletTxId: string | undefined;
      if (req.amount > 0n) {
        const res = await this.walletCall(() =>
          wallet.credit({
            operatorId: session.operatorId,
            playerId: session.playerId,
            currency: session.currency,
            amount: req.amount,
            idempotencyKey: walletKey(providerId, req.transactionId),
            reason: 'WIN',
            ref: { provider: providerId, gameId: round!.gameId, roundId: req.roundId },
          }),
        );
        walletTxId = res.txId;
      }

      const txId = randomUUID();
      const response = await this.okResponse(wallet, session, txId, req.transactionId);
      const saved = await this.persistTx({
        id: txId,
        providerId,
        providerTxId: req.transactionId,
        type: 'WIN',
        status: 'ok',
        operatorId: session.operatorId,
        playerId: session.playerId,
        currency: session.currency,
        amount: req.amount,
        providerRoundId: req.roundId,
        gameId: round.gameId,
        sessionId: session.id,
        walletTxId,
        fingerprint: fp,
        response: serialize(response),
        createdAt: this.now(),
      });
      if (saved !== 'inserted') return saved;

      const updated: HubRound = {
        ...round,
        winAmount: round.winAmount + req.amount,
        ...(req.roundClosed ? { status: 'settled' as const, settledAt: this.now() } : {}),
      };
      await this.txs.saveRound(updated);
      if (req.roundClosed) await this.publishSettled(updated, game, providerId);
      return response;
    });
  }

  async rollback(adapter: ProviderAdapter, req: RollbackRequest): Promise<WalletOkResponse> {
    const providerId = adapter.id;
    const session = await this.loadSession(providerId, req.sessionToken, true);
    return this.mutex.run(lockKey(session), async () => {
      const fp = fingerprint('ROLLBACK', session.playerId, req.referenceTransactionId);
      const replay = await this.replay(providerId, req.transactionId, 'ROLLBACK', fp);
      if (replay) return replay;
      const wallet = await this.sessions.walletFor(session);

      let ref = await this.txs.findTx(providerId, req.referenceTransactionId);
      if (!ref) {
        // Rollback de algo que nunca recibimos: tombstone para rechazar la apuesta si llega tarde.
        try {
          await this.txs.insertTx({
            id: randomUUID(),
            providerId,
            providerTxId: req.referenceTransactionId,
            type: 'TOMBSTONE',
            status: 'tombstone',
            operatorId: session.operatorId,
            playerId: session.playerId,
            currency: session.currency,
            amount: 0n,
            providerRoundId: req.roundId,
            sessionId: session.id,
            referenceTxId: req.transactionId,
            fingerprint: 'TOMBSTONE',
            createdAt: this.now(),
          });
        } catch (e) {
          if (!(e instanceof DuplicateTransactionError)) throw e;
          ref = await this.txs.findTx(providerId, req.referenceTransactionId);
        }
        if (!ref) return this.storeRollback(providerId, session, wallet, req, fp, 0n);
      }

      if (ref.type === 'ROLLBACK') throw hubError('DUPLICATE', 'No se puede anular un rollback');
      if (ref.playerId !== session.playerId) throw hubError('SESSION_MISMATCH', 'La transacción pertenece a otro jugador');
      // Tombstone previo o ya anulada por otro rollback: OK sin mover dinero.
      if (ref.type === 'TOMBSTONE' || ref.status !== 'ok') return this.storeRollback(providerId, session, wallet, req, fp, 0n);

      if (ref.amount > 0n) {
        try {
          await wallet.rollback({
            operatorId: session.operatorId,
            playerId: session.playerId,
            originalIdempotencyKey: walletKey(providerId, ref.providerTxId),
            idempotencyKey: walletKey(providerId, req.transactionId),
          });
        } catch (e) {
          if (!isWalletError(e, 'ALREADY_ROLLED_BACK')) await this.walletCall(() => Promise.reject(e));
        }
      }
      await this.txs.updateTx(ref.id, { status: 'rolled_back' });

      const round = ref.providerRoundId ? await this.txs.findRound(providerId, ref.providerRoundId) : null;
      if (round) {
        const betAmount = ref.type === 'BET' ? round.betAmount - ref.amount : round.betAmount;
        const winAmount = ref.type === 'WIN' ? round.winAmount - ref.amount : round.winAmount;
        const status = ref.type === 'BET' && betAmount <= 0n && winAmount <= 0n ? 'rolled_back' : round.status;
        await this.txs.saveRound({ ...round, betAmount, winAmount, status });
      }
      return this.storeRollback(providerId, session, wallet, req, fp, ref.amount);
    });
  }

  // ---------- Internos ----------

  private async storeRollback(
    providerId: string,
    session: HubSession,
    wallet: WalletPort,
    req: RollbackRequest,
    fp: string,
    amount: bigint,
  ): Promise<WalletOkResponse> {
    const txId = randomUUID();
    const response = await this.okResponse(wallet, session, txId, req.transactionId);
    const saved = await this.persistTx({
      id: txId,
      providerId,
      providerTxId: req.transactionId,
      type: 'ROLLBACK',
      status: 'ok',
      operatorId: session.operatorId,
      playerId: session.playerId,
      currency: session.currency,
      amount,
      providerRoundId: req.roundId,
      sessionId: session.id,
      referenceTxId: req.referenceTransactionId,
      fingerprint: fp,
      response: serialize(response),
      createdAt: this.now(),
    });
    return saved === 'inserted' ? response : saved;
  }

  private async loadSession(providerId: string, token: string, allowExpired: boolean, playerId?: string): Promise<HubSession> {
    const s = await this.sessions.findSession(token, { allowExpired });
    if (s.providerId !== providerId) throw hubError('SESSION_MISMATCH', 'La sesión pertenece a otro proveedor');
    if (playerId && playerId !== s.playerId) throw hubError('SESSION_MISMATCH', 'El jugador no coincide con la sesión');
    if (s.mode !== 'real') throw hubError('UNKNOWN_SESSION', 'Las sesiones demo no usan la billetera');
    return s;
  }

  /** Respuesta previa si el transactionId ya se procesó (idempotencia), o null si es nuevo. */
  private async replay(providerId: string, providerTxId: string, type: HubTxType, fp: string): Promise<WalletOkResponse | null> {
    const existing = await this.txs.findTx(providerId, providerTxId);
    if (!existing) return null;
    return this.replayOf(existing, type, fp);
  }

  private replayOf(existing: HubTransaction, type: HubTxType, fp: string): WalletOkResponse {
    if (existing.type === 'TOMBSTONE') {
      throw hubError('BET_ROLLED_BACK', 'La transacción ya fue anulada por un rollback previo');
    }
    if (existing.type !== type || existing.fingerprint !== fp || !existing.response) {
      throw hubError('DUPLICATE', 'transactionId ya usado con otro contenido');
    }
    return deserialize(existing.response);
  }

  /** Inserta la transacción; si otra instancia ganó la carrera, devuelve la respuesta registrada. */
  private async persistTx(tx: HubTransaction): Promise<'inserted' | WalletOkResponse> {
    try {
      await this.txs.insertTx(tx);
      return 'inserted';
    } catch (e) {
      if (!(e instanceof DuplicateTransactionError)) throw e;
      const existing = await this.txs.findTx(tx.providerId, tx.providerTxId);
      if (!existing) throw e;
      return this.replayOf(existing, tx.type, tx.fingerprint);
    }
  }

  private async resolveGame(providerId: string, session: HubSession, gameRef?: string): Promise<Game> {
    if (gameRef) {
      const g = await this.catalog.findProviderGame(providerId, gameRef);
      if (g) return g;
    }
    const g = await this.catalog.findGame(session.gameId);
    if (!g) throw hubError('GAME_NOT_FOUND', 'Juego de la sesión no encontrado');
    return g;
  }

  private async okResponse(wallet: WalletPort, s: HubSession, txId?: string, providerTxId?: string): Promise<WalletOkResponse> {
    const b = await wallet.getBalance(s.operatorId, s.playerId, s.currency);
    return {
      status: 'OK',
      currency: s.currency,
      balance: b.cash + b.bonus,
      cash: b.cash,
      bonus: b.bonus,
      ...(txId ? { transactionId: txId } : {}),
      ...(providerTxId ? { providerTransactionId: providerTxId } : {}),
    };
  }

  /** Traduce errores de la billetera a códigos estables del Hub. */
  private async walletCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isWalletError(e, 'INSUFFICIENT_FUNDS')) throw hubError('INSUFFICIENT_FUNDS', 'Saldo insuficiente');
      if (isWalletError(e, 'IDEMPOTENCY_CONFLICT')) throw hubError('DUPLICATE', 'transactionId ya usado con otro contenido');
      throw e;
    }
  }

  private async publishSettled(round: HubRound, game: Game, providerId: string): Promise<void> {
    const multiplier = round.betAmount > 0n ? Number((round.winAmount * 10000n) / round.betAmount) / 10000 : 0;
    await this.publish(() =>
      this.bus.publish('bet.settled', {
        operatorId: round.operatorId,
        playerId: round.playerId,
        at: this.now().toISOString(),
        amount: round.betAmount,
        win: round.winAmount,
        currency: round.currency,
        gameId: round.gameId,
        provider: providerId,
        category: game.category,
        roundId: round.providerRoundId,
        multiplier,
      }),
    );
  }

  private async publish(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.logger.error('hub: fallo al publicar evento', { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const lockKey = (s: HubSession) => `${s.operatorId}\u0000${s.playerId}`;

function fingerprint(...parts: unknown[]): string {
  return JSON.stringify(parts.map((p) => (typeof p === 'bigint' ? p.toString() : p ?? null)));
}

function serialize(r: WalletOkResponse): Record<string, unknown> {
  return { ...r, balance: r.balance.toString(), cash: r.cash.toString(), bonus: r.bonus.toString() };
}

function deserialize(r: Record<string, unknown>): WalletOkResponse {
  return {
    ...(r as unknown as WalletOkResponse),
    balance: BigInt(r.balance as string),
    cash: BigInt(r.cash as string),
    bonus: BigInt(r.bonus as string),
  };
}
