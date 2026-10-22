import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../config/env';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { DomainEvents, InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryGameCatalog, type GameCatalogPort } from '../../shared/ports/GameCatalogPort';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { FeedService } from '../application/FeedService';
import { BetFeed, classify, DEFAULT_FEED_CONFIG, FeedBet, FeedConfig, parseHighRollerMin } from '../domain/BetFeed';
import { pseudonym } from '../domain/pseudonym';
import { createFeedModule } from '../index';

const OP = 'op-feed';
const OP2 = 'op-other';
const SECRET = 'test-only-feed-secret-0123456789abcdef';

let seq = 0;
const bet = (over: Partial<FeedBet> = {}): FeedBet => {
  seq += 1;
  return {
    id: `studio:r${seq}`, gameId: 'dice', gameTitle: 'Dice', provider: 'studio', category: 'originals', player: 'Jugador·AAAAAA',
    currency: 'USD', amount: 100n, win: 0n, multiplier: 0, at: new Date(0).toISOString(), ...over,
  };
};

const settled = (over: Partial<DomainEvents['bet.settled']> = {}): DomainEvents['bet.settled'] => {
  seq += 1;
  return {
    operatorId: OP, playerId: 'p1', at: new Date().toISOString(), amount: 100n, win: 200n, currency: 'USD',
    gameId: 'dice', provider: 'studio', category: 'originals', roundId: `round-${seq}`, multiplier: 2, ...over,
  };
};

const cfg = (over: Partial<FeedConfig> = {}): FeedConfig => ({ ...DEFAULT_FEED_CONFIG, highRollerMin: { USD: 10_000n }, ...over });

