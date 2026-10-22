import { randomUUID } from 'crypto';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import type { EventBus } from '../../shared/events/EventBus';
import { conflict, forbidden, HttpError, notFound } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import { applyMultiplier } from '../../shared/money';
import type { Principal } from '../../shared/ports/AuthPort';
import type { BetGuardPort } from '../../shared/ports/BetGuardPort';
import { DEV_FALLBACK_CURRENCY, lookupOperatorCurrency, type OperatorCurrencyPort } from '../../shared/ports/OperatorCurrencyPort';
import type { WalletPort } from '../../shared/ports/WalletPort';
import { createFairRng } from '../domain/fairness/ProvablyFair';
import { GameActionError, GameParamError, InteractiveAction, InteractiveStep, OriginalGameMath } from '../domain/originals';
import { RoundExistsError, RoundMode, RoundRepository, StudioRound } from '../domain/rounds/types';
import { findGame, StudioGameEntry } from './catalog';
import type { EffectiveGameConfig, StudioConfigService } from './StudioConfigService';
import type { StudioFairnessService } from './StudioFairnessService';

export const STUDIO_PROVIDER = 'nymfo-studios';

/** Sesión de lanzamiento resuelta por el Hub (operadores remotos o lanzamientos locales). */
export interface HubSession {
  sessionId?: string;
  operatorId: string;
  playerId: string;
  currency: string;
  mode?: 'real' | 'demo';
  [k: string]: unknown;
}

export interface HubSessionsPort {
  resolveSession(token: string): Promise<HubSession | null>;
  walletForSession(session: HubSession | string): WalletPort;
}

/** Identidad de quien juega: token del jugador, sesión del Hub o sesión demo anónima. */
export interface ActorInput {
  principal?: Principal;
  sessionToken?: string;
  /** Modo demo explícito (con principal o anónimo). */
  mode?: RoundMode;
  /** Id de la sesión demo anónima. */
  demoSession?: string;
  /** Operador de la sesión demo anónima (marca/RTP del operador). */
  operatorId?: string;
}

export interface Actor {
  operatorId: string;
  playerId: string;
  mode: RoundMode;
  wallet: WalletPort;
  /** Divisa del actor: la de la sesión (Hub/demo) o, para jugadores reales, la pedida → la del jugador → la del operador. */
  currency: string;
  /** true si la divisa la fija la sesión (Hub/demo) y no puede cambiarse por apuesta. */
  currencyFixed?: boolean;
}

export interface PlayRequest extends ActorInput {
  amount: bigint;
  currency?: string;
  bonusBuy?: boolean;
  params?: Record<string, unknown>;
  /** Id de ronda generado por el cliente para reintentos idempotentes. */
  roundId?: string;
}

export interface StartRequest extends ActorInput {
  amount: bigint;
  currency?: string;
  params?: Record<string, unknown>;
  roundId?: string;
}

export interface ActionRequest extends ActorInput {
  roundId: string;
  action: InteractiveAction;
}

export interface PublicRound {
  id: string;
  gameId: string;
  operatorId: string;
  playerId: string;
  bet: bigint;
  baseBet: bigint;
  win: bigint;
  multiplier: number;
  currency: string;
  outcome: unknown;
  params: Record<string, unknown>;
  rtp: number;
  bonusBuy: boolean;
  serverSeedHash: string;
  serverSeed?: string;
  clientSeed: string;
  nonce: number;
  status: StudioRound['status'];
  mode: RoundMode;
  createdAt: Date;
}

export interface PlayResponse {
  round: PublicRound;
  balance: bigint | null;
}

export interface StudioPlayDeps {
  wallet: WalletPort;
  bus: EventBus;
  betGuard?: BetGuardPort;
  rounds: RoundRepository;
  fairness: StudioFairnessService;
  config: StudioConfigService;
  logger: ModuleLogger;
  hub?: HubSessionsPort;
  /** Moneda, monedas habilitadas y límites de apuesta del operador (Operator de la Fase 1). */
  operators?: OperatorCurrencyPort;
  /** Saldo virtual inicial de cada sesión demo (unidades mínimas). */
  demoBalance?: bigint;
  /** Respaldo SOLO para el dev-server (sin operador real): STUDIO_DEMO_CURRENCY / STUDIO_DEFAULT_CURRENCY. */
  demoCurrency?: string;
  defaultCurrency?: string;
  now?: () => number;
}

