import { HttpError } from '../../shared/http/errors';
import type { DomainEvents } from '../../shared/events/EventBus';
import { COL, GamiContext, eventTime, payCredit } from './context';
import { Tournament, TournamentEntry } from '../domain/types';

export interface LeaderboardRow {
  rank: number;
  player: string;
  isMe: boolean;
  score: bigint;
}

const mask = (id: string): string => (id.length <= 6 ? id : `${id.slice(0, 3)}***${id.slice(-2)}`);

/** Torneos: inscripción (buy-in), puntaje en vivo (bet.settled), leaderboard por socket con throttle y cierre con premios. */
export class TournamentService {
  private lastSeq = 0;
  private readonly bcast = new Map<string, { last: number; timer?: NodeJS.Timeout; dirty: Set<string> }>();
  static readonly TOP = 50;
  static readonly THROTTLE_MS = 1000;

  constructor(private readonly ctx: GamiContext) {}

  private nextSeq(): number {
    this.lastSeq = Math.max(this.lastSeq + 1, this.ctx.clock() * 1000);
    return this.lastSeq;
  }

  derivedStatus(t: Tournament, now = this.ctx.clock()): 'scheduled' | 'active' | 'closing' | 'finished' | 'cancelled' {
    if (t.status === 'finished' || t.status === 'cancelled') return t.status;
    if (t.status === 'closing') return 'closing';
    if (now < t.startsAt) return 'scheduled';
    return now < t.endsAt ? 'active' : 'closing';
  }

