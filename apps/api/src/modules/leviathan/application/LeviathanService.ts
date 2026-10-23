import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import { isWalletError, type WalletPort } from '../../shared/ports/WalletPort';
import { betReturn, MODE_SPEC, OPENING_CHIPS, RAKE_PPM, roomCode, settle, type GameMode } from '../domain/rules';
import { MATCH_MINUTES, simFixture, simResult, SPORTS, type Sport } from '../domain/sim';
import { winnersFor, type ApiFootball } from '../infrastructure/apiFootball';

const MIN = 60_000;
/** Partidos simulados por deporte que se mantienen programados hacia adelante. */
const FIXTURE_HORIZON_MIN = 240;
const FIXTURE_GAP_MIN = 12;
/** Si un concurso quedó con apuestas abiertas tanto tiempo después de terminar, se anulan y se reparte igual. */
const STALL_VOID_MIN = 180;
/** Fútbol real: duración estimada del partido (90' + descanso + adición). */
const REAL_MATCH_MIN = 115;
/** Presupuesto del plan gratis de API-Football (100 consultas/día): descubrir partidos cada 6 h y resultados cada 15 min. */
const DISCOVER_EVERY_MIN = 360;
const RESULTS_EVERY_MIN = 15;
const MAX_NEW_FIXTURES = 10;

/** Feed real conectado (API-Football) y las ligas elegidas. null = se usan partidos simulados. */
export type RealFeed = { api: ApiFootball; leagues: number[] } | null;

export interface CreateGameInput {
  operatorId: string;
  mode: GameMode;
  title: string;
  entry: bigint;
  startsInMin?: number;
  durationMin?: number;
  maxPlayers?: number;
  sport?: Sport;
  createdBy?: string;
}

/**
 * Leviathan: concursos de fichas sobre deportes (BetBattle). El dinero solo se mueve al entrar (entrada), al repartir
 * (premios) o al cancelar (devolución), siempre por la billetera con llaves idempotentes; las fichas viven en la tabla
 * del concurso. El casino solo retiene la comisión: nunca paga premios de su bolsillo.
 */
