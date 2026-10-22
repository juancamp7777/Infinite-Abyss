import { HttpError } from '../../shared/http/errors';
import type { DomainEvents } from '../../shared/events/EventBus';
import { COL, GamiContext, eventTime, loadSettings } from './context';
import type { RewardService } from './rewards';
import { Achievement, Mission, MissionProgress, PlayerStats, StreakState } from '../domain/types';
import { addDays, localDate, periodKey } from '../domain/periods';

const emptyStats = (): PlayerStats => ({ totalWagered: 0n, totalWon: 0n, rounds: 0, biggestMultiplier: 0, depositCount: 0, depositTotal: 0n, loginStreak: 0 });

/** Misiones, logros, estadísticas del jugador y racha de login. */
export class ProgressService {
  constructor(private readonly ctx: GamiContext, private readonly rewards: RewardService) {}

  private lock<T>(op: string, player: string, fn: () => Promise<T>): Promise<T> {
    return this.ctx.locks.run(`prog:${op}:${player}`, fn);
  }

  private async once(op: string, key: string, player: string): Promise<boolean> {
    return this.ctx.store.putIfAbsent(COL.dedupe, op, key, { at: this.ctx.clock() }, player);
  }

  private matches(m: Mission, ev: { category: string; gameId: string }): boolean {
    return (!m.category || m.category === ev.category) && (!m.gameId || m.gameId === ev.gameId);
  }

  private async addProgress(op: string, player: string, types: Mission['type'][], ev: { category: string; gameId: string }, amount: bigint, extra?: (m: Mission) => boolean): Promise<void> {
    const settings = await loadSettings(this.ctx, op);
    const missions = (await this.ctx.store.list<Mission>(COL.mission, op)).filter((m) => m.active && types.includes(m.type));
    for (const m of missions) {
      if (m.type !== 'deposit' && !this.matches(m, ev)) continue;
      if (extra && !extra(m)) continue;
      const id = `${m.id}:${player}:${periodKey(m.period, this.ctx.clock(), settings.timezone)}`;
      const cur = (await this.ctx.store.get<MissionProgress>(COL.missionProg, op, id)) ?? { progress: 0n };
      cur.progress += amount;
      await this.ctx.store.put(COL.missionProg, op, id, cur, player);
    }
  }

  async onBetPlaced(ev: DomainEvents['bet.placed']): Promise<void> {
    if (!(await this.once(ev.operatorId, `prog:placed:${ev.roundId}`, ev.playerId))) return;
    await this.lock(ev.operatorId, ev.playerId, async () => {
      const stats = (await this.ctx.store.get<PlayerStats>(COL.stats, ev.operatorId, ev.playerId)) ?? emptyStats();
      stats.totalWagered += ev.amount;
      stats.rounds += 1;
      await this.ctx.store.put(COL.stats, ev.operatorId, ev.playerId, stats, ev.playerId);
      const e = { category: String(ev.category), gameId: ev.gameId };
      await this.addProgress(ev.operatorId, ev.playerId, ['rounds'], e, 1n);
      if (!ev.isBonusMoney) await this.addProgress(ev.operatorId, ev.playerId, ['wager'], e, ev.amount);
      await this.evaluateAchievements(ev.operatorId, ev.playerId, stats);
    });
  }

  async onBetSettled(ev: DomainEvents['bet.settled']): Promise<void> {
    if (!(await this.once(ev.operatorId, `prog:settled:${ev.roundId}`, ev.playerId))) return;
    await this.lock(ev.operatorId, ev.playerId, async () => {
      const stats = (await this.ctx.store.get<PlayerStats>(COL.stats, ev.operatorId, ev.playerId)) ?? emptyStats();
      stats.totalWon += ev.win;
      if (ev.multiplier > stats.biggestMultiplier) stats.biggestMultiplier = ev.multiplier;
      await this.ctx.store.put(COL.stats, ev.operatorId, ev.playerId, stats, ev.playerId);
      const e = { category: String(ev.category), gameId: ev.gameId };
      await this.addProgress(ev.operatorId, ev.playerId, ['multiplier'], e, 1n, (m) => ev.multiplier >= (m.minMultiplier ?? 0));
      await this.evaluateAchievements(ev.operatorId, ev.playerId, stats);
    });
  }

