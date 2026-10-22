import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { HttpError } from '../../shared/http/errors';
import { isWalletError } from '../../shared/ports/WalletPort';
import { InMemoryDocStore } from '../infrastructure/DocStore';
import { GamificationService } from '../application/service';
import { COL, Notifier, Rng, saveSettings } from '../application/context';
import { Achievement, Mission, Tournament, WheelConfig, defaultSettings, validateWheel } from '../domain/types';

const OP = 'op-1';
const T0 = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Emitted {
  scope: string;
  event: string;
  payload: unknown;
}

function setup() {
  const env = { now: T0, rngQueue: [] as number[] };
  const wallet = new InMemoryWallet();
  const bus = new InMemoryEventBus();
  const emitted: Emitted[] = [];
  const notifier: Notifier = {
    toPlayer: (_o, p, event, payload) => void emitted.push({ scope: `player:${p}`, event, payload }),
    toTournament: (id, event, payload) => void emitted.push({ scope: `tournament:${id}`, event, payload }),
  };
  const rng: Rng = { int: (n) => (env.rngQueue.length ? env.rngQueue.shift()! % n : 0) };
  const store = new InMemoryDocStore();
  const svc = new GamificationService({ store, wallet, bus, logger: { info() {}, warn() {}, error() {} }, notifier, clock: () => env.now, rng });
  svc.start(0);
  const iso = () => new Date(env.now).toISOString();
  const placed = async (player: string, roundId: string, amount: bigint, category = 'slots', gameId = 'g1') => {
    await bus.publish('bet.placed', { operatorId: OP, playerId: player, at: iso(), amount, currency: 'USD', gameId, provider: 'nymfo', category, roundId });
    await bus.drain();
  };
  const settled = async (player: string, roundId: string, multiplier: number, amount = 1000n, category = 'slots', gameId = 'g1') => {
    await bus.publish('bet.settled', { operatorId: OP, playerId: player, at: iso(), amount, win: BigInt(Math.round(Number(amount) * multiplier)), currency: 'USD', gameId, provider: 'nymfo', category, roundId, multiplier });
    await bus.drain();
  };
  const login = async (player: string) => {
    await bus.publish('login', { operatorId: OP, playerId: player, at: iso() });
    await bus.drain();
  };
  const total = async (player: string) => {
    const b = await wallet.getBalance(OP, player, 'USD');
    return b.cash + b.bonus;
  };
  return { env, wallet, bus, svc, store, emitted, placed, settled, login, total };
}

let s: ReturnType<typeof setup>;
beforeEach(() => {
  s = setup();
});