export class LeviathanService {
  private ticking = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: PrismaClient,
    private readonly wallet: WalletPort,
    private readonly opts: { logger: ModuleLogger; now?: () => Date; rand?: () => number; realFeed?: () => Promise<RealFeed> },
  ) {}

  private lastDiscovery = 0;
  private lastResults = 0;
  private lastAuto = 0;

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  // ───────────────────────── feed simulado ─────────────────────────

  /** Mantiene partidos programados en cada deporte hasta el horizonte. */
  async ensureFixtures(horizon = new Date(this.now().getTime() + FIXTURE_HORIZON_MIN * MIN)) {
    for (const sport of SPORTS) {
      const last = await this.db.levEvent.findFirst({ where: { sport, source: 'sim' }, orderBy: { startsAt: 'desc' } });
      let next = new Date(Math.max(this.now().getTime() + 5 * MIN, (last?.startsAt.getTime() ?? 0) + FIXTURE_GAP_MIN * MIN));
      while (next < horizon) {
        const end = new Date(next.getTime() + MATCH_MINUTES[sport] * MIN);
        const overlapping = await this.db.levEvent.findMany({ where: { sport, startsAt: { lt: end }, endsAt: { gt: next } }, select: { home: true, away: true } });
        const f = simFixture(sport, this.opts.rand, new Set(overlapping.flatMap((e) => [e.home, e.away])));
        const id = randomUUID();
        await this.db.$transaction([
          this.db.levEvent.create({ data: { id, sport, league: f.league, home: f.home, away: f.away, startsAt: next, endsAt: new Date(next.getTime() + MATCH_MINUTES[sport] * MIN) } }),
          this.db.levSelection.createMany({ data: f.selections.map((s) => ({ id: randomUUID(), eventId: id, market: s.market, line: s.line ?? null, key: s.key, label: s.label, oddsE2: s.oddsE2 })) }),
        ]);
        next = new Date(next.getTime() + FIXTURE_GAP_MIN * MIN);
      }
    }
  }

  private async realFeed(): Promise<RealFeed> {
    try {
      return (await this.opts.realFeed?.()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Feed real: descubre partidos con cuotas de las ligas elegidas (hoy y mañana) y actualiza estados y resultados.
   * Un partido terminado liquida sus selecciones con el marcador de los 90'; aplazado o cancelado, las anula
   * (se devuelven las fichas).
   */
  async syncReal(feed: NonNullable<RealFeed>) {
    const now = this.now();
    if (now.getTime() - this.lastDiscovery >= DISCOVER_EVERY_MIN * MIN) {
      this.lastDiscovery = now.getTime();
      const leagues = new Set(feed.leagues);
      const dates = [0, 1].map((d) => new Date(now.getTime() + d * 1440 * MIN).toISOString().slice(0, 10));
      let created = 0;
      for (const date of dates) {
        for (const fx of await feed.api.fixturesByDate(date)) {
          if (created >= MAX_NEW_FIXTURES) break;
          if (!leagues.has(fx.leagueId) || fx.status !== 'SCHEDULED' || fx.startsAt.getTime() < now.getTime() + 10 * MIN) continue;
          if (await this.db.levEvent.findUnique({ where: { source_externalId: { source: 'api-football', externalId: fx.externalId } } })) continue;
          const sels = await feed.api.odds(fx.externalId, fx.home, fx.away);
          if (sels.length < 3) continue; // sin cuotas no se puede apostar
          const id = randomUUID();
          await this.db.$transaction([
            this.db.levEvent.create({ data: { id, sport: 'football', league: fx.league, home: fx.home, away: fx.away, startsAt: fx.startsAt, endsAt: new Date(fx.startsAt.getTime() + REAL_MATCH_MIN * MIN), source: 'api-football', externalId: fx.externalId } }),
            this.db.levSelection.createMany({ data: sels.map((x) => ({ id: randomUUID(), eventId: id, market: x.market, line: x.line ?? null, key: x.key, label: x.label, oddsE2: x.oddsE2 })) }),
          ]);
          created++;
        }
      }
    }
    if (now.getTime() - this.lastResults < RESULTS_EVERY_MIN * MIN) return;
    const pending = await this.db.levEvent.findMany({ where: { source: 'api-football', status: { in: ['SCHEDULED', 'LIVE'] }, startsAt: { lte: now } }, orderBy: { startsAt: 'asc' }, take: 20 });
    if (!pending.length) return;
    this.lastResults = now.getTime();
    const byExt = new Map(pending.map((e) => [e.externalId, e]));
    for (const fx of await feed.api.fixturesByIds(pending.map((e) => e.externalId!).filter(Boolean))) {
      const ev = byExt.get(fx.externalId);
      if (!ev) continue;
      if (fx.status === 'LIVE' && ev.status !== 'LIVE') await this.db.levEvent.update({ where: { id: ev.id }, data: { status: 'LIVE' } });
      else if (fx.status === 'FINISHED' && fx.homeScore !== null && fx.awayScore !== null) {
        const won = winnersFor(fx.homeScore, fx.awayScore);
        const sels = await this.db.levSelection.findMany({ where: { eventId: ev.id } });
        await this.db.$transaction([
          this.db.levEvent.update({ where: { id: ev.id }, data: { status: 'FINISHED', homeScore: fx.homeScore, awayScore: fx.awayScore } }),
          ...sels.map((x) => this.db.levSelection.update({ where: { id: x.id }, data: { result: won.has(`${x.market}:${x.key}`) ? 'WON' : 'LOST' } })),
        ]);
        await this.resolveBets(ev.id);
      } else if (fx.status === 'CANCELLED') {
        await this.db.$transaction([
          this.db.levEvent.update({ where: { id: ev.id }, data: { status: 'CANCELLED' } }),
          this.db.levSelection.updateMany({ where: { eventId: ev.id }, data: { result: 'VOID' } }),
        ]);
        await this.resolveBets(ev.id);
      }
    }
  }

  /** Arranca los partidos que empezaron y resuelve los que terminaron (con el resultado simulado). */
  async advanceEvents() {
    const now = this.now();
    await this.db.levEvent.updateMany({ where: { status: 'SCHEDULED', startsAt: { lte: now }, source: 'sim' }, data: { status: 'LIVE' } });
    for (const ev of await this.db.levEvent.findMany({ where: { status: 'LIVE', endsAt: { lte: now }, source: 'sim' }, take: 100 })) {
      const sels = await this.db.levSelection.findMany({ where: { eventId: ev.id } });
      const r = simResult(ev.sport as Sport, sels, this.opts.rand);
      await this.db.$transaction([
        this.db.levEvent.update({ where: { id: ev.id }, data: { status: 'FINISHED', homeScore: r.home, awayScore: r.away } }),
        ...sels.map((s) => this.db.levSelection.update({ where: { id: s.id }, data: { result: r.winners.has(`${s.market}:${s.key}`) ? 'WON' : 'LOST' } })),
      ]);
      await this.resolveBets(ev.id);
    }
  }

  /** Paga en fichas las apuestas de un partido resuelto (una sola vez por apuesta). */
  async resolveBets(eventId: string) {
    const sels = await this.db.levSelection.findMany({ where: { eventId, result: { not: 'OPEN' } } });
    for (const s of sels) {
      for (const b of await this.db.levBet.findMany({ where: { selectionId: s.id, status: 'OPEN' } })) {
        const credit = s.result === 'WON' ? b.returnChips : s.result === 'VOID' ? b.stake : 0n;
        await this.db.$transaction(async (tx) => {
          const moved = await tx.levBet.updateMany({ where: { id: b.id, status: 'OPEN' }, data: { status: s.result } });
          if (moved.count === 1 && credit > 0n) await tx.levEntry.update({ where: { id: b.entryId }, data: { chips: { increment: credit } } });
        });
      }
    }
  }

  // ───────────────────────── concursos ─────────────────────────

  async createGame(input: CreateGameInput) {
    const spec = MODE_SPEC[input.mode];
    const op = await this.db.operator.findUnique({ where: { id: input.operatorId }, select: { defaultCurrency: true } });
    if (!op) throw new HttpError(404, 'NOT_FOUND', 'Operador no encontrado');
    if (input.entry < 0n) throw new HttpError(400, 'BAD_REQUEST', 'La entrada no puede ser negativa');
    const closeAt = new Date(this.now().getTime() + Math.max(1, input.startsInMin ?? 10) * MIN);
    const endsAt = new Date(closeAt.getTime() + (input.durationMin ?? spec.durationMin) * MIN);
    const real = await this.realFeed();
    if (!real) await this.ensureFixtures(endsAt);
    // Menú: partidos que empiezan durante el concurso y alcanzan a terminar antes de que cierre (reales si hay feed).
    const events = (await this.db.levEvent.findMany({
      where: { status: 'SCHEDULED', source: real ? 'api-football' : 'sim', startsAt: { gte: closeAt, lt: endsAt }, ...(input.sport ? { sport: input.sport } : {}) },
      orderBy: { startsAt: 'asc' },
    })).filter((e) => e.endsAt <= endsAt);
    if (!events.length) throw new HttpError(409, 'NO_EVENTS', real ? 'No hay partidos reales que empiecen y terminen en ese horario: amplía la duración (un partido dura unas 2 horas) o prueba más tarde' : 'No hay partidos para ese horario');
    const id = randomUUID();
    const maxPlayers = Math.min(spec.maxPlayers, Math.max(spec.minPlayers, input.maxPlayers ?? spec.maxPlayers));
    let code: string | null = null;
    if (input.mode === 'FRIENDS') {
      for (let i = 0; i < 10 && !code; i++) {
        const c = roomCode(this.opts.rand);
        if (!(await this.db.levGame.findFirst({ where: { roomCode: c, status: { in: ['OPEN', 'RUNNING'] } } }))) code = c;
      }
    }
    await this.db.$transaction([
      this.db.levGame.create({
        data: {
          id, operatorId: input.operatorId, mode: input.mode, title: input.title.trim().slice(0, 80), currency: op.defaultCurrency, entry: input.entry, rakePpm: RAKE_PPM,
          curve: input.entry === 0n ? 'NONE' : spec.curve, minBets: spec.minBets, maxBets: spec.maxBets, minPlayers: spec.minPlayers, maxPlayers,
          roomCode: code, createdBy: input.createdBy ?? null, entriesCloseAt: closeAt, endsAt,
        },
      }),
      this.db.levGameEvent.createMany({ data: events.map((e) => ({ gameId: id, eventId: e.id })) }),
    ]);
    return this.db.levGame.findUniqueOrThrow({ where: { id } });
  }

  private async gameFor(operatorId: string, gameId: string) {
    const g = await this.db.levGame.findUnique({ where: { id: gameId } });
    if (!g || g.operatorId !== operatorId) throw new HttpError(404, 'NOT_FOUND', 'Concurso no encontrado');
    return g;
  }

  /** Inscripción: cobra la entrada (idempotente) y entrega las fichas iniciales. */
  async join(operatorId: string, playerId: string, gameId: string) {
    const g = await this.gameFor(operatorId, gameId);
    if (g.status !== 'OPEN' || g.entriesCloseAt <= this.now()) throw new HttpError(409, 'CLOSED', 'Las inscripciones de este concurso ya cerraron');
    const existing = await this.db.levEntry.findUnique({ where: { gameId_playerId: { gameId, playerId } } });
    if (existing) return existing;
    if ((await this.db.levEntry.count({ where: { gameId } })) >= g.maxPlayers) throw new HttpError(409, 'FULL', 'El concurso está lleno');
    const entryId = randomUUID();
    const key = `lev:join:${gameId}:${playerId}`;
    if (g.entry > 0n) {
      try {
        await this.wallet.debit({ operatorId, playerId, currency: g.currency, amount: g.entry, idempotencyKey: key, reason: 'TOURNAMENT_BUYIN', ref: { provider: 'leviathan', gameId, roundId: entryId } });
      } catch (e) {
        if (isWalletError(e, 'INSUFFICIENT_FUNDS')) throw new HttpError(402, 'INSUFFICIENT_FUNDS', 'Saldo insuficiente para la entrada');
        throw e;
      }
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const entry = await tx.levEntry.create({ data: { id: entryId, gameId, playerId, chips: OPENING_CHIPS } });
        const moved = await tx.levGame.updateMany({ where: { id: gameId, status: 'OPEN' }, data: { pot: { increment: g.entry } } });
        if (moved.count !== 1) throw new HttpError(409, 'CLOSED', 'Las inscripciones de este concurso ya cerraron');
        return entry;
      });
    } catch (e) {
      // No quedó inscrito: se devuelve la entrada cobrada.
      if (g.entry > 0n) await this.wallet.credit({ operatorId, playerId, currency: g.currency, amount: g.entry, idempotencyKey: `${key}:revert`, reason: 'REFUND', ref: { provider: 'leviathan', gameId } }).catch(() => undefined);
      const dup = await this.db.levEntry.findUnique({ where: { gameId_playerId: { gameId, playerId } } });
      if (dup) return dup;
      throw e;
    }
  }

  async joinByCode(operatorId: string, playerId: string, code: string) {
    const g = await this.db.levGame.findFirst({ where: { roomCode: code.toUpperCase(), operatorId, status: { in: ['OPEN', 'RUNNING'] } } });
    if (!g) throw new HttpError(404, 'NOT_FOUND', 'No hay una sala abierta con ese código');
    return { game: g, entry: await this.join(operatorId, playerId, g.id) };
  }

  /** Apuesta en fichas a la cuota vigente; si la cuota cambió, se avisa con la nueva. */
  async placeBet(operatorId: string, playerId: string, gameId: string, b: { selectionId: string; stake: bigint; oddsE2: number }) {
    const g = await this.gameFor(operatorId, gameId);
    const now = this.now();
    if (g.status !== 'RUNNING' || g.endsAt <= now) throw new HttpError(409, 'NOT_RUNNING', g.status === 'OPEN' ? 'El concurso todavía no empieza' : 'El concurso ya cerró');
    if (b.stake <= 0n) throw new HttpError(400, 'BAD_REQUEST', 'La apuesta debe ser mayor que cero');
    const entry = await this.db.levEntry.findUnique({ where: { gameId_playerId: { gameId, playerId } } });
    if (!entry) throw new HttpError(403, 'NOT_JOINED', 'No estás inscrito en este concurso');
    const sel = await this.db.levSelection.findUnique({ where: { id: b.selectionId } });
    const inMenu = sel && (await this.db.levGameEvent.findUnique({ where: { gameId_eventId: { gameId, eventId: sel.eventId } } }));
    const ev = sel && (await this.db.levEvent.findUnique({ where: { id: sel.eventId } }));
    if (!sel || !inMenu || !ev) throw new HttpError(404, 'NOT_FOUND', 'Esa selección no está en este concurso');
    if (ev.status !== 'SCHEDULED' || ev.startsAt <= now || sel.result !== 'OPEN') throw new HttpError(409, 'MARKET_CLOSED', 'Ese partido ya empezó: no admite apuestas');
    if (sel.oddsE2 !== b.oddsE2) throw new HttpError(422, 'ODDS_MOVED', 'La cuota cambió', { oddsE2: sel.oddsE2 });
    return this.db.$transaction(async (tx) => {
      const moved = await tx.levEntry.updateMany({ where: { id: entry.id, chips: { gte: b.stake }, bets: { lt: g.maxBets } }, data: { chips: { decrement: b.stake }, bets: { increment: 1 } } });
      if (moved.count !== 1) throw new HttpError(409, 'CANNOT_BET', entry.bets >= g.maxBets ? `Llegaste al máximo de ${g.maxBets} apuestas` : 'No tienes fichas suficientes');
      return tx.levBet.create({ data: { id: randomUUID(), gameId, entryId: entry.id, selectionId: sel.id, stake: b.stake, oddsE2: sel.oddsE2, returnChips: betReturn(b.stake, sel.oddsE2) } });
    });
  }

  /** Cancelación: devuelve la entrada completa a cada jugador (sin comisión). */
  async cancel(gameId: string, reason: string) {
    const moved = await this.db.levGame.updateMany({ where: { id: gameId, status: { in: ['OPEN', 'RUNNING', 'SETTLING'] } }, data: { status: 'CANCELLED', cancelReason: reason } });
    const g = await this.db.levGame.findUniqueOrThrow({ where: { id: gameId } });
    if (moved.count !== 1 && g.status !== 'CANCELLED') throw new HttpError(409, 'FINAL', 'El concurso ya terminó');
    if (g.entry > 0n) {
      for (const e of await this.db.levEntry.findMany({ where: { gameId } })) {
        await this.wallet.credit({ operatorId: g.operatorId, playerId: e.playerId, currency: g.currency, amount: g.entry, idempotencyKey: `lev:refund:${e.id}`, reason: 'REFUND', ref: { provider: 'leviathan', gameId, roundId: e.id } });
      }
    }
    return g;
  }

  /** Reparte el pozo: comisión, curva por posición y resto mayor. Los premios se acreditan de forma idempotente. */
  async settleGame(gameId: string) {
    const g = await this.db.levGame.findUniqueOrThrow({ where: { id: gameId } });
    if (g.status !== 'SETTLING') return g;
    const entries = await this.db.levEntry.findMany({ where: { gameId } });
    const out = settle(entries.map((e) => ({ entryId: e.id, playerId: e.playerId, chips: e.chips, bets: e.bets, joinedAt: e.joinedAt })), {
      pot: g.pot, rakePpm: g.rakePpm, curve: g.curve as 'TOP_3_60_25_15' | 'TOP_20_PCT_LINEAR' | 'NONE', minBets: g.minBets, maxBets: g.maxBets,
    });
    for (const r of out.results) {
      if (r.prize > 0n) {
        await this.wallet.credit({ operatorId: g.operatorId, playerId: r.playerId, currency: g.currency, amount: r.prize, idempotencyKey: `lev:prize:${r.entryId}`, reason: 'TOURNAMENT_PRIZE', ref: { provider: 'leviathan', gameId, roundId: r.entryId } });
      }
    }
    await this.db.$transaction([
      ...out.results.map((r) => this.db.levEntry.update({ where: { id: r.entryId }, data: { rank: r.rank, qualified: r.qualified, prize: r.prize } })),
      // El residuo de la curva (nadie calificó) queda para la casa, junto al de redondeo.
      this.db.levGame.updateMany({ where: { id: gameId, status: 'SETTLING' }, data: { status: 'SETTLED', rake: out.rake, pool: out.pool, residue: out.residue, settledAt: this.now() } }),
    ]);
    return this.db.levGame.findUniqueOrThrow({ where: { id: gameId } });
  }

  /** Arranca el barrido periódico (stop() lo detiene al cerrar la app). */
  start(ms: number) {
    if (this.timer || !(ms > 0)) return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Barrido: feed simulado, arranque/cancelación por falta de jugadores, cierre y reparto. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const real = await this.realFeed();
      if (real) await this.syncReal(real);
      else await this.ensureFixtures();
      await this.advanceEvents();
      const now = this.now();
      for (const g of await this.db.levGame.findMany({ where: { status: 'OPEN', entriesCloseAt: { lte: now } } })) {
        const n = await this.db.levEntry.count({ where: { gameId: g.id } });
        if (n >= g.minPlayers) await this.db.levGame.updateMany({ where: { id: g.id, status: 'OPEN' }, data: { status: 'RUNNING' } });
        else await this.cancel(g.id, 'INSUFFICIENT_PLAYERS');
      }
      await this.db.levGame.updateMany({ where: { status: 'RUNNING', endsAt: { lte: now } }, data: { status: 'SETTLING' } });
      for (const g of await this.db.levGame.findMany({ where: { status: 'SETTLING' } })) {
        const open = await this.db.levBet.count({ where: { gameId: g.id, status: 'OPEN' } });
        if (open && now.getTime() - g.endsAt.getTime() > STALL_VOID_MIN * MIN) {
          // Partidos sin resultado demasiado tiempo: se anulan esas apuestas (devuelven las fichas) y se reparte.
          for (const b of await this.db.levBet.findMany({ where: { gameId: g.id, status: 'OPEN' } })) {
            await this.db.$transaction(async (tx) => {
              const m = await tx.levBet.updateMany({ where: { id: b.id, status: 'OPEN' }, data: { status: 'VOID' } });
              if (m.count === 1) await tx.levEntry.update({ where: { id: b.entryId }, data: { chips: { increment: b.stake } } });
            });
          }
        } else if (open) continue;
        await this.settleGame(g.id);
      }
      if (now.getTime() - this.lastAuto >= 5 * MIN) {
        this.lastAuto = now.getTime();
        await this.autoSchedule();
      }
    } catch (e) {
      this.opts.logger.error('[leviathan] barrido', { error: (e as Error).message });
    } finally {
      this.ticking = false;
    }
  }

  // ───────────────────────── concursos automáticos ─────────────────────────

  async settings(operatorId: string) {
    return (await this.db.levSettings.findUnique({ where: { operatorId } })) ?? { operatorId, autoEnabled: false, autoEntry: 0n, autoDurationMin: 360, autoLeadMin: 60 };
  }

  async updateSettings(operatorId: string, p: { autoEnabled?: boolean; autoEntry?: bigint; autoDurationMin?: number; autoLeadMin?: number }) {
    const s = await this.db.levSettings.upsert({ where: { operatorId }, create: { operatorId, ...p }, update: p });
    if (s.autoEnabled) await this.autoSchedule([operatorId]);
    return s;
  }

  /** Mantiene un concurso rápido abierto en cada casino que lo activó (si hay partidos para armarlo). */
  async autoSchedule(only?: string[]) {
    const all = await this.db.levSettings.findMany({ where: { autoEnabled: true, ...(only ? { operatorId: { in: only } } : {}) } });
    for (const s of all) {
      if (await this.db.levGame.count({ where: { operatorId: s.operatorId, mode: 'QUICK', status: 'OPEN' } })) continue;
      const start = new Date(this.now().getTime() + s.autoLeadMin * MIN);
      // Hora de Colombia para el nombre (mañana, tarde o noche).
      const h = (start.getUTCHours() + 19) % 24;
      const title = `⚔️ Gran Leviathan de la ${h < 12 ? 'mañana' : h < 18 ? 'tarde' : 'noche'}`;
      try {
        await this.createGame({ operatorId: s.operatorId, mode: 'QUICK', title, entry: s.autoEntry, startsInMin: s.autoLeadMin, durationMin: s.autoDurationMin, createdBy: 'auto' });
      } catch (e) {
        if (!(e instanceof HttpError && e.code === 'NO_EVENTS')) this.opts.logger.warn('[leviathan] concurso automático', { operatorId: s.operatorId, error: (e as Error).message });
      }
    }
  }

  /** Próximos partidos apostables (los del feed activo), para mostrar aunque no haya concurso abierto. */
  async upcoming(limit = 8) {
    const real = await this.realFeed();
    const events = await this.db.levEvent.findMany({ where: { status: 'SCHEDULED', source: real ? 'api-football' : 'sim', startsAt: { gt: this.now() } }, orderBy: { startsAt: 'asc' }, take: limit });
    const sels = await this.db.levSelection.findMany({ where: { eventId: { in: events.map((e) => e.id) }, market: 'MATCH_RESULT' } });
    return events.map((e) => ({ id: e.id, sport: e.sport, league: e.league, home: e.home, away: e.away, startsAt: e.startsAt, real: e.source !== 'sim', odds: sels.filter((s) => s.eventId === e.id).map((s) => ({ key: s.key, label: s.label, oddsE2: s.oddsE2 })) }));
  }

  // ───────────────────────── vistas ─────────────────────────

  private async summary(g: { id: string; [k: string]: unknown }) {
    const players = await this.db.levEntry.count({ where: { gameId: g.id } });
    return { ...g, players };
  }

  /** Lobby: concursos públicos abiertos o en juego del casino. */
  async lobby(operatorId: string) {
    const games = await this.db.levGame.findMany({ where: { operatorId, mode: 'QUICK', status: { in: ['OPEN', 'RUNNING'] } }, orderBy: { entriesCloseAt: 'asc' }, take: 50 });
    return Promise.all(games.map(async (g) => {
      // Muestra de partidos (los próximos) para animar a entrar desde el lobby.
      const links = await this.db.levGameEvent.findMany({ where: { gameId: g.id } });
      const evs = await this.db.levEvent.findMany({ where: { id: { in: links.map((l) => l.eventId) } }, orderBy: { startsAt: 'asc' }, take: 4, select: { home: true, away: true, league: true, startsAt: true } });
      return { ...(await this.summary(g)), events: evs, eventCount: links.length };
    }));
  }

  async myGames(operatorId: string, playerId: string) {
    const entries = await this.db.levEntry.findMany({ where: { playerId }, orderBy: { joinedAt: 'desc' }, take: 50 });
    const games = await this.db.levGame.findMany({ where: { id: { in: entries.map((e) => e.gameId) }, operatorId } });
    const byId = new Map(games.map((g) => [g.id, g]));
    return Promise.all(entries.filter((e) => byId.has(e.gameId)).map(async (e) => ({ ...(await this.summary(byId.get(e.gameId)!)), me: e })));
  }

  /** Detalle: partidos con cuotas, mi inscripción y apuestas, y la tabla. */
  async detail(operatorId: string, gameId: string, playerId?: string) {
    const g = await this.gameFor(operatorId, gameId);
    const links = await this.db.levGameEvent.findMany({ where: { gameId } });
    const events = await this.db.levEvent.findMany({ where: { id: { in: links.map((l) => l.eventId) } }, orderBy: { startsAt: 'asc' } });
    const sels = await this.db.levSelection.findMany({ where: { eventId: { in: events.map((e) => e.id) } } });
    const entries = await this.db.levEntry.findMany({ where: { gameId } });
    const ranked = [...entries].sort((a, b) => (a.chips === b.chips ? a.joinedAt.getTime() - b.joinedAt.getTime() : a.chips > b.chips ? -1 : 1));
    const me = playerId ? entries.find((e) => e.playerId === playerId) ?? null : null;
    const myBets = me ? await this.db.levBet.findMany({ where: { entryId: me.id }, orderBy: { createdAt: 'desc' } }) : [];
    // En la tabla se muestra el usuario (o el correo enmascarado), nunca el id interno de otros jugadores.
    const users = await this.db.user.findMany({ where: { id: { in: ranked.slice(0, 50).map((e) => e.playerId).filter((id) => /^[0-9a-f-]{36}$/i.test(id)) } }, select: { id: true, username: true, email: true } });
    const alias = new Map(users.map((u) => [u.id, u.username || (u.email ? `${u.email.slice(0, 3)}***` : 'Jugador')]));
    return {
      game: { ...g, players: entries.length },
      events: events.map((e) => ({ ...e, selections: sels.filter((s) => s.eventId === e.id) })),
      me,
      myBets,
      leaderboard: ranked.slice(0, 50).map((e, i) => ({ position: e.rank ?? i + 1, name: alias.get(e.playerId) ?? 'Jugador', chips: e.chips, bets: e.bets, prize: e.prize, isMe: e.playerId === playerId })),
    };
  }

  async adminList(operatorId: string) {
    const games = await this.db.levGame.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return Promise.all(games.map((g) => this.summary(g)));
  }
}