describe('BetFeed (dominio)', () => {
  it('classify: todas siempre; grandes apostadores por moneda y umbral exacto; grandes victorias desde el multiplicador', () => {
    const c = cfg();
    expect(classify({ amount: 9_999n, currency: 'USD', multiplier: 1 }, c)).toEqual(['all']);
    expect(classify({ amount: 10_000n, currency: 'USD', multiplier: 1 }, c)).toEqual(['all', 'high']);
    expect(classify({ amount: 10_000n, currency: 'usd', multiplier: 1 }, c)).toEqual(['all', 'high']);
    // Moneda sin umbral configurado: nunca es "grande".
    expect(classify({ amount: 10n ** 20n, currency: 'COP', multiplier: 1 }, c)).toEqual(['all']);
    expect(classify({ amount: 1n, currency: 'USD', multiplier: 9.99 }, c)).toEqual(['all']);
    expect(classify({ amount: 1n, currency: 'USD', multiplier: 10 }, c)).toEqual(['all', 'lucky']);
    expect(classify({ amount: 10_000n, currency: 'USD', multiplier: 50 }, c)).toEqual(['all', 'high', 'lucky']);
    // Giros gratis (monto 0) y multiplicadores no finitos nunca cuentan como grandes victorias.
    expect(classify({ amount: 0n, currency: 'USD', multiplier: 1000 }, c)).toEqual(['all']);
    expect(classify({ amount: 1n, currency: 'USD', multiplier: Number.POSITIVE_INFINITY }, c)).toEqual(['all']);
    expect(classify({ amount: 1n, currency: 'USD', multiplier: Number.NaN }, c)).toEqual(['all']);
  });

  it('lo más reciente primero, acotado a size, y limit respeta 0 y valores grandes', () => {
    const f = new BetFeed(cfg({ size: 3 }));
    const bets = [bet(), bet(), bet(), bet(), bet()];
    bets.forEach((b) => f.add(OP, 'p1', b));
    expect(f.list(OP, 'all').map((b) => b.id)).toEqual([bets[4].id, bets[3].id, bets[2].id]);
    expect(f.list(OP, 'all', 1)).toHaveLength(1);
    expect(f.list(OP, 'all', 0)).toEqual([]);
    expect(f.list(OP, 'all', 1_000)).toHaveLength(3);
    expect(f.list('desconocido', 'all')).toEqual([]);
  });

  it('descarta duplicados (entrega al menos una vez del bus)', () => {
    const f = new BetFeed(cfg());
    const b = bet();
    expect(f.add(OP, 'p1', b)).toEqual(['all']);
    expect(f.add(OP, 'p1', { ...b })).toBeNull();
    expect(f.list(OP, 'all')).toHaveLength(1);
    expect(f.listMine(OP, 'p1')).toHaveLength(1);
  });

  it('aísla operadores y jugadores', () => {
    const f = new BetFeed(cfg());
    f.add(OP, 'p1', bet());
    f.add(OP2, 'p1', bet());
    f.add(OP, 'p2', bet());
    expect(f.list(OP, 'all')).toHaveLength(2);
    expect(f.list(OP2, 'all')).toHaveLength(1);
    expect(f.listMine(OP, 'p1')).toHaveLength(1);
    expect(f.listMine(OP2, 'p2')).toEqual([]);
  });

  it('isOwner es exacto aunque la apuesta lleve tiempo en grandes apostadores', () => {
    const f = new BetFeed(cfg({ size: 2 }));
    const big = bet({ amount: 50_000n });
    f.add(OP, 'whale', big);
    // Muchas apuestas pequeñas después: la grande sigue en "high" y su dueño se reconoce.
    for (let i = 0; i < 100; i++) f.add(OP, 'p1', bet());
    const [stillThere] = f.list(OP, 'high');
    expect(stillThere.id).toBe(big.id);
    expect(f.isOwner(stillThere, 'whale')).toBe(true);
    expect(f.isOwner(stillThere, 'p1')).toBe(false);
    expect(f.isOwner(bet(), 'whale')).toBe(false);
  });

  it('expulsa a los jugadores menos recientes por encima de maxPlayers (LRU)', () => {
    const f = new BetFeed(cfg({ maxPlayers: 2 }));
    f.add(OP, 'a', bet());
    f.add(OP, 'b', bet());
    f.add(OP, 'a', bet()); // a pasa a ser el más reciente
    f.add(OP, 'c', bet()); // expulsa a b
    expect(f.listMine(OP, 'b')).toEqual([]);
    expect(f.listMine(OP, 'a')).toHaveLength(2);
    expect(f.listMine(OP, 'c')).toHaveLength(1);
  });

  it('valida la configuración', () => {
    expect(() => new BetFeed(cfg({ size: 0 }))).toThrow();
    expect(() => new BetFeed(cfg({ size: 1.5 }))).toThrow();
    expect(() => new BetFeed(cfg({ maxPlayers: 0 }))).toThrow();
  });

  it('parseHighRollerMin acepta MONEDA:monto y rechaza formatos ambiguos', () => {
    expect(parseHighRollerMin(undefined)).toEqual({});
    expect(parseHighRollerMin('')).toEqual({});
    expect(parseHighRollerMin(' usd:100000 , COP:400000000 ,')).toEqual({ USD: 100_000n, COP: 400_000_000n });
    for (const bad of ['USD', 'USD:', 'USD:1.5', 'USD:-1', 'US:1', '1:1', 'USD:1e9', 'USD 100']) {
      expect(() => parseHighRollerMin(bad), bad).toThrow(/FEED_HIGH_ROLLER_MIN/);
    }
  });
});

