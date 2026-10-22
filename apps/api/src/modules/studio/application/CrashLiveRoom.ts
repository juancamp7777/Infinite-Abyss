import { randomUUID } from 'crypto';
import type { EventBus } from '../../shared/events/EventBus';
import { conflict, HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import { applyMultiplier } from '../../shared/money';
import { createFairRng, createSeedPair } from '../domain/fairness/ProvablyFair';
import { crashMultiplierAt, crashPointFromRng, parseCashout } from '../domain/originals/crash';
import { GameParamError } from '../domain/originals';
import type { RoundRepository, StudioRound } from '../domain/rounds/types';
import { betKey, STUDIO_PROVIDER, winKey, type Actor } from './StudioPlayService';

/**
 * Crash en vivo compartido (una sala por operador). Cada ronda usa su propio serverSeed, cuyo hash se publica
 * al abrir las apuestas; clientSeed público `nymfo-crash-live:<operatorId>` y nonce = número de ronda.
 * Al estallar se revela el serverSeed: el punto se verifica con POST /fairness/verify (gameId nymfo-crash).
 * Cada apuesta es una StudioRound propia (id uuid → claves studio:<roundId>:bet|win).
 */
export type CrashPhase = 'waiting' | 'running' | 'crashed';

interface LiveBet {
  actor: Actor;
  roundId: string;
  amount: bigint;
  currency: string;
  autoCashout: number | null;
  cashout: number | null;
  settled: boolean;
}

export interface CrashLiveDeps {
  operatorId: string;
  rounds: RoundRepository;
  bus: EventBus;
  logger: ModuleLogger;
  /** RTP efectivo del operador para nymfo-crash (fracción). */
  rtp: () => Promise<number>;
  emit: (event: string, payload: unknown) => void;
  waitMs?: number;
  pauseMs?: number;
  now?: () => number;
}

export class CrashLiveRoom {
  phase: CrashPhase = 'crashed';
  roundNumber = 0;
  roundId = '';
  serverSeedHash = '';
  private serverSeed = '';
  private crashPoint = 1;
  private rtp = 0.99;
  private phaseStart = 0;
  private bets = new Map<string, LiveBet>();
  private busy = false;
  private readonly now: () => number;
  readonly clientSeed: string;

  constructor(private readonly d: CrashLiveDeps) {
    this.now = d.now ?? Date.now;
    this.clientSeed = `nymfo-crash-live:${d.operatorId}`;
  }

  get waitMs() {
    return this.d.waitMs ?? 5000;
  }

  get pauseMs() {
    return this.d.pauseMs ?? 3000;
  }

  snapshot() {
    const now = this.now();
    return {
      phase: this.phase,
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      nonce: this.roundNumber,
      startsAt: this.phase === 'waiting' ? this.phaseStart + this.waitMs : null,
      multiplier: this.phase === 'running' ? crashMultiplierAt(now - this.phaseStart) : this.phase === 'crashed' ? this.crashPoint : 1,
      bets: [...this.bets.values()].map((b) => ({ playerId: b.actor.playerId, amount: b.amount, currency: b.currency, cashout: b.cashout })),
    };
  }

  /** Avanza la máquina de estados según el reloj (llamado por el temporizador cada ~100 ms). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      if (this.phase === 'crashed' && now - this.phaseStart >= this.pauseMs) await this.openRound();
      else if (this.phase === 'waiting' && now - this.phaseStart >= this.waitMs) this.run();
      else if (this.phase === 'running') {
        const m = crashMultiplierAt(now - this.phaseStart);
        for (const b of this.bets.values()) {
          if (!b.settled && b.autoCashout !== null && b.autoCashout <= this.crashPoint && m >= b.autoCashout) await this.payout(b, b.autoCashout);
        }
        if (m >= this.crashPoint) await this.crash();
        else this.d.emit('crash:tick', { roundId: this.roundId, multiplier: m });
      }
    } finally {
      this.busy = false;
    }
  }

  async placeBet(actor: Actor, amount: bigint, currency: string, autoCashout?: number | null): Promise<{ roundId: string; balance: bigint }> {
    if (this.phase !== 'waiting') throw conflict('BETTING_CLOSED', 'Las apuestas están cerradas para esta ronda');
    const key = this.key(actor);
    if (this.bets.has(key)) throw conflict('ALREADY_BET', 'Ya apostaste en esta ronda');
    let auto: number | null = null;
    try {
      auto = autoCashout == null ? null : parseCashout(autoCashout);
    } catch (e) {
      if (e instanceof GameParamError) throw new HttpError(400, 'INVALID_PARAMS', e.message);
      throw e;
    }
    const id = randomUUID();
    const bet: LiveBet = { actor, roundId: id, amount, currency, autoCashout: auto, cashout: null, settled: false };
    this.bets.set(key, bet);
    const now = new Date(this.now());
    const round: StudioRound = {
      id, operatorId: actor.operatorId, playerId: actor.playerId, gameId: 'nymfo-crash', bet: amount, baseBet: amount, win: 0n, multiplier: 0,
      currency, outcome: null, state: { live: true, liveRoundId: this.roundId }, params: { live: true, autoCashout: auto }, rtp: this.rtp,
      rtpProfile: null, bonusBuy: false, serverSeedHash: this.serverSeedHash, clientSeed: this.clientSeed, nonce: this.roundNumber,
      seedPairId: this.roundId, status: 'OPEN', mode: actor.mode, debits: 1, version: 0, createdAt: now, updatedAt: now,
    };
    try {
      await this.d.rounds.create(round);
      const res = await actor.wallet.debit({
        operatorId: actor.operatorId, playerId: actor.playerId, currency, amount, idempotencyKey: betKey(id), reason: 'BET',
        ref: { provider: STUDIO_PROVIDER, gameId: 'nymfo-crash', roundId: id },
      });
      if (actor.mode === 'real') {
        await this.d.bus.publish('bet.placed', {
          operatorId: actor.operatorId, playerId: actor.playerId, at: now.toISOString(), amount, currency, gameId: 'nymfo-crash',
          provider: STUDIO_PROVIDER, category: 'originals', roundId: id,
        });
      }
      this.d.emit('crash:bet', { roundId: this.roundId, playerId: actor.playerId, amount, currency });
      return { roundId: id, balance: res.balance };
    } catch (e) {
      this.bets.delete(key);
      const r = await this.d.rounds.get(id);
      if (r) await this.d.rounds.update({ ...r, status: 'FAILED' }, r.version);
      throw e;
    }
  }

  async cashout(actor: Actor): Promise<{ multiplier: number; win: bigint }> {
    const b = this.bets.get(this.key(actor));
    if (!b || b.settled) throw conflict('NO_ACTIVE_BET', 'No tienes una apuesta activa');
    if (this.phase !== 'running') throw conflict('NOT_RUNNING', 'La ronda no está en curso');
    const m = crashMultiplierAt(this.now() - this.phaseStart);
    if (m < 1.01) throw conflict('TOO_EARLY', 'Aún no se puede retirar (mínimo 1.01x)');
    if (m >= this.crashPoint) {
      await this.tick();
      throw conflict('CRASHED', 'La ronda ya estalló');
    }
    return this.payout(b, m);
  }

  private key(a: Actor) {
    return `${a.mode}|${a.playerId}`;
  }

  private async openRound(): Promise<void> {
    const { serverSeed, serverSeedHash } = createSeedPair();
    this.rtp = await this.d.rtp().catch(() => 0.99);
    this.roundNumber += 1;
    this.roundId = randomUUID();
    this.serverSeed = serverSeed;
    this.serverSeedHash = serverSeedHash;
    this.crashPoint = crashPointFromRng(createFairRng(serverSeed, this.clientSeed, this.roundNumber), this.rtp);
    this.bets = new Map();
    this.phase = 'waiting';
    this.phaseStart = this.now();
    this.d.emit('crash:round', { roundId: this.roundId, roundNumber: this.roundNumber, serverSeedHash, clientSeed: this.clientSeed, nonce: this.roundNumber, startsAt: this.phaseStart + this.waitMs });
  }

  private run(): void {
    this.phase = 'running';
    this.phaseStart = this.now();
    this.d.emit('crash:start', { roundId: this.roundId, startedAt: this.phaseStart });
  }

  private async crash(): Promise<void> {
    this.phase = 'crashed';
    this.phaseStart = this.now();
    for (const b of this.bets.values()) if (!b.settled) await this.settle(b, 0, 0n);
    this.d.emit('crash:crashed', { roundId: this.roundId, crashPoint: this.crashPoint, serverSeed: this.serverSeed, serverSeedHash: this.serverSeedHash, nonce: this.roundNumber });
  }

  private async payout(b: LiveBet, m: number): Promise<{ multiplier: number; win: bigint }> {
    b.settled = true;
    b.cashout = m;
    const win = applyMultiplier(b.amount, m);
    try {
      await b.actor.wallet.credit({
        operatorId: b.actor.operatorId, playerId: b.actor.playerId, currency: b.currency, amount: win, idempotencyKey: winKey(b.roundId), reason: 'WIN',
        ref: { provider: STUDIO_PROVIDER, gameId: 'nymfo-crash', roundId: b.roundId },
      });
    } catch (e) {
      this.d.logger.error('Studio crash en vivo: fallo el crédito, se revierte la apuesta', { roundId: b.roundId, error: e instanceof Error ? e.message : String(e) });
      await b.actor.wallet
        .rollback({ operatorId: b.actor.operatorId, playerId: b.actor.playerId, originalIdempotencyKey: betKey(b.roundId), idempotencyKey: `studio:${b.roundId}:rollback` })
        .catch(() => undefined);
      const r = await this.d.rounds.get(b.roundId);
      if (r) await this.d.rounds.update({ ...r, status: 'ROLLED_BACK' }, r.version);
      throw e;
    }
    await this.settle(b, m, win);
    this.d.emit('crash:cashout', { roundId: this.roundId, playerId: b.actor.playerId, multiplier: m });
    return { multiplier: m, win };
  }

  private async settle(b: LiveBet, m: number, win: bigint): Promise<void> {
    b.settled = true;
    const r = await this.d.rounds.get(b.roundId);
    if (!r) return;
    // El serverSeed se publica al estallar; aquí solo el punto si ya se conoce (pérdida) o el retiro.
    const outcome = { liveRoundId: this.roundId, cashout: m > 0 ? m : null, win: m > 0, ...(m === 0 ? { crashPoint: this.crashPoint } : {}) };
    await this.d.rounds.update({ ...r, win, multiplier: m, outcome, status: 'SETTLED', updatedAt: new Date() }, r.version);
    if (b.actor.mode === 'real') {
      await this.d.bus.publish('bet.settled', {
        operatorId: b.actor.operatorId, playerId: b.actor.playerId, at: new Date(this.now()).toISOString(), amount: b.amount, win, currency: b.currency,
        gameId: 'nymfo-crash', provider: STUDIO_PROVIDER, category: 'originals', roundId: b.roundId, multiplier: m,
      });
    }
  }
}