const CURRENCY_RE = /^[A-Z0-9]{3,10}$/;
const DEMO_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Saldo demo por defecto por moneda (unidades mínimas): 1.000.000 COP en centavos; el resto 10 000.00. */
const DEFAULT_DEMO_BALANCE: Readonly<Record<string, bigint>> = { COP: 100_000_000n };

export const betKey = (roundId: string, seq = 0) => (seq === 0 ? `studio:${roundId}:bet` : `studio:${roundId}:bet:${seq}`);
export const winKey = (roundId: string) => `studio:${roundId}:win`;
const rollbackKey = (roundId: string, seq: number) => `studio:${roundId}:rollback${seq === 0 ? '' : `:${seq}`}`;

/**
 * Orquesta una ronda de Studios: config del operador → guardia de apuesta → débito → RNG provably fair →
 * crédito → ronda guardada → eventos. Si algo falla tras el débito, revierte con rollback.
 */
export class StudioPlayService {
  readonly demoWallet = new InMemoryWallet();
  private readonly demoSeeded = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly d: StudioPlayDeps) {
    this.now = d.now ?? Date.now;
  }

  // ───────────────────────── actores y billeteras ─────────────────────────

  async resolveActor(input: ActorInput, currency?: string): Promise<Actor> {
    const requested = currency ? this.validCurrency(currency) : undefined;
    if (input.sessionToken) {
      if (!this.d.hub) throw new HttpError(401, 'UNAUTHORIZED', 'Sesiones de Hub no disponibles');
      const s = await this.d.hub.resolveSession(input.sessionToken);
      if (!s) throw new HttpError(401, 'SESSION_INVALID', 'Sesión de juego inválida o expirada');
      return {
        operatorId: s.operatorId,
        playerId: s.playerId,
        mode: s.mode === 'demo' ? 'demo' : 'real',
        wallet: this.d.hub.walletForSession(s),
        currency: s.currency,
        currencyFixed: true,
      };
    }
    const p = input.principal;
    if (p && p.role === 'PLAYER' && p.operatorId && p.playerId) {
      if (input.mode === 'demo') return this.demoActor(p.operatorId, `demo:${p.playerId}`, requested, p.currency);
      const cur = await this.pickCurrency(p.operatorId, requested, p.currency, this.d.defaultCurrency);
      return { operatorId: p.operatorId, playerId: p.playerId, mode: 'real', wallet: this.d.wallet, currency: cur };
    }
    if (input.mode === 'demo') {
      if (!input.demoSession || !DEMO_RE.test(input.demoSession)) throw new HttpError(400, 'DEMO_SESSION_REQUIRED', 'Indica una sesión demo válida');
      return this.demoActor(input.operatorId || 'demo', `demo:${input.demoSession}`, requested);
    }
    if (p) throw forbidden('Solo jugadores');
    throw new HttpError(401, 'UNAUTHORIZED', 'Token ausente o inválido');
  }

  /**
   * Divisa de una apuesta: pedida (validada contra las monedas del operador) → la del jugador → defaultCurrency
   * del operador → respaldo de entorno (solo dev-server sin operador real).
   */
  private async pickCurrency(operatorId: string, requested: string | undefined, playerCurrency: string | undefined, fallback: string | undefined): Promise<string> {
    const info = await lookupOperatorCurrency(this.d.operators, operatorId, this.d.logger);
    if (requested) {
      if (info && info.currencies.length > 0 && !info.currencies.includes(requested)) {
        throw new HttpError(400, 'CURRENCY_NOT_SUPPORTED', 'Divisa no habilitada para este operador', { currencies: info.currencies });
      }
      return requested;
    }
    return playerCurrency || info?.defaultCurrency || fallback || DEV_FALLBACK_CURRENCY;
  }

  private async demoActor(operatorId: string, playerId: string, currency?: string, playerCurrency?: string): Promise<Actor> {
    const cur = await this.pickCurrency(operatorId, currency, playerCurrency, this.d.demoCurrency ?? this.d.defaultCurrency);
    const key = `${operatorId}|${playerId}|${cur}`;
    if (!this.demoSeeded.has(key)) {
      this.demoSeeded.add(key);
      this.demoWallet.seed(operatorId, playerId, cur, this.d.demoBalance ?? DEFAULT_DEMO_BALANCE[cur] ?? 1_000_000n);
    }
    return { operatorId, playerId, mode: 'demo', wallet: this.demoWallet, currency: cur, currencyFixed: true };
  }

  async balance(input: ActorInput, currency?: string): Promise<{ balance: bigint; currency: string; mode: RoundMode }> {
    const a = await this.resolveActor(input, currency);
    const b = await a.wallet.getBalance(a.operatorId, a.playerId, a.currency);
    return { balance: b.cash + b.bonus, currency: a.currency, mode: a.mode };
  }

  /** Divisa de una apuesta del crash en vivo: la de la sesión si está fijada; si no, la pedida validada contra el operador. */
  async betCurrency(actor: Actor, requested?: string): Promise<string> {
    if (actor.currencyFixed || !requested) return actor.currency;
    return this.pickCurrency(actor.operatorId, this.validCurrency(requested), undefined, actor.currency);
  }

  /** Comprueba juego activo y límites (del juego o del operador) para apuestas fuera de play/start (crash en vivo). */
  async assertBetLimits(actor: Actor, gameId: string, amount: bigint, currency: string): Promise<void> {
    const cfg = await this.d.config.resolve(actor.operatorId, gameId);
    this.checkLimits(await this.effectiveLimits(cfg, actor.operatorId, currency), amount);
  }

  private validCurrency(currency: string): string {
    if (!CURRENCY_RE.test(currency)) throw new HttpError(400, 'BAD_REQUEST', 'Divisa inválida');
    return currency;
  }

  /** Si la config del juego no fija minBet/maxBet, aplica Operator.limits cuando la apuesta va en la moneda del operador. */
  private async effectiveLimits(cfg: EffectiveGameConfig, operatorId: string, currency: string): Promise<EffectiveGameConfig> {
    if (cfg.minBet !== null && cfg.maxBet !== null) return cfg;
    const info = await lookupOperatorCurrency(this.d.operators, operatorId, this.d.logger);
    if (!info || info.defaultCurrency !== currency) return cfg;
    return {
      ...cfg,
      minBet: cfg.minBet ?? info.limits.minBet ?? null,
      maxBet: cfg.maxBet ?? info.limits.maxBet ?? null,
    };
  }

  // ───────────────────────── rondas de una acción ─────────────────────────

  async play(gameId: string, req: PlayRequest): Promise<PlayResponse> {
    const g = this.requireGame(gameId);
    const math = g.math as OriginalGameMath | undefined;
    if (!math) throw new HttpError(400, 'INTERACTIVE_GAME', 'Este juego se juega con /games/:gameId/start');
    const actor = await this.resolveActor(req, req.currency);
    const currency = actor.currency;
    const cfg = await this.effectiveLimits(await this.d.config.resolve(actor.operatorId, gameId), actor.operatorId, currency);
    const params = req.params ?? {};

    this.guardParams(() => {
      math.validateParams?.(params);
      const expected = math.expectedStake?.(params);
      if (expected != null && expected !== req.amount) throw new GameParamError('La suma de las apuestas debe igualar amount');
    });
    if (req.bonusBuy && !math.bonusBuy) throw new HttpError(400, 'BONUS_BUY_UNAVAILABLE', 'El juego no admite compra de bonus');
    this.checkLimits(cfg, req.amount);
    const stake = req.bonusBuy ? applyMultiplier(req.amount, math.bonusBuy!.costMultiplier) : req.amount;

    const existing = req.roundId ? await this.replay(req.roundId, actor) : null;
    if (existing) return existing;

    await this.checkGuard(actor, g, stake, currency);
    const roundId = req.roundId ?? randomUUID();
    const round = await this.openRound(roundId, actor, g, cfg, { bet: stake, baseBet: req.amount, currency, params, bonusBuy: !!req.bonusBuy });
    if (!round) return (await this.replay(roundId, actor))!;

    const debit = await this.debitOrFail(round, actor, stake, 0);
    let credited = false;
    try {
      const rng = createFairRng(round.serverSeed, round.clientSeed, round.nonce);
      const result = math.play(rng, { bonusBuy: !!req.bonusBuy, params, rtpProfile: cfg.rtpProfile });
      const win = applyMultiplier(req.amount, result.multiplier);
      let balance = debit.balance;
      if (win > 0n) {
        balance = (await actor.wallet.credit(this.creditReq(round, actor, win))).balance;
        credited = true;
      }
      const settled: StudioRound = { ...round.data, win, multiplier: result.multiplier, outcome: result.outcome, status: 'SETTLED', updatedAt: new Date() };
      await this.save(settled, round.data.version);
      await this.publishSettled(actor, settled, g);
      return { round: this.toPublic(settled), balance };
    } catch (e) {
      if (!credited) await this.rollbackRound(round.data, actor, 1, e);
      else this.d.logger.error('Studio: ronda acreditada pero no guardada', { roundId, error: e instanceof Error ? e.message : String(e) });
      throw this.mapGameError(e);
    }
  }

  // ───────────────────────── rondas interactivas ─────────────────────────

  async start(gameId: string, req: StartRequest): Promise<PlayResponse & { view: Record<string, unknown> }> {
    const g = this.requireGame(gameId);
    const game = g.interactive;
    if (!game) throw new HttpError(400, 'NOT_INTERACTIVE', 'Este juego se juega con /play/:gameId');
    const actor = await this.resolveActor(req, req.currency);
    const currency = actor.currency;
    const cfg = await this.effectiveLimits(await this.d.config.resolve(actor.operatorId, gameId), actor.operatorId, currency);
    const params = req.params ?? {};
    this.guardParams(() => game.validateParams(params));
    this.checkLimits(cfg, req.amount);

    if (req.roundId) {
      const prev = await this.replay(req.roundId, actor);
      if (prev) return { ...prev, view: (prev.round.outcome ?? {}) as Record<string, unknown> };
    }
    const open = await this.d.rounds.findOpen(actor.operatorId, actor.playerId, gameId, actor.mode);
    if (open) throw new HttpError(409, 'ROUND_OPEN', 'Ya tienes una ronda abierta en este juego', { roundId: open.id });

    await this.checkGuard(actor, g, req.amount, currency);
    const roundId = req.roundId ?? randomUUID();
    const round = await this.openRound(roundId, actor, g, cfg, { bet: req.amount, baseBet: req.amount, currency, params, bonusBuy: false });
    if (!round) {
      const prev = (await this.replay(roundId, actor))!;
      return { ...prev, view: (prev.round.outcome ?? {}) as Record<string, unknown> };
    }
    const debit = await this.debitOrFail(round, actor, req.amount, 0);
    try {
      const rng = createFairRng(round.serverSeed, round.clientSeed, round.nonce);
      const step = game.start(rng, params, { rtp: cfg.rtp, now: this.now() });
      return await this.applyStep(round.data, actor, g, step, debit.balance, true);
    } catch (e) {
      const current = await this.d.rounds.get(roundId);
      if (current && current.status === 'OPEN') await this.rollbackRound(current, actor, current.debits, e);
      throw this.mapGameError(e);
    }
  }

  async action(gameId: string, req: ActionRequest): Promise<PlayResponse & { view: Record<string, unknown> }> {
    const g = this.requireGame(gameId);
    const game = g.interactive;
    if (!game) throw new HttpError(400, 'NOT_INTERACTIVE', 'Este juego no es interactivo');
    const actor = await this.resolveActor(req);
    return this.withLock(req.roundId, async () => {
      const round = await this.d.rounds.get(req.roundId);
      if (!round || round.gameId !== gameId || round.operatorId !== actor.operatorId || round.playerId !== actor.playerId || round.mode !== actor.mode) {
        throw notFound('Ronda no encontrada');
      }
      if (round.status !== 'OPEN') throw conflict('ROUND_CLOSED', 'La ronda ya terminó');
      let step: InteractiveStep<unknown>;
      try {
        step = game.action(round.state, req.action, { rtp: round.rtp, now: this.now() });
      } catch (e) {
        throw this.mapGameError(e);
      }
      return this.applyStep(round, actor, g, step, null, false);
    });
  }

  /** Cierra de forma forzada una ronda interactiva abierta (abandono/timeout). */
  async settleOpenRound(roundId: string, input: ActorInput): Promise<PlayResponse> {
    const actor = await this.resolveActor(input);
    return this.withLock(roundId, async () => {
      const round = await this.d.rounds.get(roundId);
      if (!round || round.operatorId !== actor.operatorId || round.playerId !== actor.playerId) throw notFound('Ronda no encontrada');
      const g = this.requireGame(round.gameId);
      if (round.status !== 'OPEN' || !g.interactive) return { round: this.toPublic(round), balance: null };
      const step = g.interactive.settle(round.state, { rtp: round.rtp, now: this.now() });
      const r = await this.applyStep(round, actor, g, step, null, false);
      return { round: r.round, balance: r.balance };
    });
  }

  async activeRound(gameId: string, input: ActorInput): Promise<PublicRound | null> {
    this.requireGame(gameId);
    const actor = await this.resolveActor(input);
    const r = await this.d.rounds.findOpen(actor.operatorId, actor.playerId, gameId, actor.mode);
    return r ? this.toPublic(r) : null;
  }

  async listRounds(input: ActorInput, q: { gameId?: string; limit: number; offset: number }): Promise<PublicRound[]> {
    const actor = await this.resolveActor(input);
    const rows = await this.d.rounds.list({ operatorId: actor.operatorId, playerId: actor.playerId, mode: actor.mode, gameId: q.gameId, limit: q.limit, offset: q.offset });
    return Promise.all(rows.map((r) => this.toPublicRevealed(r)));
  }

  async getRound(id: string, input: ActorInput): Promise<PublicRound> {
    const actor = await this.resolveActor(input);
    const r = await this.d.rounds.get(id);
    if (!r || r.operatorId !== actor.operatorId || r.playerId !== actor.playerId) throw notFound('Ronda no encontrada');
    return this.toPublicRevealed(r);
  }

  // ───────────────────────── internos ─────────────────────────

  private async applyStep(
    round: StudioRound,
    actor: Actor,
    g: StudioGameEntry,
    step: InteractiveStep<unknown>,
    balance: bigint | null,
    isStart: boolean,
  ): Promise<PlayResponse & { view: Record<string, unknown> }> {
    let r: StudioRound = { ...round, state: step.state, outcome: step.view, updatedAt: new Date() };
    let bal = balance;
    let extraSeq: number | null = null;
    if (step.additionalBet && step.additionalBet > 0) {
      const extra = applyMultiplier(round.baseBet, step.additionalBet);
      await this.checkGuard(actor, g, extra, round.currency);
      extraSeq = round.debits;
      const res = await actor.wallet.debit({
        operatorId: actor.operatorId,
        playerId: actor.playerId,
        currency: round.currency,
        amount: extra,
        idempotencyKey: betKey(round.id, extraSeq),
        reason: 'BET',
        ref: { provider: STUDIO_PROVIDER, gameId: round.gameId, roundId: round.id },
      });
      bal = res.balance;
      r = { ...r, bet: r.bet + extra, debits: r.debits + 1 };
      if (actor.mode === 'real') await this.publishPlaced(actor, r, g, extra);
    }
    if (step.done) {
      const win = applyMultiplier(r.baseBet, step.multiplier);
      if (win > 0n) {
        try {
          bal = (await actor.wallet.credit(this.creditReq({ data: r }, actor, win))).balance;
        } catch (e) {
          await this.rollbackRound(r, actor, r.debits, e);
          throw e;
        }
      }
      r = { ...r, win, multiplier: step.multiplier, status: 'SETTLED' };
    }
    try {
      await this.save(r, round.version);
    } catch (e) {
      if (extraSeq !== null && !step.done) {
        await actor.wallet.rollback({ operatorId: actor.operatorId, playerId: actor.playerId, originalIdempotencyKey: betKey(round.id, extraSeq), idempotencyKey: rollbackKey(round.id, extraSeq) });
      }
      throw e;
    }
    r = { ...r, version: round.version + 1 };
    if (step.done) await this.publishSettled(actor, r, g);
    if (bal === null && !isStart) {
      const b = await actor.wallet.getBalance(actor.operatorId, actor.playerId, r.currency);
      bal = b.cash + b.bonus;
    }
    return { round: this.toPublic(r), balance: bal, view: step.view };
  }

  private requireGame(gameId: string): StudioGameEntry {
    const g = findGame(gameId);
    if (!g) throw notFound(`Juego desconocido: ${gameId}`);
    return g;
  }

  private guardParams(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      throw this.mapGameError(e);
    }
  }

  private mapGameError(e: unknown): unknown {
    if (e instanceof GameParamError) return new HttpError(400, 'INVALID_PARAMS', e.message);
    if (e instanceof GameActionError) return new HttpError(409, 'INVALID_ACTION', e.message);
    return e;
  }

  private checkLimits(cfg: EffectiveGameConfig, amount: bigint): void {
    if (!cfg.enabled) throw new HttpError(403, 'GAME_DISABLED', 'Juego desactivado para este operador');
    if (cfg.minBet !== null && amount < cfg.minBet) throw new HttpError(400, 'BET_TOO_LOW', 'Apuesta por debajo del mínimo', { minBet: cfg.minBet });
    if (cfg.maxBet !== null && amount > cfg.maxBet) throw new HttpError(400, 'BET_TOO_HIGH', 'Apuesta por encima del máximo', { maxBet: cfg.maxBet });
  }

  private async checkGuard(actor: Actor, g: StudioGameEntry, amount: bigint, currency: string): Promise<void> {
    if (actor.mode !== 'real' || !this.d.betGuard) return;
    const r = await this.d.betGuard.checkBet({ operatorId: actor.operatorId, playerId: actor.playerId, gameId: g.id, category: this.category(g), amount, currency });
    if (!r.allowed) throw new HttpError(403, 'BET_REJECTED', r.reason ?? 'Apuesta rechazada');
  }

  private category(g: StudioGameEntry): string {
    return g.kind === 'slot' ? 'slots' : 'originals';
  }

  /** Devuelve una ronda ya existente del mismo jugador (reintento idempotente) o null si no existe. */
  private async replay(roundId: string, actor: Actor): Promise<PlayResponse | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roundId)) {
      throw new HttpError(400, 'BAD_REQUEST', 'roundId debe ser un uuid');
    }
    const r = await this.d.rounds.get(roundId);
    if (!r) return null;
    if (r.operatorId !== actor.operatorId || r.playerId !== actor.playerId) throw conflict('ROUND_ID_TAKEN', 'roundId ya usado');
    if (r.status === 'OPEN' && !r.state) throw conflict('ROUND_IN_PROGRESS', 'La ronda se está procesando');
    if (r.status === 'FAILED' || r.status === 'ROLLED_BACK') throw conflict('ROUND_FAILED', 'La ronda falló y se revirtió; usa otro roundId');
    return { round: this.toPublic(r), balance: null };
  }

  private async openRound(
    roundId: string,
    actor: Actor,
    g: StudioGameEntry,
    cfg: EffectiveGameConfig,
    x: { bet: bigint; baseBet: bigint; currency: string; params: Record<string, unknown>; bonusBuy: boolean },
  ): Promise<{ data: StudioRound; serverSeed: string; clientSeed: string; nonce: number } | null> {
    const seed = await this.d.fairness.reserve(actor.operatorId, actor.playerId);
    const now = new Date();
    const data: StudioRound = {
      id: roundId,
      operatorId: actor.operatorId,
      playerId: actor.playerId,
      gameId: g.id,
      bet: x.bet,
      baseBet: x.baseBet,
      win: 0n,
      multiplier: 0,
      currency: x.currency,
      outcome: null,
      state: null,
      params: x.params,
      rtp: cfg.rtp,
      rtpProfile: cfg.rtpProfile ?? null,
      bonusBuy: x.bonusBuy,
      serverSeedHash: seed.serverSeedHash,
      clientSeed: seed.clientSeed,
      nonce: seed.nonce,
      seedPairId: seed.seedPairId,
      status: 'OPEN',
      mode: actor.mode,
      debits: 1,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.d.rounds.create(data);
    } catch (e) {
      if (e instanceof RoundExistsError) return null;
      throw e;
    }
    return { data, serverSeed: seed.serverSeed, clientSeed: seed.clientSeed, nonce: seed.nonce };
  }

  private async debitOrFail(round: { data: StudioRound }, actor: Actor, amount: bigint, seq: number) {
    try {
      const res = await actor.wallet.debit({
        operatorId: actor.operatorId,
        playerId: actor.playerId,
        currency: round.data.currency,
        amount,
        idempotencyKey: betKey(round.data.id, seq),
        reason: 'BET',
        ref: { provider: STUDIO_PROVIDER, gameId: round.data.gameId, roundId: round.data.id },
      });
      if (actor.mode === 'real') await this.publishPlaced(actor, round.data, this.requireGame(round.data.gameId), amount);
      return res;
    } catch (e) {
      await this.save({ ...round.data, status: 'FAILED', updatedAt: new Date() }, round.data.version).catch(() => undefined);
      throw e;
    }
  }

  private creditReq(round: { data: StudioRound }, actor: Actor, win: bigint) {
    return {
      operatorId: actor.operatorId,
      playerId: actor.playerId,
      currency: round.data.currency,
      amount: win,
      idempotencyKey: winKey(round.data.id),
      reason: 'WIN' as const,
      ref: { provider: STUDIO_PROVIDER, gameId: round.data.gameId, roundId: round.data.id },
    };
  }

  /** Revierte todos los débitos de la ronda y la marca ROLLED_BACK. */
  private async rollbackRound(round: StudioRound, actor: Actor, debits: number, cause: unknown): Promise<void> {
    this.d.logger.warn('Studio: revirtiendo ronda', { roundId: round.id, error: cause instanceof Error ? cause.message : String(cause) });
    for (let seq = 0; seq < debits; seq++) {
      try {
        await actor.wallet.rollback({ operatorId: actor.operatorId, playerId: actor.playerId, originalIdempotencyKey: betKey(round.id, seq), idempotencyKey: rollbackKey(round.id, seq) });
      } catch (e) {
        this.d.logger.error('Studio: fallo el rollback', { roundId: round.id, seq, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const current = await this.d.rounds.get(round.id);
    if (current) await this.d.rounds.update({ ...current, status: 'ROLLED_BACK', updatedAt: new Date() }, current.version);
  }

  private async save(r: StudioRound, expectedVersion: number): Promise<void> {
    const ok = await this.d.rounds.update(r, expectedVersion);
    if (!ok) throw conflict('ROUND_CONFLICT', 'La ronda cambió en paralelo, reintenta');
  }

  private async publishPlaced(actor: Actor, r: StudioRound, g: StudioGameEntry, amount: bigint): Promise<void> {
    await this.d.bus.publish('bet.placed', {
      operatorId: actor.operatorId,
      playerId: actor.playerId,
      at: new Date(this.now()).toISOString(),
      amount,
      currency: r.currency,
      gameId: r.gameId,
      provider: STUDIO_PROVIDER,
      category: this.category(g),
      roundId: r.id,
    });
  }

  private async publishSettled(actor: Actor, r: StudioRound, g: StudioGameEntry): Promise<void> {
    if (actor.mode !== 'real') return;
    await this.d.bus.publish('bet.settled', {
      operatorId: actor.operatorId,
      playerId: actor.playerId,
      at: new Date(this.now()).toISOString(),
      amount: r.bet,
      win: r.win,
      currency: r.currency,
      gameId: r.gameId,
      provider: STUDIO_PROVIDER,
      category: this.category(g),
      roundId: r.id,
      multiplier: r.multiplier,
    });
  }

  private toPublic(r: StudioRound): PublicRound {
    return {
      id: r.id,
      gameId: r.gameId,
      operatorId: r.operatorId,
      playerId: r.playerId,
      bet: r.bet,
      baseBet: r.baseBet,
      win: r.win,
      multiplier: r.multiplier,
      currency: r.currency,
      outcome: r.outcome,
      params: r.params,
      rtp: r.rtp,
      bonusBuy: r.bonusBuy,
      serverSeedHash: r.serverSeedHash,
      clientSeed: r.clientSeed,
      nonce: r.nonce,
      status: r.status,
      mode: r.mode,
      createdAt: r.createdAt,
    };
  }

  private async toPublicRevealed(r: StudioRound): Promise<PublicRound> {
    const serverSeed = await this.d.fairness.revealed(r.seedPairId);
    return { ...this.toPublic(r), ...(serverSeed ? { serverSeed } : {}) };
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }
}