  async get(op: string, id: string): Promise<Tournament> {
    const t = await this.ctx.store.get<Tournament>(COL.tournament, op, id);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'Torneo no encontrado');
    return t;
  }

  async list(op: string, player?: string) {
    const all = await this.ctx.store.list<Tournament>(COL.tournament, op);
    const out = [];
    for (const t of all.filter((x) => x.status !== 'cancelled')) {
      const entries = await this.ctx.store.list<TournamentEntry>(COL.entry, op, { idPrefix: `${t.id}:` });
      out.push({
        id: t.id,
        name: t.name,
        status: this.derivedStatus(t),
        metric: t.metric,
        startsAt: t.startsAt,
        endsAt: t.endsAt,
        minBet: t.minBet,
        buyIn: t.buyIn,
        currency: t.currency,
        gameIds: t.gameIds,
        categories: t.categories,
        prizes: t.prizes,
        players: entries.length,
        joined: player ? entries.some((e) => e.playerId === player) : false,
      });
    }
    return out.sort((a, b) => a.startsAt - b.startsAt);
  }

  async join(op: string, player: string, id: string) {
    const t = await this.get(op, id);
    const st = this.derivedStatus(t);
    if (st === 'finished' || st === 'cancelled' || st === 'closing') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'El torneo ya no admite inscripciones');
    const existing = await this.ctx.store.get<TournamentEntry>(COL.entry, op, `${id}:${player}`);
    if (existing) return { joined: true, alreadyJoined: true };
    if (this.ctx.compliance) {
      const c = await this.ctx.compliance.getStatus(op, player);
      if (c.selfExcluded) throw new HttpError(403, 'SELF_EXCLUDED', 'Jugador autoexcluido');
    }
    if (t.buyIn > 0n) {
      // Si no hay fondos, WalletError(INSUFFICIENT_FUNDS) sube a HTTP 402 y no se crea la inscripción.
      await this.ctx.wallet.debit({
        operatorId: op,
        playerId: player,
        currency: t.currency,
        amount: t.buyIn,
        idempotencyKey: `gami:tbuyin:${id}:${player}`,
        reason: 'TOURNAMENT_BUYIN',
        ref: { provider: 'nymfo-gamification', gameId: `tournament:${id}` },
      });
    }
    const entry: TournamentEntry = { playerId: player, tournamentId: id, joinedAt: this.ctx.clock(), wagered: 0n, score: 0n, reachedSeq: 0, rounds: 0 };
    const created = await this.ctx.store.putIfAbsent(COL.entry, op, `${id}:${player}`, entry, player);
    return { joined: true, alreadyJoined: !created };
  }

  private async ranking(op: string, id: string): Promise<TournamentEntry[]> {
    const entries = await this.ctx.store.list<TournamentEntry>(COL.entry, op, { idPrefix: `${id}:` });
    return entries
      .filter((e) => e.score > 0n)
      .sort((a, b) => (a.score === b.score ? a.reachedSeq - b.reachedSeq : a.score > b.score ? -1 : 1));
  }

  async leaderboard(op: string, id: string, player?: string) {
    const t = await this.get(op, id);
    const ranked = await this.ranking(op, id);
    const top: LeaderboardRow[] = ranked.slice(0, TournamentService.TOP).map((e, i) => ({ rank: i + 1, player: mask(e.playerId), isMe: e.playerId === player, score: e.score }));
    const idx = player ? ranked.findIndex((e) => e.playerId === player) : -1;
    return {
      tournamentId: id,
      status: this.derivedStatus(t),
      metric: t.metric,
      top,
      me: idx >= 0 ? { rank: idx + 1, score: ranked[idx].score } : null,
      totalPlayers: ranked.length,
      results: t.results ?? null,
    };
  }

  async onBetSettled(ev: DomainEvents['bet.settled']): Promise<void> {
    const op = ev.operatorId;
    const now = eventTime(this.ctx, ev.at);
    const tournaments = (await this.ctx.store.list<Tournament>(COL.tournament, op)).filter(
      (t) => (t.status === 'open') && now >= t.startsAt && now < t.endsAt,
    );
    for (const t of tournaments) {
      if (t.gameIds.length > 0 && !t.gameIds.includes(ev.gameId)) continue;
      if (t.categories.length > 0 && !t.categories.includes(String(ev.category))) continue;
      if (ev.amount < t.minBet) continue;
      const entryId = `${t.id}:${ev.playerId}`;
      if (!(await this.ctx.store.get(COL.entry, op, entryId))) continue;
      if (!(await this.ctx.store.putIfAbsent(COL.dedupe, op, `tscore:${t.id}:${ev.roundId}`, { at: now }, ev.playerId))) continue;
      const changed = await this.ctx.locks.run(`t:${t.id}`, async () => {
        const e = await this.ctx.store.get<TournamentEntry>(COL.entry, op, entryId);
        if (!e) return false;
        e.wagered += ev.amount;
        e.rounds += 1;
        let score = e.score;
        if (t.metric === 'highest_multiplier') {
          const m = BigInt(Math.round(ev.multiplier * 10000));
          if (m > score) score = m;
        } else if (t.metric === 'total_points') {
          score = e.wagered / (t.unitsPerPoint > 0n ? t.unitsPerPoint : 1n);
        } else {
          score = e.wagered;
        }
        const improved = score > e.score;
        if (improved) {
          e.score = score;
          e.reachedSeq = this.nextSeq();
        }
        await this.ctx.store.put(COL.entry, op, entryId, e, ev.playerId);
        return improved;
      });
      if (changed) this.markDirty(op, t.id, ev.playerId);
    }
  }

  // ---- Difusión con throttle (1/s por torneo) ----

  private markDirty(op: string, id: string, player: string): void {
    let b = this.bcast.get(id);
    if (!b) {
      b = { last: 0, dirty: new Set() };
      this.bcast.set(id, b);
    }
    b.dirty.add(player);
    const wait = b.last + TournamentService.THROTTLE_MS - this.ctx.clock();
    if (wait <= 0) {
      void this.broadcast(op, id);
    } else if (!b.timer) {
      b.timer = setTimeout(() => void this.broadcast(op, id), wait);
      b.timer.unref?.();
    }
  }

  /** Emite top 50 al room del torneo y la posición propia a los jugadores cuyo puntaje cambió. */
  async broadcast(op: string, id: string): Promise<void> {
    const b = this.bcast.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.timer = undefined;
    b.last = this.ctx.clock();
    const dirty = [...b.dirty];
    b.dirty.clear();
    try {
      const lb = await this.leaderboard(op, id);
      this.ctx.notifier.toTournament(id, 'tournament:leaderboard', { ...lb, at: b.last });
      const ranked = await this.ranking(op, id);
      for (const p of dirty) {
        const i = ranked.findIndex((e) => e.playerId === p);
        if (i >= 0) this.ctx.notifier.toPlayer(op, p, 'tournament:me', { tournamentId: id, rank: i + 1, score: ranked[i].score });
      }
    } catch (e) {
      this.ctx.logger.error('gamification: fallo al difundir leaderboard', { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---- Cierre ----

  /** Cierra los torneos vencidos y paga premios. Idempotente: repetir tick no duplica pagos. */
  async tick(now = this.ctx.clock()): Promise<number> {
    const all = await this.ctx.store.list<Tournament>(COL.tournament);
    let closed = 0;
    for (const t of all) {
      if ((t.status === 'open' || t.status === 'closing') && now >= t.endsAt) {
        if (await this.close(t.operatorId, t.id, now)) closed++;
      }
    }
    return closed;
  }

  private close(op: string, id: string, now: number): Promise<boolean> {
    return this.ctx.locks.run(`t:${id}`, async () => {
      const t = await this.ctx.store.get<Tournament>(COL.tournament, op, id);
      if (!t || t.status === 'finished' || t.status === 'cancelled') return false;
      if (!t.results) {
        const ranked = await this.ranking(op, id);
        t.results = [];
        for (const prize of [...t.prizes].sort((a, b) => a.position - b.position)) {
          const e = ranked[prize.position - 1];
          if (e) t.results.push({ position: prize.position, playerId: e.playerId, score: e.score, amount: prize.amount });
        }
        t.status = 'closing';
        await this.ctx.store.put(COL.tournament, op, id, t);
      }
      for (const r of t.results) {
        await payCredit(this.ctx, {
          op,
          player: r.playerId,
          currency: t.currency,
          amount: r.amount,
          reason: 'TOURNAMENT_PRIZE',
          key: `gami:tprize:${id}:${r.position}`,
          type: 'tournament_prize',
          gameId: `tournament:${id}`,
        });
        this.ctx.notifier.toPlayer(op, r.playerId, 'tournament:prize', { tournamentId: id, position: r.position, amount: r.amount });
      }
      t.status = 'finished';
      t.closedAt = now;
      await this.ctx.store.put(COL.tournament, op, id, t);
      this.ctx.notifier.toTournament(id, 'tournament:finished', { tournamentId: id, results: t.results.map((r) => ({ position: r.position, score: r.score, amount: r.amount })) });
      return true;
    });
  }

  /** Cancela y reembolsa buy-ins (credit REFUND idempotente). */
  async cancel(op: string, id: string): Promise<void> {
    await this.ctx.locks.run(`t:${id}`, async () => {
      const t = await this.get(op, id);
      if (t.status === 'finished') throw new HttpError(409, 'TOURNAMENT_CLOSED', 'El torneo ya finalizó');
      t.status = 'cancelled';
      await this.ctx.store.put(COL.tournament, op, id, t);
      if (t.buyIn > 0n) {
        const entries = await this.ctx.store.list<TournamentEntry>(COL.entry, op, { idPrefix: `${id}:` });
        for (const e of entries) {
          await payCredit(this.ctx, {
            op,
            player: e.playerId,
            currency: t.currency,
            amount: t.buyIn,
            reason: 'REFUND',
            key: `gami:trefund:${id}:${e.playerId}`,
            type: 'tournament_refund',
          });
        }
      }
    });
  }
}