  async onDeposit(ev: DomainEvents['deposit.completed']): Promise<void> {
    if (!(await this.once(ev.operatorId, `prog:deposit:${ev.txId}`, ev.playerId))) return;
    await this.lock(ev.operatorId, ev.playerId, async () => {
      const stats = (await this.ctx.store.get<PlayerStats>(COL.stats, ev.operatorId, ev.playerId)) ?? emptyStats();
      stats.depositCount += 1;
      stats.depositTotal += ev.amount;
      await this.ctx.store.put(COL.stats, ev.operatorId, ev.playerId, stats, ev.playerId);
      await this.addProgress(ev.operatorId, ev.playerId, ['deposit'], { category: '', gameId: '' }, ev.amount);
      await this.evaluateAchievements(ev.operatorId, ev.playerId, stats);
    });
  }

  // ---- Racha de login ----

  async onLogin(ev: DomainEvents['login']): Promise<void> {
    const op = ev.operatorId;
    const player = ev.playerId;
    await this.lock(op, player, async () => {
      const settings = await loadSettings(this.ctx, op);
      const today = localDate(eventTime(this.ctx, ev.at), settings.timezone);
      const st = (await this.ctx.store.get<StreakState>(COL.streak, op, player)) ?? { current: 0, best: 0 };
      if (st.lastDate === today) return;
      st.current = st.lastDate === addDays(today, -1) ? st.current + 1 : 1;
      st.best = Math.max(st.best, st.current);
      st.lastDate = today;
      await this.ctx.store.put(COL.streak, op, player, st, player);
      const cycle = Math.max(1, ...settings.streakRewards.map((r) => r.day));
      const day = ((st.current - 1) % cycle) + 1;
      for (const r of settings.streakRewards.filter((x) => x.day === day)) {
        await this.rewards.pay(op, player, r.reward, `gami:streak:${player}:${today}`, 'streak');
      }
      const stats = (await this.ctx.store.get<PlayerStats>(COL.stats, op, player)) ?? emptyStats();
      stats.loginStreak = Math.max(stats.loginStreak, st.current);
      await this.ctx.store.put(COL.stats, op, player, stats, player);
      await this.evaluateAchievements(op, player, stats);
    });
  }

  async streak(op: string, player: string) {
    const settings = await loadSettings(this.ctx, op);
    const today = localDate(this.ctx.clock(), settings.timezone);
    const st = (await this.ctx.store.get<StreakState>(COL.streak, op, player)) ?? { current: 0, best: 0 };
    const alive = st.lastDate === today || st.lastDate === addDays(today, -1);
    const current = alive ? st.current : 0;
    const cycle = Math.max(1, ...settings.streakRewards.map((r) => r.day));
    const nextDay = (current % cycle) + 1;
    return {
      current,
      best: st.best,
      lastDate: st.lastDate ?? null,
      loggedToday: st.lastDate === today,
      nextReward: settings.streakRewards.find((r) => r.day === nextDay) ?? null,
      rewards: settings.streakRewards,
    };
  }

  // ---- Misiones ----

  async listMissions(op: string, player: string) {
    const settings = await loadSettings(this.ctx, op);
    const missions = (await this.ctx.store.list<Mission>(COL.mission, op)).filter((m) => m.active);
    const out = [];
    for (const m of missions) {
      const period = periodKey(m.period, this.ctx.clock(), settings.timezone);
      const p = (await this.ctx.store.get<MissionProgress>(COL.missionProg, op, `${m.id}:${player}:${period}`)) ?? { progress: 0n };
      out.push({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        period: m.period,
        periodKey: period,
        type: m.type,
        target: m.target,
        progress: p.progress > m.target ? m.target : p.progress,
        completed: p.progress >= m.target,
        claimed: !!p.claimedAt,
        reward: m.reward,
      });
    }
    return out;
  }

