import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devToken } from '../../shared/adapters/MockAuth';
import { signHmacSha256, verifyHmac } from '../../shared/crypto/hmac';
import { isWalletError } from '../../shared/ports/WalletPort';
import type { RemoteOperator } from '../domain/types';
import { RemoteSeamlessWallet } from '../infrastructure/wallet/RemoteSeamlessWallet';
import { api, HubHarness, OP, PLAYER, startHub } from './helpers';

const admin = devToken('PLATFORM_ADMIN', '*', 'root');
const opAdmin = devToken('OPERATOR_ADMIN', OP, 'u-1');

describe('Hub · catálogo', () => {
  let h: HubHarness;
  beforeEach(async () => {
    h = await startHub();
  });
  afterEach(async () => h.close());

  it('siembra los juegos de Nymfo Studios con sus ids y los del MockProvider', async () => {
    const r = await api(h.base, 'GET', '/hub/v1/games?provider=nymfo-studios&pageSize=50');
    const ids = r.body.items.map((g: any) => g.id).sort();
    expect(ids).toEqual(
      ['nymfo-blackjack', 'nymfo-crash', 'nymfo-dice', 'nymfo-ember-lines', 'nymfo-mines', 'nymfo-plinko', 'nymfo-roulette', 'nymfo-starfall', 'nymfo-verdant-grid'].sort(),
    );
    const mock = await api(h.base, 'GET', '/hub/v1/games?provider=mock-provider&pageSize=50');
    expect(mock.body.total).toBe(12);
    expect(r.body.items[0].images.thumb).toMatch(/^\/hub\/v1\/assets\/games\/.+\/thumb\.svg$/);
    const svg = await fetch(`${h.base}/hub/v1/assets/games/nymfo-starfall/thumb.svg`);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('Starfall');
    const providers = await api(h.base, 'GET', '/hub/v1/providers');
    expect(providers.body.items.map((p: any) => p.id)).toEqual(expect.arrayContaining(['nymfo-studios', 'mock-provider']));
  });

  it('filtra por categoría, búsqueda, tag, orden y paginación', async () => {
    const orig = await api(h.base, 'GET', '/hub/v1/games?category=originals&pageSize=50');
    expect(orig.body.items.every((g: any) => g.category === 'originals')).toBe(true);
    expect(orig.body.total).toBe(4);

    const q = await api(h.base, 'GET', '/hub/v1/games?q=starf');
    expect(q.body.items.map((g: any) => g.id)).toEqual(['nymfo-starfall']);
    const byProviderName = await api(h.base, 'GET', '/hub/v1/games?q=mock%20play&pageSize=50');
    expect(byProviderName.body.total).toBe(12);

    const tag = await api(h.base, 'GET', '/hub/v1/games?tag=bonus-buy&pageSize=50');
    expect(tag.body.items.map((g: any) => g.id).sort()).toEqual(['mock-provider-mp-sugar-comet', 'mock-provider-mp-wolf-ridge', 'nymfo-starfall']);

    const pop = await api(h.base, 'GET', '/hub/v1/games?sort=popular&pageSize=2');
    expect(pop.body.items.map((g: any) => g.id)).toEqual(['nymfo-crash', 'nymfo-starfall']);
    expect(pop.body.total).toBe(21);

    const az = await api(h.base, 'GET', '/hub/v1/games?sort=az&pageSize=100');
    const titles = az.body.items.map((g: any) => g.title);
    expect(titles).toEqual([...titles].sort((a: string, b: string) => a.localeCompare(b)));

    const newest = await api(h.base, 'GET', '/hub/v1/games?sort=new&pageSize=1&provider=mock-provider');
    expect(newest.body.items[0].id).toBe('mock-provider-mp-pirate-cove');

    const p2 = await api(h.base, 'GET', '/hub/v1/games?sort=az&page=2&pageSize=5');
    expect(p2.body.items).toHaveLength(5);
    expect(p2.body.items[0].title).toBe(titles[5]);

    const bad = await api(h.base, 'GET', '/hub/v1/games?category=nope');
    expect(bad.status).toBe(400);
  });

  it('respeta los mercados permitidos', async () => {
    const co = await api(h.base, 'GET', '/hub/v1/games?provider=mock-provider&market=co&pageSize=50');
    const cl = await api(h.base, 'GET', '/hub/v1/games?provider=mock-provider&market=CL&pageSize=50');
    expect(co.body.total).toBe(12);
    expect(cl.body.total).toBe(10);
    expect(cl.body.items.map((g: any) => g.id)).not.toContain('mock-provider-mp-dragon-pearls');
    const detail = await api(h.base, 'GET', '/hub/v1/games/mock-provider-mp-dragon-pearls?market=CL');
    expect(detail.status).toBe(404);
    const launch = await api(h.base, 'POST', '/hub/v1/games/mock-provider-mp-dragon-pearls/launch', { mode: 'demo', currency: 'USD', market: 'CL' });
    expect(launch.body.error.code).toBe('GAME_UNAVAILABLE');
  });

  it('activación y orden por operador (con alcance del rol)', async () => {
    const off = await api(h.base, 'PUT', `/hub/v1/admin/operators/${OP}/games/nymfo-dice`, { enabled: false }, opAdmin);
    expect(off.status).toBe(200);
    const forbidden = await api(h.base, 'PUT', '/hub/v1/admin/operators/op-2/games/nymfo-dice', { enabled: false }, opAdmin);
    expect(forbidden.status).toBe(403);
    const list = await api(h.base, 'GET', `/hub/v1/games?operatorId=${OP}&category=originals`);
    expect(list.body.items.map((g: any) => g.id)).not.toContain('nymfo-dice');
    const other = await api(h.base, 'GET', '/hub/v1/games?operatorId=op-2&category=originals');
    expect(other.body.items.map((g: any) => g.id)).toContain('nymfo-dice');

    await api(h.base, 'PUT', `/hub/v1/admin/operators/${OP}/order`, { gameIds: ['nymfo-plinko', 'nymfo-mines'] }, opAdmin);
    const ordered = await api(h.base, 'GET', `/hub/v1/games?operatorId=${OP}&category=originals`);
    expect(ordered.body.items.map((g: any) => g.id).slice(0, 2)).toEqual(['nymfo-plinko', 'nymfo-mines']);

    const launch = await api(h.base, 'POST', '/hub/v1/games/nymfo-dice/launch', { mode: 'real', currency: 'USD' }, devToken('PLAYER', OP, PLAYER));
    expect(launch.body.error.code).toBe('GAME_UNAVAILABLE');
  });

  it('CRUD de admin solo para PLATFORM_ADMIN y sync de catálogo', async () => {
    const denied = await api(h.base, 'POST', '/hub/v1/admin/providers', { id: 'acme', name: 'Acme', type: 'external' }, opAdmin);
    expect(denied.status).toBe(403);
    expect((await api(h.base, 'POST', '/hub/v1/admin/providers', { id: 'acme', name: 'Acme', type: 'external' })).status).toBe(401);
    expect((await api(h.base, 'POST', '/hub/v1/admin/providers', { id: 'acme', name: 'Acme', type: 'external' }, admin)).status).toBe(201);
    const g = await api(h.base, 'POST', '/hub/v1/admin/games', { providerId: 'acme', externalId: 'Rocket 7', title: 'Rocket 7', category: 'slots', rtp: 95.5 }, admin);
    expect(g.status).toBe(201);
    expect(g.body.id).toBe('acme-rocket-7');
    // Proveedor desactivado → sus juegos desaparecen del lobby.
    await api(h.base, 'PATCH', '/hub/v1/admin/providers/acme', { status: 'disabled' }, admin);
    expect((await api(h.base, 'GET', '/hub/v1/games?provider=acme')).body.total).toBe(0);
    expect((await api(h.base, 'GET', '/hub/v1/admin/games?provider=acme', undefined, opAdmin)).body.total).toBe(1);

    await api(h.base, 'PATCH', '/hub/v1/admin/games/mock-provider-mp-baccarat', { status: 'disabled' }, admin);
    const sync = await api(h.base, 'POST', '/hub/v1/admin/providers/mock-provider/sync', undefined, admin);
    expect(sync.body).toEqual({ created: 0, updated: 12, disabled: 0 });
    // El estado manual se respeta en la sincronización.
    expect((await api(h.base, 'GET', '/hub/v1/games/mock-provider-mp-baccarat')).status).toBe(404);
    expect((await api(h.base, 'POST', '/hub/v1/admin/providers/acme/sync', undefined, admin)).body.error.code).toBe('UNKNOWN_PROVIDER');
  });

  it('launch: demo público con sesión demo; real exige jugador y publica session.started', async () => {
    const started: string[] = [];
    h.bus.subscribe('session.started', (e) => {
      started.push(e.sessionId);
    });
    const demo = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'demo', currency: 'USD' });
    expect(demo.status).toBe(201);
    expect(demo.body.url).toMatch(/^http:\/\/web\.test\/studio\/nymfo-starfall\?mode=demo&session=/);
    const noAuth = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'real', currency: 'USD' });
    expect(noAuth.status).toBe(401);
    const asAdmin = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'real', currency: 'USD' }, opAdmin);
    expect(asAdmin.status).toBe(403);

    const real = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'real', currency: 'usd' }, devToken('PLAYER', OP, PLAYER));
    expect(real.status).toBe(201);
    const token = new URL(real.body.url).searchParams.get('session')!;
    expect(new URL(real.body.url).searchParams.get('mode')).toBe('real');
    await h.bus.drain();
    expect(started).toEqual([real.body.sessionId]);

    const s = await h.services.resolveSession(token);
    expect(s).toMatchObject({ operatorId: OP, playerId: PLAYER, currency: 'USD', gameId: 'nymfo-starfall', mode: 'real', walletKind: 'local' });
    expect(await h.services.resolveSession('nope-nope')).toBeNull();

    // walletForSession local → deps.wallet
    h.wallet.seed(OP, PLAYER, 'USD', 1000n);
    const w = h.services.walletForSession(token);
    await w.debit({ operatorId: OP, playerId: PLAYER, currency: 'USD', amount: 100n, idempotencyKey: 'studio:x', reason: 'BET', ref: {} });
    expect((await h.wallet.getBalance(OP, PLAYER, 'USD')).cash).toBe(900n);

    // walletForSession demo → billetera ficticia separada
    const demoToken = new URL(demo.body.url).searchParams.get('session')!;
    const ds = await h.services.resolveSession(demoToken);
    const dw = h.services.walletForSession({ sessionId: ds.sessionId });
    const bal = await dw.getBalance(ds.operatorId, ds.playerId, 'USD');
    expect(bal.cash).toBe(100_000_000n);
  });
});