describe('pseudonym', () => {
  it('estable, con formato fijo, distinto por jugador, operador y secreto, y sin rastro del id', () => {
    const a = pseudonym(SECRET, OP, 'player-123456');
    expect(a).toBe(pseudonym(SECRET, OP, 'player-123456'));
    expect(a).toMatch(/^Jugador·[2-9A-HJKMNP-Z]{6}$/);
    expect(a).not.toContain('player');
    expect(pseudonym(SECRET, OP, 'player-2')).not.toBe(a);
    expect(pseudonym(SECRET, OP2, 'player-123456')).not.toBe(a);
    expect(pseudonym('otro-secreto', OP, 'player-123456')).not.toBe(a);
    expect(pseudonym(SECRET, OP, 'x', 'Abyss')).toMatch(/^Abyss·/);
  });

  it('casi sin colisiones en 20 000 jugadores', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(pseudonym(SECRET, OP, `p${i}`));
    // 31^6 ≈ 887 millones de códigos: esperamos como mucho un puñado de choques.
    expect(seen.size).toBeGreaterThan(19_990);
  });
});

describe('FeedService', () => {
  const build = (catalog?: GameCatalogPort, over: Partial<FeedConfig> = {}) => {
    const bus = new InMemoryEventBus();
    const svc = new FeedService({ bus, catalog, logger: silentLogger, config: cfg(over), pseudonymSecret: SECRET });
    const notified: Array<{ op: string; player: string; bet: FeedBet; kinds: string[] }> = [];
    svc.setNotifier({ bet: (op, player, b, kinds) => notified.push({ op, player, bet: b, kinds }) });
    svc.start();
    return { bus, svc, notified };
  };

  it('proyecta bet.settled con el título del catálogo y alias, y avisa al notificador', async () => {
    const { bus, svc, notified } = build(new InMemoryGameCatalog([{ id: 'dice', provider: 'studio', category: 'originals', title: 'Abyss Dice' }]));
    const e = settled({ amount: 20_000n, win: 400_000n, multiplier: 20 });
    await bus.publish('bet.settled', e);
    const [b] = svc.feed.list(OP, 'all');
    expect(b).toMatchObject({ id: `studio:${e.roundId}`, gameTitle: 'Abyss Dice', amount: 20_000n, win: 400_000n, multiplier: 20 });
    expect(b.player).toBe(svc.alias(OP, 'p1'));
    expect(JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('"p1"');
    expect(notified).toHaveLength(1);
    expect(notified[0].kinds).toEqual(['all', 'high', 'lucky']);
  });

  it('el mismo roundId de otro proveedor no se confunde; el duplicado no notifica', async () => {
    const { bus, svc, notified } = build();
    const e = settled();
    await bus.publish('bet.settled', e);
    await bus.publish('bet.settled', e);
    await bus.publish('bet.settled', { ...e, provider: 'pragmatic' });
    expect(svc.feed.list(OP, 'all').map((b) => b.id)).toEqual([`pragmatic:${e.roundId}`, `studio:${e.roundId}`]);
    expect(notified).toHaveLength(2);
  });

  it('sin catálogo o con el catálogo caído usa el id y reintenta después (no cachea el fallo)', async () => {
    let down = true;
    let calls = 0;
    const flaky: GameCatalogPort = {
      async getGame(id) {
        calls += 1;
        if (down) throw new Error('catálogo caído');
        return { id, provider: 'studio', category: 'originals', title: 'Recuperado' };
      },
    };
    const { bus, svc } = build(flaky);
    await bus.publish('bet.settled', settled());
    expect(svc.feed.list(OP, 'all')[0].gameTitle).toBe('dice');
    down = false;
    await bus.publish('bet.settled', settled());
    await bus.publish('bet.settled', settled());
    expect(svc.feed.list(OP, 'all').map((b) => b.gameTitle)).toEqual(['Recuperado', 'Recuperado', 'dice']);
    expect(calls).toBe(2); // el tercero sale de la caché
  });

  it('nunca rompe al publicador aunque el notificador falle', async () => {
    const { bus, svc } = build();
    svc.setNotifier({ bet: () => { throw new Error('socket roto'); } });
    await expect(bus.publish('bet.settled', settled())).resolves.toBeUndefined();
    expect(bus.errors).toEqual([]);
    expect(svc.feed.list(OP, 'all')).toHaveLength(1);
  });

  it('stop() deja de escuchar y start() es idempotente', async () => {
    const { bus, svc } = build();
    svc.start();
    await bus.publish('bet.settled', settled());
    expect(svc.feed.list(OP, 'all')).toHaveLength(1);
    svc.stop();
    await bus.publish('bet.settled', settled());
    expect(svc.feed.list(OP, 'all')).toHaveLength(1);
  });
});

describe('módulo feed montado (HTTP + socket)', () => {
  let server: HttpServer;
  let ioServer: IOServer;
  let base: string;
  let svc: FeedService;
  const bus = new InMemoryEventBus();
  const sockets: ClientSocket[] = [];
  const p1 = devToken('PLAYER', OP, 'p1');
  const p2 = devToken('PLAYER', OP, 'p2');
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');

  const get = async (path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const connect = (opts: { operatorId?: string; token?: string }) => {
    const s = ioClient(`${base.replace('/feed/v1', '')}/feed`, {
      transports: ['websocket'], forceNew: true, reconnection: false,
      ...(opts.operatorId ? { query: { operatorId: opts.operatorId } } : {}),
      ...(opts.token ? { auth: { token: opts.token } } : {}),
    });
    sockets.push(s);
    return s;
  };
  const once = <T>(s: ClientSocket, event: string, ms = 3000) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout esperando ${event}`)), ms);
      s.once(event, (p: T) => { clearTimeout(t); resolve(p); });
    });

  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    ioServer = new IOServer(server);
    const deps: ModuleDeps = {
      wallet: new InMemoryWallet(),
      bus,
      auth: new MockAuth({ NODE_ENV: 'test' }),
      compliance: new InMemoryPlayerCompliance(),
      catalog: new InMemoryGameCatalog([{ id: 'dice', provider: 'studio', category: 'originals', title: 'Abyss Dice' }]),
      logger: silentLogger,
      env: { FEED_PSEUDONYM_SECRET: SECRET, FEED_HIGH_ROLLER_MIN: 'USD:10000' },
      services: {},
    };
    const services = await createFeedModule({ flushMs: 0 }).register(app, ioServer, deps);
    svc = services['feed.service'] as FeedService;
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed/v1`;
  });

  afterEach(() => {
    sockets.splice(0).forEach((s) => s.close());
  });

  afterAll(async () => {
    svc.stop();
    ioServer.close();
    await new Promise((r) => server.close(r));
  });

  it('GET /bets: montos como string, filtros por tipo y validación de parámetros', async () => {
    await bus.publish('bet.settled', settled({ amount: 50_000n, win: 0n, multiplier: 0 }));
    await bus.publish('bet.settled', settled({ amount: 10n, win: 500n, multiplier: 50 }));
    const all = await get(`/bets?operatorId=${OP}`);
    expect(all.status).toBe(200);
    expect(all.body.kind).toBe('all');
    expect(all.body.bets[0]).toMatchObject({ amount: '10', win: '500', gameTitle: 'Abyss Dice', isMe: false });
    expect((await get(`/bets?operatorId=${OP}&kind=high`)).body.bets.every((b: { amount: string }) => BigInt(b.amount) >= 10_000n)).toBe(true);
    expect((await get(`/bets?operatorId=${OP}&kind=lucky`)).body.bets.every((b: { multiplier: number }) => b.multiplier >= 10)).toBe(true);
    expect((await get(`/bets?operatorId=${OP}&limit=1`)).body.bets).toHaveLength(1);

    expect((await get('/bets')).status).toBe(400);
    expect((await get('/bets')).body.error.code).toBe('OPERATOR_REQUIRED');
    for (const q of ['kind=mine', 'kind=ALL', 'limit=0', 'limit=51', 'limit=abc', `operatorId=${'x'.repeat(101)}`]) {
      const r = await get(`/bets?operatorId=${OP}&${q}`);
      expect(r.status, q).toBe(400);
    }
  });

  it('GET /bets con token: operador del token, isMe exacto y 403 si pide otro operador', async () => {
    await bus.publish('bet.settled', settled({ playerId: 'p1' }));
    const mine = await get('/bets', p1);
    expect(mine.body.bets[0].isMe).toBe(true);
    expect((await get('/bets', p2)).body.bets[0].isMe).toBe(false);
    expect((await get(`/bets?operatorId=${OP2}`, p1)).status).toBe(403);
    // Un token que no es de jugador no marca isMe pero el feed sigue siendo público.
    const asAdmin = await get(`/bets?operatorId=${OP}`, admin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.bets.every((b: { isMe: boolean }) => b.isMe === false)).toBe(true);
  });

  it('GET /bets/mine: solo jugador autenticado y solo sus apuestas', async () => {
    await bus.publish('bet.settled', settled({ playerId: 'p2' }));
    expect((await get('/bets/mine')).status).toBe(401);
    expect((await get('/bets/mine', 'basura')).status).toBe(401);
    expect((await get('/bets/mine', admin)).status).toBe(403);
    const r1 = await get('/bets/mine', p1);
    const r2 = await get('/bets/mine', p2);
    const alias1 = svc.alias(OP, 'p1');
    expect(r1.body.bets.length).toBeGreaterThan(0);
    expect(r1.body.bets.every((b: { player: string }) => b.player === alias1)).toBe(true);
    expect(r2.body.bets.every((b: { player: string }) => b.player === svc.alias(OP, 'p2'))).toBe(true);
    expect((await get('/bets/mine?limit=99', p1)).status).toBe(400);
  });

  it('socket: snapshot al conectar y apuestas en vivo solo a su operador', async () => {
    const pub = connect({ operatorId: OP });
    const snap = await once<{ all: unknown[]; high: unknown[]; lucky: unknown[]; mine?: unknown }>(pub, 'feed:snapshot');
    expect(Array.isArray(snap.all) && Array.isArray(snap.high) && Array.isArray(snap.lucky)).toBe(true);
    expect(snap.mine).toBeUndefined();
    const foreign = connect({ operatorId: OP2 });
    await once(foreign, 'feed:snapshot');
    let leaked = false;
    foreign.on('feed:bets', () => { leaked = true; });

    const live = once<Array<{ id: string; kinds: string[]; amount: string; player: string }>>(pub, 'feed:bets');
    const e = settled({ amount: 20_000n, multiplier: 11 });
    await bus.publish('bet.settled', e);
    const [b] = await live;
    expect(b).toMatchObject({ id: `studio:${e.roundId}`, kinds: ['all', 'high', 'lucky'], amount: '20000' });
    expect(b.player).toBe(svc.alias(OP, 'p1'));
    await new Promise((r) => setTimeout(r, 100));
    expect(leaked).toBe(false);
  });

  it('socket con token: el operador sale del token (ignora el query) y recibe feed:mine solo de sus apuestas', async () => {
    const me = connect({ token: p1, operatorId: OP2 });
    const snap = await once<{ mine?: unknown[] }>(me, 'feed:snapshot');
    expect(Array.isArray(snap.mine)).toBe(true);
    const other = connect({ token: p2 });
    await once(other, 'feed:snapshot');
    let otherGotMine = false;
    other.on('feed:mine', () => { otherGotMine = true; });

    const mine = once<{ id: string }>(me, 'feed:mine');
    const liveForMe = once<Array<{ id: string }>>(me, 'feed:bets');
    const e = settled({ playerId: 'p1' });
    await bus.publish('bet.settled', e);
    expect((await mine).id).toBe(`studio:${e.roundId}`);
    expect((await liveForMe)[0].id).toBe(`studio:${e.roundId}`); // está en la sala de OP, no de OP2
    await new Promise((r) => setTimeout(r, 100));
    expect(otherGotMine).toBe(false);
  });

  it('socket sin operador válido: feed:error y desconexión', async () => {
    const s = connect({});
    const [err, reason] = await Promise.all([once<{ code: string }>(s, 'feed:error'), once<string>(s, 'disconnect')]);
    expect(err.code).toBe('OPERATOR_REQUIRED');
    expect(reason).toBe('io server disconnect');
    const bad = connect({ token: 'dev:PLAYER:*:x' });
    expect((await once<{ code: string }>(bad, 'feed:error')).code).toBe('OPERATOR_REQUIRED');
  });
});