describe('VIP', () => {
  it('suma puntos por apuesta, sube de nivel, paga el bono y emite vip:levelup; dedupe por roundId', async () => {
    await s.placed('p1', 'r1', 150_000n); // 1500 puntos → Silver (1000)
    await s.placed('p1', 'r1', 150_000n); // duplicado
    const st = await s.svc.vip.state(OP, 'p1');
    expect(st.points).toBe(1500n);
    expect(st.level.id).toBe('silver');
    expect(st.next?.id).toBe('gold');
    expect(st.progressPct).toBe(12.5); // (1500-1000)/(5000-1000)
    expect(await s.total('p1')).toBe(500n); // bono de subida de Silver
    const ev = s.emitted.filter((e) => e.event === 'vip:levelup');
    expect(ev).toHaveLength(1);
    expect(ev[0].scope).toBe('player:p1');
  });

  it('puntos configurables por categoría con resto acumulado', async () => {
    await saveSettings(s.svc.ctx, OP, { unitsPerPoint: { default: 100n, originals: 1000n } });
    await s.placed('p1', 'r1', 600n, 'originals');
    await s.placed('p1', 'r2', 600n, 'originals'); // 1200 → 1 punto, resto 200
    expect((await s.svc.vip.state(OP, 'p1')).points).toBe(1n);
  });

  it('rakeback acumulado se reclama una sola vez por periodo', async () => {
    await s.placed('p1', 'r1', 1_000_000n); // Bronze: 1e6 × 350bps × 500bps = 1750
    expect((await s.svc.vip.state(OP, 'p1')).rakeback.pending).toBe(1750n);
    const before = await s.total('p1');
    const c = await s.svc.vip.claimRakeback(OP, 'p1');
    expect(c.amount).toBe(1750n);
    expect((await s.total('p1')) - before).toBe(1750n);
    await s.placed('p1', 'r2', 100_000n); // acumula de nuevo (ya es Gold)
    await expect(s.svc.vip.claimRakeback(OP, 'p1')).rejects.toMatchObject({ code: 'RAKEBACK_ALREADY_CLAIMED' });
    s.env.now += 7 * DAY; // semana siguiente
    const c2 = await s.svc.vip.claimRakeback(OP, 'p1');
    expect(c2.amount).toBeGreaterThan(0n);
    await expect(s.svc.vip.claimRakeback(OP, 'p1')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('Misiones, racha y logros', () => {
  const mission: Mission = {
    id: 'm1', operatorId: OP, name: 'Apuesta 1000', period: 'daily', type: 'wager', target: 1000n, category: 'slots',
    reward: { type: 'points', points: 20n }, active: true,
  };

  it('progresa, se reclama una vez y reinicia al cambiar el día en la zona del operador', async () => {
    await saveSettings(s.svc.ctx, OP, { timezone: 'America/Bogota' });
    await s.store.put(COL.mission, OP, 'm1', mission);
    s.env.now = Date.parse('2026-10-20T03:00:00Z'); // 22:00 del 19 en Bogotá
    await s.placed('p1', 'a', 600n);
    await s.placed('p1', 'b', 600n, 'originals'); // otra categoría: no cuenta
    let m = (await s.svc.progress.listMissions(OP, 'p1'))[0];
    expect(m.progress).toBe(600n);
    expect(m.completed).toBe(false);
    await expect(s.svc.progress.claimMission(OP, 'p1', 'm1')).rejects.toMatchObject({ code: 'MISSION_INCOMPLETE' });
    await s.placed('p1', 'c', 600n);
    await s.svc.progress.claimMission(OP, 'p1', 'm1');
    await expect(s.svc.progress.claimMission(OP, 'p1', 'm1')).rejects.toMatchObject({ code: 'ALREADY_CLAIMED' });
    const pts = (await s.svc.vip.state(OP, 'p1')).points;
    expect(pts).toBeGreaterThanOrEqual(20n);
    s.env.now = Date.parse('2026-10-20T06:00:00Z'); // 01:00 del 20 en Bogotá → nuevo día
    m = (await s.svc.progress.listMissions(OP, 'p1'))[0];
    expect(m.progress).toBe(0n);
    expect(m.claimed).toBe(false);
  });

  it('misión de multiplicador y logro desbloqueado con recompensa', async () => {
    const mm: Mission = { ...mission, id: 'm2', type: 'multiplier', target: 1n, minMultiplier: 50, category: undefined };
    const ach: Achievement = { id: 'a1', operatorId: OP, name: 'Gran ganador', criteria: { metric: 'biggest_multiplier', value: 100 }, reward: { type: 'bonus', amount: 300n }, active: true };
    await s.store.put(COL.mission, OP, 'm2', mm);
    await s.store.put(COL.achievement, OP, 'a1', ach);
    await s.settled('p1', 'x1', 20);
    expect((await s.svc.progress.listMissions(OP, 'p1'))[0].completed).toBe(false);
    await s.settled('p1', 'x2', 150);
    expect((await s.svc.progress.listMissions(OP, 'p1'))[0].completed).toBe(true);
    expect((await s.svc.progress.listAchievements(OP, 'p1'))[0].unlocked).toBe(true);
    expect(await s.total('p1')).toBe(300n);
    await s.settled('p1', 'x3', 200); // no se paga dos veces
    expect(await s.total('p1')).toBe(300n);
  });

  it('la racha de login se rompe al saltar un día', async () => {
    await s.login('p1');
    await s.login('p1'); // mismo día: no suma
    s.env.now += DAY;
    await s.login('p1');
    expect((await s.svc.progress.streak(OP, 'p1')).current).toBe(2);
    s.env.now += 2 * DAY; // salta un día
    await s.login('p1');
    const st = await s.svc.progress.streak(OP, 'p1');
    expect(st.current).toBe(1);
    expect(st.best).toBe(2);
  });
});

describe('Rueda diaria', () => {
  it('un giro cada 24 h y pago idempotente', async () => {
    s.env.rngQueue.push(0); // p10: 10 puntos
    const r1 = await s.svc.wheel.spin(OP, 'p1');
    expect(r1.prize.id).toBe('p10');
    await expect(s.svc.wheel.spin(OP, 'p1')).rejects.toMatchObject({ status: 429, code: 'WHEEL_COOLDOWN' });
    s.env.now += 23 * HOUR;
    await expect(s.svc.wheel.spin(OP, 'p1')).rejects.toMatchObject({ status: 429 });
    s.env.rngQueue.push(70); // 70 → bono pequeño (40+20=60 ≤ 70 < 85)
    s.env.now += HOUR + 1;
    const r2 = await s.svc.wheel.spin(OP, 'p1');
    expect(r2.prize.id).toBe('b100');
    expect(await s.total('p1')).toBe(100n);
    const payouts = await s.store.list(COL.payout, OP, { playerId: 'p1' });
    expect(payouts).toHaveLength(2);
  });

  it('un pago pendiente se reanuda sin duplicar', async () => {
    s.env.rngQueue.push(70);
    await s.svc.wheel.spin(OP, 'p1');
    const st = (await s.store.get<{ paid: boolean }>(COL.wheel, OP, 'p1'))!;
    await s.store.put(COL.wheel, OP, 'p1', { ...st, paid: false }, 'p1'); // simula caída tras acreditar
    const r = await s.svc.wheel.spin(OP, 'p1');
    expect(r.resumed).toBe(true);
    expect(await s.total('p1')).toBe(100n);
  });

  it('valida el valor esperado máximo', () => {
    const w: WheelConfig = { ...defaultSettings().wheel, maxExpectedValue: 10n };
    expect(validateWheel(w)).toMatch(/valor esperado/);
    expect(validateWheel(defaultSettings().wheel)).toBeNull();
  });
});

describe('Torneos', () => {
  const base = (over: Partial<Tournament> = {}): Tournament => ({
    id: 't1', operatorId: OP, name: 'Copa', gameIds: [], categories: [], minBet: 0n,
    startsAt: T0 - HOUR, endsAt: T0 + HOUR, metric: 'highest_multiplier', unitsPerPoint: 100n, buyIn: 0n, currency: 'USD',
    prizes: [{ position: 1, amount: 1000n }, { position: 2, amount: 500n }, { position: 3, amount: 100n }],
    status: 'open', ...over,
  });

  it('leaderboard por multiplicador con empate resuelto por el primero en llegar', async () => {
    await s.store.put(COL.tournament, OP, 't1', base());
    for (const p of ['A', 'B', 'C']) await s.svc.tournaments.join(OP, p, 't1');
    await s.settled('A', 'r1', 10);
    await s.settled('B', 'r2', 10);
    await s.settled('C', 'r3', 25);
    await s.settled('B', 'r2', 99); // mismo roundId: ignorado
    const lb = await s.svc.tournaments.leaderboard(OP, 't1', 'B');
    expect(lb.top.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(lb.top[0].score).toBe(250000n);
    expect(lb.me).toEqual({ rank: 3, score: 100000n });
    const ranked = (await s.svc.tournaments.leaderboard(OP, 't1', 'A')).me;
    expect(ranked?.rank).toBe(2); // A llegó antes que B
  });

  it('leaderboard por puntos y filtros de apuesta mínima / categoría', async () => {
    await s.store.put(COL.tournament, OP, 't1', base({ metric: 'total_points', minBet: 500n, categories: ['slots'] }));
    for (const p of ['A', 'B']) await s.svc.tournaments.join(OP, p, 't1');
    await s.settled('A', 'r1', 1, 1000n); // 10 pts
    await s.settled('A', 'r2', 1, 100n); // por debajo del mínimo
    await s.settled('B', 'r3', 1, 1000n, 'originals'); // categoría no elegible
    await s.settled('B', 'r4', 1, 1000n); // 10 pts, después que A
    await s.settled('B', 'r5', 1, 500n); // 15 pts
    const lb = await s.svc.tournaments.leaderboard(OP, 't1');
    expect(lb.top.map((r) => [r.rank, r.score])).toEqual([[1, 15n], [2, 10n]]);
  });

  it('cierre: paga exactamente la estructura de premios una sola vez aunque el tick se repita', async () => {
    await s.store.put(COL.tournament, OP, 't1', base());
    for (const p of ['A', 'B']) await s.svc.tournaments.join(OP, p, 't1');
    await s.settled('A', 'r1', 5);
    await s.settled('B', 'r2', 8);
    expect(await s.svc.tournaments.tick(T0)).toBe(0); // aún no vence
    s.env.now = T0 + 2 * HOUR;
    expect(await s.svc.tournaments.tick()).toBe(1);
    expect(await s.svc.tournaments.tick()).toBe(0);
    await Promise.all([s.svc.tournaments.tick(), s.svc.tournaments.tick()]);
    expect(await s.total('B')).toBe(1000n);
    expect(await s.total('A')).toBe(500n); // posición 3 sin jugador: no se paga
    const t = (await s.store.get<Tournament>(COL.tournament, OP, 't1'))!;
    expect(t.status).toBe('finished');
    expect(t.results).toHaveLength(2);
    expect(await s.store.list(COL.payout, OP)).toHaveLength(2);
    // ya no puntúa ni admite inscripciones
    await expect(s.svc.tournaments.join(OP, 'Z', 't1')).rejects.toMatchObject({ code: 'TOURNAMENT_CLOSED' });
  });

  it('buy-in con fondos insuficientes se rechaza; con fondos debita una vez', async () => {
    await s.store.put(COL.tournament, OP, 't1', base({ buyIn: 500n }));
    const err = await s.svc.tournaments.join(OP, 'P', 't1').catch((e) => e);
    expect(isWalletError(err, 'INSUFFICIENT_FUNDS')).toBe(true);
    expect((await s.svc.tournaments.list(OP, 'P'))[0].joined).toBe(false);
    s.wallet.seed(OP, 'P', 'USD', 1000n);
    await s.svc.tournaments.join(OP, 'P', 't1');
    await s.svc.tournaments.join(OP, 'P', 't1');
    expect((await s.wallet.getBalance(OP, 'P', 'USD')).cash).toBe(500n);
  });

  it('difunde el leaderboard con throttle de 1 por segundo', async () => {
    await s.store.put(COL.tournament, OP, 't1', base({ metric: 'total_wagered' }));
    await s.svc.tournaments.join(OP, 'A', 't1');
    await s.settled('A', 'r1', 1);
    await s.settled('A', 'r2', 1);
    await s.settled('A', 'r3', 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(s.emitted.filter((e) => e.event === 'tournament:leaderboard')).toHaveLength(1);
    expect(s.emitted.some((e) => e.event === 'tournament:me')).toBe(true);
    s.env.now += 1000;
    await s.svc.tournaments.broadcast(OP, 't1');
    expect(s.emitted.filter((e) => e.event === 'tournament:leaderboard')).toHaveLength(2);
  });
});
