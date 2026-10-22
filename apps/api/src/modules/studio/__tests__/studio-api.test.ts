import express from 'express';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { MockAuth, devToken } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus, type DomainEvents } from '../../shared/events/EventBus';
import { silentLogger, type ModuleDeps } from '../../shared/module';
import type { BetGuardPort } from '../../shared/ports/BetGuardPort';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import type { CreditRequest, WalletPort } from '../../shared/ports/WalletPort';
import { StudioConfigService } from '../application/StudioConfigService';
import { StudioFairnessService } from '../application/StudioFairnessService';
import { StudioPlayService } from '../application/StudioPlayService';
import { CrashLiveRoom } from '../application/CrashLiveRoom';
import { HttpError } from '../../shared/http/errors';
import { InMemoryOperatorConfigRepository, InMemoryRoundRepository, InMemorySeedPairRepository } from '../infrastructure/memory';
import { createFairRng } from '../domain/fairness/ProvablyFair';
import { nymfoDice } from '../domain/originals';
import { studioModule } from '../index';
import { GAMES } from '../domain/games/registry';

const OP = 'op-1';
const P = 'p-1';
const PLAYER = { userId: P, role: 'PLAYER' as const, operatorId: OP, playerId: P };

/** Billetera que falla en el crédito (para probar el rollback). */
class FailingCreditWallet extends InMemoryWallet {
  failCredits = true;
  async credit(req: CreditRequest) {
    if (this.failCredits) throw new Error('fallo de red en credit');
    return super.credit(req);
  }
}

function setup(opts: { wallet?: InMemoryWallet; betGuard?: BetGuardPort } = {}) {
  const wallet = opts.wallet ?? new InMemoryWallet();
  wallet.seed(OP, P, 'USD', 100_000n);
  const bus = new InMemoryEventBus();
  const events: Array<{ name: keyof DomainEvents; payload: any }> = [];
  bus.subscribe('bet.placed', (p) => void events.push({ name: 'bet.placed', payload: p }));
  bus.subscribe('bet.settled', (p) => void events.push({ name: 'bet.settled', payload: p }));
  const rounds = new InMemoryRoundRepository();
  const config = new StudioConfigService(new InMemoryOperatorConfigRepository());
  const fairness = new StudioFairnessService(new InMemorySeedPairRepository(), rounds);
  const play = new StudioPlayService({ wallet, bus, betGuard: opts.betGuard, rounds, fairness, config, logger: silentLogger });
  return { wallet, bus, events, rounds, config, fairness, play };
}

const cash = async (w: WalletPort) => (await w.getBalance(OP, P, 'USD')).cash;