describe('agrupado del socket', () => {
  it('junta las apuestas de la ventana en un solo feed:bets y recorta a maxBatch', async () => {
    const app = express();
    const server = createServer(app);
    const ioServer = new IOServer(server);
    const bus = new InMemoryEventBus();
    const deps: ModuleDeps = {
      wallet: new InMemoryWallet(), bus, auth: new MockAuth({ NODE_ENV: 'test' }), compliance: new InMemoryPlayerCompliance(),
      logger: silentLogger, env: { FEED_PSEUDONYM_SECRET: SECRET }, services: {},
    };
    const services = await createFeedModule({ flushMs: 150 }).register(app, ioServer, deps);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const s = ioClient(`http://127.0.0.1:${port}/feed`, { transports: ['websocket'], forceNew: true, reconnection: false, query: { operatorId: OP } });
    try {
      await new Promise((r) => s.once('feed:snapshot', r));
      const batches: unknown[][] = [];
      s.on('feed:bets', (b: unknown[]) => batches.push(b));
      for (let i = 0; i < DEFAULT_FEED_CONFIG.size + 10; i++) await bus.publish('bet.settled', settled());
      await new Promise((r) => setTimeout(r, 400));
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(DEFAULT_FEED_CONFIG.size);
    } finally {
      s.close();
      (services['feed.service'] as FeedService).stop();
      ioServer.close();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('configuración', () => {
  const prodEnv = {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@localhost:5432/db', JWT_ACCESS_SECRET: 'x'.repeat(40),
    MKT_UNSUBSCRIBE_SECRET: 'm'.repeat(40), PROMO_DROPS_SECRET: 'd'.repeat(40), INBOX_SECRETS_KEY: 'i'.repeat(40),
  } as NodeJS.ProcessEnv;

  it('en producción exige FEED_PSEUDONYM_SECRET de al menos 32 caracteres', () => {
    expect(() => loadConfig(prodEnv)).toThrow(/FEED_PSEUDONYM_SECRET/);
    expect(() => loadConfig({ ...prodEnv, FEED_PSEUDONYM_SECRET: 'corto' })).toThrow(/FEED_PSEUDONYM_SECRET/);
    expect(() => loadConfig({ ...prodEnv, FEED_PSEUDONYM_SECRET: 'f'.repeat(32) })).not.toThrow();
  });

  it('el módulo falla al arrancar con una configuración inválida (no en silencio)', async () => {
    const deps = (env: NodeJS.ProcessEnv): ModuleDeps => ({
      wallet: new InMemoryWallet(), bus: new InMemoryEventBus(), auth: new MockAuth({ NODE_ENV: 'test' }),
      compliance: new InMemoryPlayerCompliance(), logger: silentLogger, env, services: {},
    });
    await expect(createFeedModule().register(express(), undefined, deps({ FEED_HIGH_ROLLER_MIN: 'USD:1.5' }))).rejects.toThrow(/FEED_HIGH_ROLLER_MIN/);
    await expect(createFeedModule().register(express(), undefined, deps({ FEED_LUCKY_MULTIPLIER: '-1' }))).rejects.toThrow(/FEED_LUCKY_MULTIPLIER/);
    const ok = await createFeedModule().register(express(), undefined, deps({}));
    (ok['feed.service'] as FeedService).stop();
  });
});