/** Servidor express que simula la billetera de un casino remoto (lado saliente). */
async function fakeRemoteCasino(secret: string, opts: { failFirst?: number } = {}) {
  const app = express();
  const calls: Array<{ action: string; body: any }> = [];
  const balances = new Map<string, bigint>([['rp-1', 1000n]]);
  const seen = new Map<string, any>();
  let failures = opts.failFirst ?? 0;
  app.use(express.json({ verify: (req: any, _res, buf) => (req.rawBody = Buffer.from(buf)) }));
  app.post('/wallet/:action', (req: any, res) => {
    if (failures > 0) {
      failures--;
      return res.status(503).json({ status: 'ERROR', error: { code: 'UNAVAILABLE' } });
    }
    if (!verifyHmac(secret, req.rawBody, req.get('x-signature'))) return res.status(401).json({ status: 'ERROR', error: { code: 'INVALID_SIGNATURE' } });
    const { action } = req.params;
    calls.push({ action, body: req.body });
    const b = req.body;
    if (b.transactionId && seen.has(b.transactionId)) return res.json(seen.get(b.transactionId));
    const cur = balances.get(b.playerId) ?? 0n;
    let next = cur;
    if (action === 'bet') {
      if (cur < BigInt(b.amount)) return res.status(402).json({ status: 'ERROR', error: { code: 'INSUFFICIENT_FUNDS' } });
      next = cur - BigInt(b.amount);
    } else if (action === 'win') next = cur + BigInt(b.amount);
    balances.set(b.playerId, next);
    const out = { status: 'OK', balance: next.toString(), transactionId: `remote-${calls.length}` };
    if (b.transactionId) seen.set(b.transactionId, out);
    res.json(out);
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/wallet`;
  return { url, calls, balances, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('Hub · lado saliente', () => {
  const SECRET = 'remote-secret';

  it('RemoteSeamlessWallet: firma, idempotencia, reintentos y errores', async () => {
    const casino = await fakeRemoteCasino(SECRET, { failFirst: 2 });
    try {
      const remote: RemoteOperator = { id: 'casino-x', name: 'Casino X', walletCallbackUrl: casino.url, status: 'active', currencies: [], createdAt: new Date() };
      const w = new RemoteSeamlessWallet(remote, SECRET, { sessionToken: 'tok', retries: 3, backoffMs: 1 });
      const base = { operatorId: 'casino-x', playerId: 'rp-1', currency: 'USD', ref: { gameId: 'nymfo-crash', roundId: 'rd-1' } };
      const d = await w.debit({ ...base, amount: 300n, idempotencyKey: 'studio:rd-1:bet', reason: 'BET' });
      expect(d.balance).toBe(700n);
      expect(casino.calls[0]).toMatchObject({ action: 'bet', body: { transactionId: 'studio:rd-1:bet', amount: '300', sessionToken: 'tok', roundId: 'rd-1' } });
      // Reintento: no vuelve a llamar.
      expect(await w.debit({ ...base, amount: 300n, idempotencyKey: 'studio:rd-1:bet', reason: 'BET' })).toEqual(d);
      expect(casino.calls).toHaveLength(1);
      await expect(w.debit({ ...base, amount: 999n, idempotencyKey: 'studio:rd-1:bet', reason: 'BET' })).rejects.toSatisfy((e) => isWalletError(e, 'IDEMPOTENCY_CONFLICT'));

      const c = await w.credit({ ...base, amount: 600n, idempotencyKey: 'studio:rd-1:win', reason: 'WIN' });
      expect(c.balance).toBe(1300n);
      expect((await w.getBalance('casino-x', 'rp-1', 'USD')).cash).toBe(1300n);

      await expect(w.debit({ ...base, amount: 5000n, idempotencyKey: 'studio:rd-2:bet', reason: 'BET' })).rejects.toSatisfy((e) => isWalletError(e, 'INSUFFICIENT_FUNDS'));

      const rb = await w.rollback({ operatorId: 'casino-x', playerId: 'rp-1', originalIdempotencyKey: 'studio:rd-1:win', idempotencyKey: 'studio:rd-1:rb' });
      expect(rb.txId).toMatch(/^remote-/);

      const bad = new RemoteSeamlessWallet(remote, 'otro', { retries: 0 });
      await expect(bad.getBalance('casino-x', 'rp-1', 'USD')).rejects.toMatchObject({ code: 'REMOTE_WALLET_ERROR' });
    } finally {
      await casino.close();
    }
  });

  it('si la apuesta no se confirma, falla con REMOTE_WALLET_ERROR y envía rollback', async () => {
    const casino = await fakeRemoteCasino(SECRET, { failFirst: 2 });
    try {
      const remote: RemoteOperator = { id: 'casino-x', name: 'X', walletCallbackUrl: casino.url, status: 'active', currencies: [], createdAt: new Date() };
      const w = new RemoteSeamlessWallet(remote, SECRET, { retries: 1, backoffMs: 1 });
      await expect(
        w.debit({ operatorId: 'casino-x', playerId: 'rp-1', currency: 'USD', amount: 10n, idempotencyKey: 'k1', reason: 'BET', ref: {} }),
      ).rejects.toMatchObject({ code: 'REMOTE_WALLET_ERROR' });
      expect(casino.calls.map((c) => c.action)).toEqual(['rollback']);
      expect(casino.calls[0].body.referenceTransactionId).toBe('k1');
    } finally {
      await casino.close();
    }
  });

  it('outbound/launch firmado crea una sesión remota y walletForSession cobra al casino remoto', async () => {
    const casino = await fakeRemoteCasino(SECRET);
    const h = await startHub({ env: { HUB_REMOTE_CASINO_X_SECRET: SECRET } });
    try {
      const created = await api(h.base, 'POST', '/hub/v1/admin/remote-operators', { id: 'casino-x', name: 'Casino X', walletCallbackUrl: casino.url, currencies: ['USD'] }, admin);
      expect(created.status).toBe(201);
      expect(created.body.hasSecret).toBe(true);

      const body = JSON.stringify({ playerId: 'rp-1', gameId: 'nymfo-crash', currency: 'USD' });
      const send = (sig: string, b = body) =>
        fetch(`${h.base}/hub/v1/outbound/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Id': 'casino-x', 'X-Signature': sig }, body: b });

      const bad = await send(signHmacSha256('otro', body));
      expect(bad.status).toBe(401);
      const thirdParty = JSON.stringify({ playerId: 'rp-1', gameId: 'mock-provider-mp-golden-oasis', currency: 'USD' });
      expect((await send(signHmacSha256(SECRET, thirdParty), thirdParty)).status).toBe(404);

      const res = await send(signHmacSha256(SECRET, body));
      expect(res.status).toBe(201);
      const out = (await res.json()) as any;
      expect(out.url).toMatch(/^http:\/\/web\.test\/studio\/nymfo-crash\?mode=real&session=/);

      const s = await h.services.resolveSession(out.sessionToken);
      expect(s).toMatchObject({ operatorId: 'casino-x', playerId: 'rp-1', walletKind: 'remote', remoteOperatorId: 'casino-x' });
      const w = h.services.walletForSession(out.sessionToken);
      const r = await w.debit({ operatorId: 'casino-x', playerId: 'rp-1', currency: 'USD', amount: 250n, idempotencyKey: 'studio:1', reason: 'BET', ref: { gameId: 'nymfo-crash', roundId: 'r1' } });
      expect(r.balance).toBe(750n);
      expect(casino.balances.get('rp-1')).toBe(750n);
      expect(casino.calls[0].body.sessionToken).toBe(out.sessionToken);
      // La billetera local no se toca.
      expect(h.wallet.getHistory()).toHaveLength(0);

      const games = await api(h.base, 'GET', '/hub/v1/outbound/games');
      expect(games.body.items).toHaveLength(9);
    } finally {
      await h.close();
      await casino.close();
    }
  });
});

describe('Hub · reportes HTTP', () => {
  it('exige rol y exporta CSV', async () => {
    const h = await startHub();
    try {
      expect((await api(h.base, 'GET', '/hub/v1/admin/reports/providers', undefined, devToken('PLAYER', OP, PLAYER))).status).toBe(403);
      const json = await api(h.base, 'GET', `/hub/v1/admin/reports/providers?operatorId=${OP}`, undefined, opAdmin);
      expect(json.status).toBe(200);
      expect(json.body.totals).toMatchObject({ bets: '0', ggr: '0', rounds: 0 });
      const csv = await fetch(`${h.base}/hub/v1/admin/reports/providers?format=csv`, { headers: { Authorization: `Bearer ${admin}` } });
      expect(csv.headers.get('content-type')).toContain('text/csv');
      expect((await csv.text()).split('\n')[0]).toBe('providerId,gameId,title,bets,wins,ggr,rounds,openRounds');
    } finally {
      await h.close();
    }
  });
});