  async claimMission(op: string, player: string, missionId: string) {
    const m = await this.ctx.store.get<Mission>(COL.mission, op, missionId);
    if (!m || !m.active) throw new HttpError(404, 'NOT_FOUND', 'Misión no encontrada');
    const settings = await loadSettings(this.ctx, op);
    const period = periodKey(m.period, this.ctx.clock(), settings.timezone);
    const id = `${m.id}:${player}:${period}`;
    const p = await this.ctx.store.get<MissionProgress>(COL.missionProg, op, id);
    if (!p || p.progress < m.target) throw new HttpError(409, 'MISSION_INCOMPLETE', 'La misión aún no está completa');
    if (p.claimedAt) throw new HttpError(409, 'ALREADY_CLAIMED', 'Recompensa ya reclamada');
    await this.rewards.pay(op, player, m.reward, `gami:mission:${m.id}:${player}:${period}`, 'mission');
    await this.lock(op, player, async () => {
      const fresh = (await this.ctx.store.get<MissionProgress>(COL.missionProg, op, id)) ?? p;
      fresh.claimedAt = this.ctx.clock();
      await this.ctx.store.put(COL.missionProg, op, id, fresh, player);
    });
    return { missionId: m.id, period, reward: m.reward };
  }

  // ---- Logros ----

  private metricValue(s: PlayerStats, metric: Achievement['criteria']['metric']): bigint | number {
    switch (metric) {
      case 'total_wagered': return s.totalWagered;
      case 'total_won': return s.totalWon;
      case 'deposit_total': return s.depositTotal;
      case 'rounds': return s.rounds;
      case 'biggest_multiplier': return s.biggestMultiplier;
      case 'login_streak': return s.loginStreak;
      case 'deposit_count': return s.depositCount;
    }
  }

  private reached(s: PlayerStats, a: Achievement): boolean {
    const v = this.metricValue(s, a.criteria.metric);
    return typeof v === 'bigint' ? v >= BigInt(a.criteria.value) : v >= Number(a.criteria.value);
  }

  private async evaluateAchievements(op: string, player: string, stats: PlayerStats): Promise<void> {
    const list = (await this.ctx.store.list<Achievement>(COL.achievement, op)).filter((a) => a.active);
    for (const a of list) {
      const uid = `${a.id}:${player}`;
      if (await this.ctx.store.get(COL.unlocked, op, uid)) continue;
      if (!this.reached(stats, a)) continue;
      if (a.reward) await this.rewards.pay(op, player, a.reward, `gami:ach:${a.id}:${player}`, 'achievement');
      const fresh = await this.ctx.store.putIfAbsent(COL.unlocked, op, uid, { at: this.ctx.clock() }, player);
      if (fresh) this.ctx.notifier.toPlayer(op, player, 'achievement:unlocked', { id: a.id, name: a.name, icon: a.icon ?? null });
    }
  }

  async listAchievements(op: string, player: string) {
    const stats = (await this.ctx.store.get<PlayerStats>(COL.stats, op, player)) ?? emptyStats();
    const list = (await this.ctx.store.list<Achievement>(COL.achievement, op)).filter((a) => a.active);
    const out = [];
    for (const a of list) {
      const u = await this.ctx.store.get<{ at: number }>(COL.unlocked, op, `${a.id}:${player}`);
      out.push({
        id: a.id,
        name: a.name,
        description: a.description ?? null,
        icon: a.icon ?? null,
        criteria: a.criteria,
        current: this.metricValue(stats, a.criteria.metric),
        unlocked: !!u,
        unlockedAt: u?.at ?? null,
        reward: a.reward ?? null,
      });
    }
    return out;
  }
}