describe('StudioPlayService (una acción)', () => {
  it('debita, acredita la ganancia, guarda la ronda y publica eventos', async () => {
    const s = setup();
    const out = await s.play.play('nymfo-dice', { principal: PLAYER, amount: 1000n, currency: 'USD', params: { target: 50, over: true } });
    const r = out.round;
    expect(r.status).toBe('SETTLED');
    expect(r.bet).toBe(1000n);
    expect(r.win).toBe((1000n * BigInt(Math.round(r.multiplier * 10000))) / 10000n);
    expect(await cash(s.wallet)).toBe(100_000n - 1000n + r.win);
    expect(s.wallet.findTransaction(OP, `studio:${r.id}:bet`)?.amount).toBe(1000n);
    if (r.win > 0n) expect(s.wallet.findTransaction(OP, `studio:${r.id}:win`)?.amount).toBe(r.win);
    await s.bus.drain();
    expect(s.events.map((e) => e.name)).toEqual(['bet.placed', 'bet.settled']);
    expect(s.events[0].payload).toMatchObject({ provider: 'nymfo-studios', category: 'originals', gameId: 'nymfo-dice', roundId: r.id, amount: 1000n });
    expect(s.events[1].payload).toMatchObject({ win: r.win, multiplier: r.multiplier });

    // El resultado se reproduce con las semillas tras rotar.
    const { previous } = await s.fairness.rotate(OP, P);
    expect(previous.serverSeedHash).toBe(r.serverSeedHash);
    const again = nymfoDice.play(createFairRng(previous.serverSeed, r.clientSeed, r.nonce), { params: r.params, rtpProfile: '99.00' });
    expect(again.outcome).toEqual(r.outcome);
    const v = await s.fairness.verify({ serverSeed: previous.serverSeed, clientSeed: r.clientSeed, nonce: r.nonce, gameId: 'nymfo-dice', roundId: r.id });
    expect(v.hashMatches).toBe(true);
    expect(v.round).toMatchObject({ outcomeMatches: true, multiplierMatches: true, nonceMatches: true });
    expect((await s.play.getRound(r.id, { principal: PLAYER })).serverSeed).toBe(previous.serverSeed);
  });

  it('es idempotente ante el reintento de la misma ronda', async () => {
    const s = setup();
    const roundId = randomUUID();
    const req = { principal: PLAYER, amount: 500n, currency: 'USD', params: { target: 20, over: true }, roundId };
    const a = await s.play.play('nymfo-dice', req);
    const balance = await cash(s.wallet);
    const b = await s.play.play('nymfo-dice', req);
    expect(b.round.id).toBe(a.round.id);
    expect(b.round.outcome).toEqual(a.round.outcome);
    expect(await cash(s.wallet)).toBe(balance);
    expect(s.wallet.getHistory({ playerId: P, type: 'DEBIT' } as never)).toHaveLength(1);
    await expect(s.play.play('nymfo-dice', { ...req, principal: { ...PLAYER, userId: 'p-2', playerId: 'p-2' } })).rejects.toMatchObject({ code: 'ROUND_ID_TAKEN' });
  });

  it('revierte el débito si falla el crédito', async () => {
    const wallet = new FailingCreditWallet();
    const s = setup({ wallet });
    // target 1 over → 98 % de ganar: buscar una ronda ganadora (crédito > 0).
    let failed = 0;
    for (let i = 0; i < 5; i++) {
      try {
        await s.play.play('nymfo-dice', { principal: PLAYER, amount: 1000n, currency: 'USD', params: { target: 1.99, over: true } });
      } catch (e) {
        expect((e as Error).message).toMatch('fallo de red');
        failed++;
      }
    }
    expect(failed).toBeGreaterThan(0);
    // Cada ronda fallida quedó ROLLED_BACK y el saldo solo refleja las perdidas.
    const rounds = await s.rounds.list({ operatorId: OP, playerId: P, limit: 50, offset: 0 });
    const rolled = rounds.filter((r) => r.status === 'ROLLED_BACK');
    expect(rolled).toHaveLength(failed);
    const lost = rounds.filter((r) => r.status === 'SETTLED').reduce((sum, r) => sum + r.bet, 0n);
    expect(await cash(wallet)).toBe(100_000n - lost);
    for (const r of rolled) expect(wallet.findTransaction(OP, `studio:${r.id}:bet`)?.rolledBackBy).toBe(`studio:${r.id}:rollback`);
  });

  it('respeta el betGuard y no cobra cuando bloquea', async () => {
    const s = setup({ betGuard: { checkBet: async (r) => (r.amount > 2000n ? { allowed: false, reason: 'Límite de apuesta' } : { allowed: true }) } });
    await expect(s.play.play('nymfo-plinko', { principal: PLAYER, amount: 5000n, currency: 'USD' })).rejects.toMatchObject({ status: 403, code: 'BET_REJECTED' });
    expect(await cash(s.wallet)).toBe(100_000n);
    await s.bus.drain();
    expect(s.events).toHaveLength(0);
  });

  it('valida parámetros antes de cobrar y la suma de fichas de ruleta', async () => {
    const s = setup();
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 100n, params: { target: 99.9 } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      s.play.play('nymfo-roulette', { principal: PLAYER, amount: 100n, params: { bets: [{ type: 'red', amount: '50' }] } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const ok = await s.play.play('nymfo-roulette', { principal: PLAYER, amount: 100n, params: { bets: [{ type: 'red', amount: '60' }, { type: 'straight', value: 0, amount: '40' }] } });
    expect(ok.round.status).toBe('SETTLED');
    expect(await cash(s.wallet)).toBe(100_000n - 100n + ok.round.win);
  });

  it('modo demo: billetera virtual y sin eventos', async () => {
    const s = setup();
    const out = await s.play.play('nymfo-crash', { mode: 'demo', demoSession: 'demo-session-1', amount: 100n, params: { autoCashout: 2 } });
    expect(out.round.mode).toBe('demo');
    expect(await cash(s.wallet)).toBe(100_000n);
    await s.bus.drain();
    expect(s.events).toHaveLength(0);
    expect((await s.play.balance({ mode: 'demo', demoSession: 'demo-session-1' })).balance).toBe(1_000_000n - 100n + out.round.win);
  });

  it('usa la billetera del Hub para sesiones de operadores remotos', async () => {
    const s = setup();
    const remote = new InMemoryWallet();
    remote.seed('op-remoto', 'rp-1', 'EUR', 50_000n);
    const play = new StudioPlayService({
      wallet: s.wallet, bus: s.bus, rounds: s.rounds, fairness: s.fairness, config: s.config, logger: silentLogger,
      hub: {
        resolveSession: async (t) => (t === 'tok-1' ? { sessionId: 's1', operatorId: 'op-remoto', playerId: 'rp-1', currency: 'EUR', mode: 'real' } : null),
        walletForSession: () => remote,
      },
    });
    const out = await play.play('nymfo-plinko', { sessionToken: 'tok-1', amount: 1000n, params: { rows: 8, risk: 'low' } });
    expect(out.round.currency).toBe('EUR');
    expect((await remote.getBalance('op-remoto', 'rp-1', 'EUR')).cash).toBe(49_000n + out.round.win);
    await expect(play.play('nymfo-plinko', { sessionToken: 'malo', amount: 1000n })).rejects.toMatchObject({ code: 'SESSION_INVALID' });
  });
});

describe('RTP por operador', () => {
  it('rechaza RTP fuera de rango y aplica el configurado', async () => {
    const s = setup();
    await expect(s.config.update(OP, { gameId: 'nymfo-dice', rtp: 0.995 })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
    await expect(s.config.update(OP, { gameId: 'nymfo-plinko', rtp: 0.95 })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
    await expect(s.config.update(OP, { gameId: 'nymfo-roulette', rtp: 0.99 })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
    await expect(s.config.update(OP, { gameId: 'nymfo-blackjack', rtpProfile: '97' })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
    const c = await s.config.update(OP, { gameId: 'nymfo-dice', rtp: 0.97, maxBet: 5000n });
    expect(c).toMatchObject({ rtp: 0.97, rtpProfile: '97.00', rtpMode: 'range' });
    const out = await s.play.play('nymfo-dice', { principal: PLAYER, amount: 100n, params: { target: 50, over: true } });
    expect((out.round.outcome as { payout: number }).payout).toBe(Math.floor((0.97 / 0.4999) * 10000) / 10000);
    expect(out.round.rtp).toBe(0.97);
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 6000n })).rejects.toMatchObject({ code: 'BET_TOO_HIGH' });
    await s.config.update(OP, { gameId: 'nymfo-dice', enabled: false });
    await expect(s.play.play('nymfo-dice', { principal: PLAYER, amount: 100n })).rejects.toMatchObject({ code: 'GAME_DISABLED' });
  });

  it('slots sin rtpProfiles solo aceptan el RTP por defecto; con perfiles validan la lista', async () => {
    const s = setup();
    const id = 'test-slot-profiles';
    GAMES[id] = {
      id, name: 'Slot de prueba', kind: 'slot', rtpTarget: 0.965, volatility: 'high', maxWinMultiplier: 100, config: {},
      rtpProfiles: ['96.5', '94'], play: () => ({ multiplier: 0, outcome: {}, bonusTriggered: false }),
    } as never;
    const fixed = 'test-slot-fixed';
    GAMES[fixed] = { ...GAMES[id], id: fixed, rtpProfiles: undefined } as never;
    try {
      await expect(s.config.update(OP, { gameId: id, rtpProfile: '90' })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
      expect(await s.config.update(OP, { gameId: id, rtpProfile: '94' })).toMatchObject({ rtpProfile: '94', rtp: 0.94, rtpMode: 'profiles' });
      await expect(s.config.update(OP, { gameId: fixed, rtpProfile: '94' })).rejects.toMatchObject({ code: 'RTP_OUT_OF_RANGE' });
      expect(await s.config.update(OP, { gameId: fixed, rtp: 0.965 })).toMatchObject({ rtpMode: 'fixed', rtp: 0.965 });
    } finally {
      delete GAMES[id];
      delete GAMES[fixed];
    }
  });
});

describe('Juegos interactivos', () => {
  it('mines: start → reveal → cashout con claves deterministas', async () => {
    const s = setup();
    const st = await s.play.start('nymfo-mines', { principal: PLAYER, amount: 1000n, currency: 'USD', params: { mines: 3 } });
    expect(st.view.minePositions).toBeUndefined();
    expect(st.round.outcome).not.toHaveProperty('minePositions');
    await expect(s.play.start('nymfo-mines', { principal: PLAYER, amount: 1000n, params: { mines: 3 } })).rejects.toMatchObject({ code: 'ROUND_OPEN' });
    await expect(s.fairness.rotate(OP, P)).rejects.toMatchObject({ code: 'ROUND_OPEN' });
    const internal = (await s.rounds.get(st.round.id))!;
    const mines = (internal.state as { minePositions: number[] }).minePositions;
    const safe = Array.from({ length: 25 }, (_, i) => i).find((c) => !mines.includes(c))!;
    const a = await s.play.action('nymfo-mines', { principal: PLAYER, roundId: st.round.id, action: { type: 'reveal', cell: safe } });
    expect(a.round.status).toBe('OPEN');
    const done = await s.play.action('nymfo-mines', { principal: PLAYER, roundId: st.round.id, action: { type: 'cashout' } });
    expect(done.round).toMatchObject({ status: 'SETTLED', multiplier: 1.125, win: 1125n });
    expect(await cash(s.wallet)).toBe(100_000n + 125n);
    await expect(s.play.action('nymfo-mines', { principal: PLAYER, roundId: st.round.id, action: { type: 'cashout' } })).rejects.toMatchObject({ code: 'ROUND_CLOSED' });
    await s.bus.drain();
    expect(s.events.map((e) => e.name)).toEqual(['bet.placed', 'bet.settled']);
  });

  it('blackjack: doblar cobra la apuesta adicional con su propia clave', async () => {
    const s = setup();
    for (let i = 0; i < 40; i++) {
      const st = await s.play.start('nymfo-blackjack', { principal: PLAYER, amount: 100n, currency: 'USD' });
      if (st.round.status !== 'OPEN') continue;
      const before = await cash(s.wallet);
      const d = await s.play.action('nymfo-blackjack', { principal: PLAYER, roundId: st.round.id, action: { type: 'double' } });
      expect(d.round.status).toBe('SETTLED');
      expect(d.round.bet).toBe(200n);
      expect(s.wallet.findTransaction(OP, `studio:${st.round.id}:bet:1`)?.amount).toBe(100n);
      expect(await cash(s.wallet)).toBe(before - 100n + d.round.win);
      expect([0n, 200n, 400n]).toContain(d.round.win);
      return;
    }
    throw new Error('no se encontró una mano doblable');
  });
});

describe('Crash en vivo (sala compartida)', () => {
  it('publica el hash antes de la ronda, paga el retiro y revela la semilla al estallar', async () => {
    const s = setup();
    let t = 0;
    const emitted: Array<[string, any]> = [];
    const room = new CrashLiveRoom({ operatorId: OP, rounds: s.rounds, bus: s.bus, logger: silentLogger, rtp: async () => 0.99, emit: (e, p) => emitted.push([e, p]), waitMs: 1000, pauseMs: 0, now: () => t });
    const actor = await s.play.resolveActor({ principal: PLAYER });
    for (let attempt = 0; attempt < 50; attempt++) {
      await room.tick(); // abre la ronda
      const opened = emitted.filter(([e]) => e === 'crash:round').pop()![1];
      expect(opened.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
      const bet = await room.placeBet(actor, 1000n, 'USD', 1.2);
      t += 1000;
      await room.tick(); // empieza
      // auto-retiro y crash: avanza el reloj hasta que la ronda estalle (puntos altos tardan más de 20 s)
      const crashedBefore = emitted.filter(([e]) => e === 'crash:crashed').length;
      for (let i = 0; i < 1000 && emitted.filter(([e]) => e === 'crash:crashed').length === crashedBefore; i++) {
        t += 20_000;
        await room.tick();
      }
      const crashed = emitted.filter(([e]) => e === 'crash:crashed').pop()![1];
      expect(crashed.roundId).toBe(opened.roundId);
      const r = (await s.rounds.get(bet.roundId))!;
      expect(r.status).toBe('SETTLED');
      const v = await s.fairness.verify({ serverSeed: crashed.serverSeed, serverSeedHash: opened.serverSeedHash, clientSeed: room.clientSeed, nonce: crashed.nonce, gameId: 'nymfo-crash', params: { autoCashout: 2 } });
      expect(v.hashMatches).toBe(true);
      expect((v.outcome as { crashPoint: number }).crashPoint).toBe(crashed.crashPoint);
      if (crashed.crashPoint >= 1.2) {
        expect(r.win).toBe(1200n);
        return;
      }
      expect(r.win).toBe(0n);
      t += 1;
    }
    throw new Error('ninguna ronda superó 1.2x');
  });
});

describe('API HTTP /studio/v1', () => {
  let base = '';
  let server: ReturnType<express.Application['listen']>;
  let wallet: InMemoryWallet;

  beforeAll(async () => {
    const app = express();
    wallet = new InMemoryWallet();
    wallet.seed(OP, P, 'USD', 100_000n);
    const deps: ModuleDeps = {
      wallet, bus: new InMemoryEventBus(), auth: new MockAuth({ NODE_ENV: 'test' }), compliance: new InMemoryPlayerCompliance(),
      logger: silentLogger, env: { NODE_ENV: 'test' }, services: {},
    };
    await studioModule.register(app, undefined, deps);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/studio/v1`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const player = devToken('PLAYER', OP, P);

  beforeEach(() => undefined);

  it('lista los juegos y exige auth para jugar', async () => {
    const g = await call('GET', '/games');
    expect(g.status).toBe(200);
    const ids = g.body.games.map((x: { id: string }) => x.id);
    for (const id of ['nymfo-dice', 'nymfo-plinko', 'nymfo-roulette', 'nymfo-crash', 'nymfo-mines', 'nymfo-blackjack']) expect(ids).toContain(id);
    expect((await call('POST', '/play/nymfo-dice', { amount: '100' })).status).toBe(401);
  });

  it('flujo completo: play, historial, rotate y verify público', async () => {
    const f = await call('GET', '/fairness', undefined, player);
    expect(f.body).toMatchObject({ nonce: 0 });
    expect((await call('POST', '/fairness/client-seed', { clientSeed: 'mi-semilla' }, player)).body.clientSeed).toBe('mi-semilla');
    const p = await call('POST', '/play/nymfo-dice', { amount: '250', currency: 'USD', params: { target: 50, over: false } }, player);
    expect(p.status).toBe(200);
    expect(p.body.round).toMatchObject({ bet: '250', clientSeed: 'mi-semilla', nonce: 0, serverSeedHash: f.body.serverSeedHash });
    expect(p.body.round.serverSeed).toBeUndefined();
    const list = await call('GET', '/rounds?gameId=nymfo-dice', undefined, player);
    expect(list.body.rounds).toHaveLength(1);
    const rot = await call('POST', '/fairness/rotate', {}, player);
    expect(rot.body.previous.serverSeedHash).toBe(f.body.serverSeedHash);
    const v = await call('POST', '/fairness/verify', {
      serverSeed: rot.body.previous.serverSeed, serverSeedHash: f.body.serverSeedHash, clientSeed: 'mi-semilla', nonce: 0, gameId: 'nymfo-dice', params: { target: 50, over: false },
    });
    expect(v.status).toBe(200);
    expect(v.body.hashMatches).toBe(true);
    expect(v.body.outcome).toEqual(p.body.round.outcome);
    const one = await call('GET', `/rounds/${p.body.round.id}`, undefined, player);
    expect(one.body.round.serverSeed).toBe(rot.body.previous.serverSeed);
    expect((await call('GET', `/rounds/${p.body.round.id}`, undefined, devToken('PLAYER', OP, 'otro'))).status).toBe(404);
  });

  it('admin de configs con scope de operador y rechazo de RTP fuera de rango', async () => {
    const admin = devToken('OPERATOR_ADMIN', OP, 'adm');
    expect((await call('GET', '/admin/configs', undefined, player)).status).toBe(403);
    expect((await call('PUT', '/admin/configs', { gameId: 'nymfo-crash', rtp: 0.9 }, admin)).body.error.code).toBe('RTP_OUT_OF_RANGE');
    expect((await call('PUT', '/admin/configs', { operatorId: 'op-2', gameId: 'nymfo-crash', rtp: 0.97 }, admin)).status).toBe(403);
    const ok = await call('PUT', '/admin/configs', { gameId: 'nymfo-crash', rtp: 0.97, minBet: '10' }, admin);
    expect(ok.status).toBe(200);
    expect(ok.body.config).toMatchObject({ rtp: 0.97, minBet: '10' });
    const list = await call('GET', '/admin/configs', undefined, devToken('PLATFORM_ADMIN', OP, 'root'));
    expect(list.body.configs.find((c: { gameId: string }) => c.gameId === 'nymfo-crash')).toMatchObject({ rtp: 0.97 });
  });

  it('demo anónimo e interactivo por HTTP', async () => {
    const d = await call('POST', '/demo/session', {});
    expect(d.status).toBe(201);
    const realBefore = (await wallet.getBalance(OP, P, 'USD')).cash;
    const res = await fetch(`${base}/games/nymfo-mines/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-session': d.body.demoSession },
      body: JSON.stringify({ amount: '100', mode: 'demo', params: { mines: 24 } }),
    });
    const st = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(st.round.mode).toBe('demo');
    expect((await wallet.getBalance(OP, P, 'USD')).cash).toBe(realBefore);
    expect(BigInt(st.balance)).toBe(1_000_000n - 100n);
    const err = await call('POST', '/games/nymfo-mines/action', { roundId: st.round.id, action: { type: 'reveal', cell: 99 } });
    expect(err.status).toBe(401);
  });

  it('errores con formato estándar', async () => {
    const e = await call('POST', '/play/no-existe', { amount: '1' }, player);
    expect(e.status).toBe(404);
    expect(e.body.error.code).toBe('NOT_FOUND');
    expect((await call('POST', '/play/nymfo-dice', { amount: '1.5' }, player)).body.error.code).toBe('VALIDATION_ERROR');
    expect(HttpError).toBeDefined();
  });
});
