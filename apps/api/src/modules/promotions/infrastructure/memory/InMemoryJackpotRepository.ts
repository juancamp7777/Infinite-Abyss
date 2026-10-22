import { randomUUID } from 'crypto';
import type { Jackpot, JackpotContribution, JackpotLevelKey, JackpotSeedFunding, JackpotWin } from '../../domain/jackpot';
import type {
  ContributionHooks,
  ContributionInput,
  ContributionResult,
  JackpotPatch,
  JackpotReport,
  JackpotRepository,
  NewJackpot,
} from '../../application/ports';
import { KeyedMutex } from '../KeyedMutex';

const clone = <T>(v: T): T => structuredClone(v);

/** Jackpots en memoria. Las operaciones sobre un mismo pozo se serializan por jackpotId. */
export class InMemoryJackpotRepository implements JackpotRepository {
  private readonly jackpots = new Map<string, Jackpot>();
  private readonly contributions: JackpotContribution[] = [];
  private readonly contributionKeys = new Set<string>();
  private readonly seeds: JackpotSeedFunding[] = [];
  private readonly wins = new Map<string, JackpotWin>();
  private readonly mutex = new KeyedMutex();

  async create(j: NewJackpot): Promise<Jackpot> {
    const now = new Date();
    const jp: Jackpot = { ...clone(j), id: randomUUID(), createdAt: now, updatedAt: now };
    this.jackpots.set(jp.id, jp);
    for (const l of jp.levels) {
      this.seeds.push({ id: randomUUID(), jackpotId: jp.id, levelKey: l.key, amount: l.currentAmount, reason: 'INITIAL', createdAt: now });
    }
    return clone(jp);
  }

  async update(id: string, patch: JackpotPatch): Promise<Jackpot | null> {
    return this.mutex.run(id, () => {
      const j = this.jackpots.get(id);
      if (!j) return null;
      const { levels, ...rest } = clone(patch);
      Object.assign(j, rest, { updatedAt: new Date() });
      if (levels) {
        for (const cfg of levels) {
          const l = j.levels.find((x) => x.key === cfg.key);
          if (!l) continue;
          l.seedAmount = cfg.seedAmount;
          l.shareBps = cfg.shareBps;
          l.triggerChancePpm = cfg.triggerChancePpm;
          if (l.mustDropBy !== cfg.mustDropBy) {
            l.mustDropBy = cfg.mustDropBy;
            // El punto oculto se recalcula en el próximo reseed; si ya no aplica se elimina.
            if (cfg.mustDropBy == null) l.dropPoint = null;
            else if (l.dropPoint == null || l.dropPoint > cfg.mustDropBy) l.dropPoint = cfg.mustDropBy;
          }
        }
      }
      return clone(j);
    });
  }

  async get(id: string): Promise<Jackpot | null> {
    const j = this.jackpots.get(id);
    return j ? clone(j) : null;
  }

  async list(operatorId?: string): Promise<Jackpot[]> {
    return [...this.jackpots.values()].filter((j) => !operatorId || j.operatorId === operatorId).map(clone);
  }

  async contribute(input: ContributionInput, hooks: ContributionHooks): Promise<ContributionResult> {
    return this.mutex.run(input.jackpotId, () => {
      const j = this.jackpots.get(input.jackpotId);
      if (!j) return { duplicate: false, wins: [], jackpot: null };
      const key = `${input.jackpotId}\u0000${input.roundId}`;
      if (this.contributionKeys.has(key)) {
        const pending = [...this.wins.values()].filter((w) => w.jackpotId === j.id && w.roundId === input.roundId && w.status === 'PENDING');
        return { duplicate: true, wins: pending.map(clone), jackpot: clone(j) };
      }
      const now = new Date();
      const { total, perLevel } = hooks.split(clone(j));
      for (const l of j.levels) l.currentAmount += perLevel[l.key] ?? 0n;
      this.contributionKeys.add(key);
      this.contributions.push({
        id: randomUUID(),
        jackpotId: j.id,
        operatorId: input.operatorId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        betAmount: input.betAmount,
        amount: total,
        perLevel: clone(perLevel),
        createdAt: now,
      });
      const newWins: JackpotWin[] = [];
      for (const d of hooks.decide(clone(j.levels))) {
        const l = j.levels.find((x) => x.key === d.key);
        if (!l) continue;
        const win: JackpotWin = {
          id: randomUUID(),
          jackpotId: j.id,
          operatorId: input.operatorId,
          playerId: input.playerId,
          currency: input.currency,
          levelKey: l.key,
          roundId: input.roundId,
          gameId: input.gameId,
          amount: l.currentAmount,
          status: 'PENDING',
          txId: null,
          createdAt: now,
          paidAt: null,
        };
        this.wins.set(win.id, win);
        newWins.push(clone(win));
        l.currentAmount = l.seedAmount;
        l.dropPoint = d.nextDropPoint;
        this.seeds.push({ id: randomUUID(), jackpotId: j.id, levelKey: l.key, amount: l.seedAmount, reason: 'RESEED', createdAt: now });
      }
      j.updatedAt = now;
      return { duplicate: false, wins: newWins, jackpot: clone(j) };
    });
  }

  async markWinPaid(winId: string, txId: string, at: Date): Promise<JackpotWin | null> {
    const w = this.wins.get(winId);
    if (!w) return null;
    if (w.status !== 'PAID') Object.assign(w, { status: 'PAID', txId, paidAt: at });
    return clone(w);
  }

  async listPendingWins(limit: number): Promise<JackpotWin[]> {
    return [...this.wins.values()].filter((w) => w.status === 'PENDING').slice(0, limit).map(clone);
  }

  async listWins(jackpotId: string, limit: number): Promise<JackpotWin[]> {
    return [...this.wins.values()]
      .filter((w) => w.jackpotId === jackpotId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async listContributions(jackpotId: string, limit: number): Promise<JackpotContribution[]> {
    return this.contributions.filter((c) => c.jackpotId === jackpotId).slice(-limit).reverse().map(clone);
  }

  async listSeedFunding(jackpotId: string): Promise<JackpotSeedFunding[]> {
    return this.seeds.filter((s) => s.jackpotId === jackpotId).map(clone);
  }

  async report(jackpotId: string): Promise<JackpotReport | null> {
    const j = this.jackpots.get(jackpotId);
    if (!j) return null;
    const levels = j.levels.map((l) => ({ key: l.key, contributions: 0n, seedFunding: 0n, payouts: 0n, current: l.currentAmount }));
    const byKey = new Map<JackpotLevelKey, (typeof levels)[number]>(levels.map((l) => [l.key, l]));
    for (const c of this.contributions) {
      if (c.jackpotId !== jackpotId) continue;
      for (const [k, v] of Object.entries(c.perLevel) as Array<[JackpotLevelKey, bigint]>) {
        const r = byKey.get(k);
        if (r) r.contributions += v;
      }
    }
    for (const s of this.seeds) if (s.jackpotId === jackpotId) byKey.get(s.levelKey)!.seedFunding += s.amount;
    let paidOut = 0n;
    let pending = 0n;
    let winsCount = 0;
    for (const w of this.wins.values()) {
      if (w.jackpotId !== jackpotId) continue;
      winsCount++;
      byKey.get(w.levelKey)!.payouts += w.amount;
      if (w.status === 'PAID') paidOut += w.amount;
      else pending += w.amount;
    }
    const sum = (f: (l: (typeof levels)[number]) => bigint) => levels.reduce((s, l) => s + f(l), 0n);
    return {
      jackpotId,
      contributions: sum((l) => l.contributions),
      seedFunding: sum((l) => l.seedFunding),
      payouts: sum((l) => l.payouts),
      paidOut,
      pendingPayouts: pending,
      pools: sum((l) => l.current),
      winsCount,
      levels,
    };
  }
}
