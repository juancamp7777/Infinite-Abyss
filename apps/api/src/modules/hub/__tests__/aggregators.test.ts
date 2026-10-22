import { randomBytes } from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devToken } from '../../shared/adapters/MockAuth';
import { silentLogger } from '../../shared/module';
import { decimalToMinor, minorToDecimal } from '../domain/decimalMoney';
import { InMemoryNonceStore, parseUnixSeconds, withinWindow } from '../domain/replayGuard';
import { catalogGameId } from '../domain/types';
import { API_MATIC_HOSTS, ApiMaticAdapter, parseCurrencyMap } from '../infrastructure/adapters/aggregators/ApiMaticAdapter';
import { parseInventory } from '../infrastructure/adapters/aggregators/ApiSlotsAdapter';
import { apiMaticCanonical, apiMaticKey, apiMaticSign, apiMaticVerify, sha256Hex } from '../infrastructure/adapters/aggregators/apiMaticSign';
import { ipAllowed, parseAllowlist } from '../infrastructure/net/ipAllowlist';
import { api, OP, PLAYER, startHub, type HubHarness } from './helpers';

// Vectores literales del contrato de API-Matic y de las pruebas de Astroclub (producción).
const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY = apiMaticKey(SECRET);
const ADMIN = devToken('PLATFORM_ADMIN', '*', 'root');

describe('montos decimales ↔ unidades mínimas', () => {
  it('convierte sin floats y rechaza lo ambiguo', () => {
    expect(decimalToMinor('10.10', 2)).toBe(1010n);
    expect(decimalToMinor('10.1', 2)).toBe(1010n);
    expect(decimalToMinor(10.1, 2)).toBe(1010n);
    expect(decimalToMinor('125', 2)).toBe(12500n);
    expect(decimalToMinor('0.00', 2)).toBe(0n);
    expect(decimalToMinor('9007199254740993.01', 2)).toBe(900719925474099301n);
    expect(decimalToMinor('1.123456', 6)).toBe(1123456n);
    for (const bad of ['abc', '1,5', '10.10 ', ' 1', 'NaN', '0x10', '--1', '-1', '1e5', '1.2.3', '', '.5', '5.'] as unknown[]) {
      expect(() => decimalToMinor(bad, 2), String(bad)).toThrow();
    }
    for (const bad of [true, { v: 1 }, null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) expect(() => decimalToMinor(bad, 2), String(bad)).toThrow();
    expect(() => decimalToMinor('1.005', 2)).toThrow(/decimales/);
  });

  it('formatea con exactamente los decimales de la moneda', () => {
    expect(minorToDecimal(90000n, 2)).toBe('900.00');
    expect(minorToDecimal(0n, 2)).toBe('0.00');
    expect(minorToDecimal(5n, 2)).toBe('0.05');
    expect(minorToDecimal(-525n, 2)).toBe('-5.25');
    expect(minorToDecimal(1n, 8)).toBe('0.00000001');
    expect(minorToDecimal(12n, 0)).toBe('12');
    for (const v of [0n, 1n, 99n, 100n, 123456789n]) expect(decimalToMinor(minorToDecimal(v, 2), 2)).toBe(v);
  });
});

describe('firma de API-Matic', () => {
  it('reproduce el vector conocido del contrato (GET /api/v1/games, cuerpo vacío, la query no se firma)', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(apiMaticSign(KEY, '1790604000', '7f3c9a1e2b4d4e6f8a0b1c2d3e4f5a6b', 'GET', '/api/v1/games', '')).toBe('cfedb7e4f48fbfd7cfcdc3e3d4c3702b15bd365d6c67fb4b8f00bc63b6c788ba');
    expect(apiMaticCanonical('1790604000', 'elnonce', 'POST', '/api/v1/game/launch', 'elhash')).toBe('1790604000\nelnonce\nPOST\n/api/v1/game/launch\nelhash');
  });

  it('cualquier cambio invalida la firma', () => {
    const body = Buffer.from('{"transaction_id":"88213457@sbx","amount":"10.00"}');
    const good = apiMaticSign(KEY, '1790604000', 'n1', 'POST', '/cb', body);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n1', 'POST', '/cb', body)).toBe(true);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n1', 'POST', '/cb?x=1', body)).toBe(false);
    expect(apiMaticVerify(KEY, good, '1790604001', 'n1', 'POST', '/cb', body)).toBe(false);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n2', 'POST', '/cb', body)).toBe(false);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n1', 'GET', '/cb', body)).toBe(false);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n1', 'POST', '/cb', Buffer.from('{"transaction_id":"88213457@sbx","amount":"1000.00"}'))).toBe(false);
    expect(apiMaticVerify(KEY, good, '1790604000', 'n1', 'POST', '/cb', body.subarray(0, body.length - 1))).toBe(false);
    expect(apiMaticVerify(KEY, good.toUpperCase(), '1790604000', 'n1', 'POST', '/cb', body)).toBe(false);
    // Usar el texto hexadecimal como clave (error típico) da otra firma.
    expect(apiMaticSign(Buffer.from(SECRET), '1790604000', 'n1', 'POST', '/cb', body)).not.toBe(good);
    expect(() => apiMaticKey('')).toThrow();
    expect(() => apiMaticKey('xyz')).toThrow();
  });

  it('timestamps, ventana ±300 s y nonces de un solo uso', async () => {
    expect(parseUnixSeconds('1790604000')).toBe(1790604000);
    for (const bad of ['', 'no-soy-un-numero', '1790604000.5', '1790604000ms', ' 1790604000', undefined]) expect(parseUnixSeconds(bad)).toBeNull();
    const now = 1790604000 * 1000;
    expect(withinWindow(1790604000 - 300, now, 300)).toBe(true);
    expect(withinWindow(1790604000 + 300, now, 300)).toBe(true);
    expect(withinWindow(1790604000 - 301, now, 300)).toBe(false);
    expect(withinWindow(1790604000 + 301, now, 300)).toBe(false);
    expect(withinWindow(1790604000 - 7200, now, 300)).toBe(false);
    let t = 0;
    const store = new InMemoryNonceStore(() => t, 3);
    expect(await store.claim('a', 1000)).toBe(true);
    expect(await store.claim('a', 1000)).toBe(false);
    t = 1001;
    expect(await store.claim('a', 1000)).toBe(true);
    for (const k of ['b', 'c', 'd', 'e']) await store.claim(k, 1_000_000);
    expect(await store.claim('e', 1000)).toBe(false); // acotado en memoria sin perder los recientes
  });

  it('una key de producción (ukp_) nunca sale hacia otro host', () => {
    const prod = new ApiMaticAdapter({ apiKey: 'ukp_live', secretHex: SECRET, host: 'https://evil.example', nonces: new InMemoryNonceStore(), logger: silentLogger });
    expect(prod.environment).toBe('produccion');
    expect(prod.apiHost).toBe(API_MATIC_HOSTS.produccion);
    const sbx = new ApiMaticAdapter({ apiKey: 'uks_test', secretHex: SECRET, nonces: new InMemoryNonceStore(), logger: silentLogger });
    expect(sbx.environment).toBe('sandbox');
    expect(sbx.apiHost).toBe(API_MATIC_HOSTS.sandbox);
  });

  it('configuración: mapas de moneda e inventario estrictos; credenciales parciales fallan al arrancar', () => {
    expect(parseCurrencyMap('ARS:ARS_PA, cop:COP')).toEqual({ ARS: 'ARS_PA', COP: 'COP' });
    expect(() => parseCurrencyMap('ARS')).toThrow();
    expect(parseInventory('PragmaticPlay:official,CloneCo:clone')).toEqual({ PragmaticPlay: 'official', CloneCo: 'clone' });
    expect(() => parseInventory('PragmaticPlay:maybe')).toThrow();
    const deps = { nonces: new InMemoryNonceStore(), logger: silentLogger };
    expect(ApiMaticAdapter.fromEnv({}, deps)).toBeNull();
    expect(() => ApiMaticAdapter.fromEnv({ HUB_APIMATIC_API_KEY: 'uks_x' }, deps)).toThrow();
    expect(() => ApiMaticAdapter.fromEnv({ HUB_APIMATIC_API_KEY: 'uks_x', HUB_APIMATIC_SECRET_KEY: 'no-hex' }, deps)).toThrow();
  });
});

describe('allowlist de IP', () => {
  it('IPs sueltas y CIDR (vectores de Astroclub)', () => {
    const list = parseAllowlist('203.0.113.50,198.51.100.0/24');
    for (const ok of ['203.0.113.50', '198.51.100.7', '198.51.100.255', '::ffff:198.51.100.7']) expect(ipAllowed(list, ok), ok).toBe(true);
    for (const no of ['192.0.2.1', '203.0.113.51', '10.0.0.1', '', undefined, 'basura']) expect(ipAllowed(list, no), String(no)).toBe(false);
    expect(ipAllowed(parseAllowlist(''), '10.0.0.1')).toBe(true);
    expect(() => parseAllowlist('300.1.1.1')).toThrow();
    expect(() => parseAllowlist('10.0.0.0/33')).toThrow();
  });
});

// ------------------------------------------------------------------ servidores falsos de los agregadores

interface FakeServer { base: string; calls: Array<{ path: string; headers: Record<string, unknown>; body: any; query: any }>; close(): Promise<void> }

async function listen(app: express.Express): Promise<{ base: string; close(): Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** API-Matic falso: exige firma válida (la query no cuenta) y el cuerpo exacto del contrato en el launch. */
async function fakeApiMatic(): Promise<FakeServer> {
  const app = express();
  const calls: FakeServer['calls'] = [];
  let sessions = 0;
  app.use(express.raw({ type: '*/*' }));
  app.use((req, res, next) => {
    const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
    const ok = apiMaticVerify(KEY, req.header('x-sign'), String(req.header('x-timestamp')), String(req.header('x-nonce')), req.method, req.path, body);
    if (!ok || req.header('x-api-key') !== 'uks_test') return void res.status(401).json({ success: false, error: { code: 'INVALID_SIGNATURE' } });
    calls.push({ path: req.path, headers: req.headers, body: body.length ? JSON.parse(body.toString()) : null, query: req.query });
    next();
  });
  app.get('/api/v1/games', (req, res) => {
    const page = Number(req.query.page);
    const data = page === 1
      ? [
          { uuid: '3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43', code: 'gates', name: 'Gates of Olympus', provider: 'Pragmatic Play', images: [{ role: 'icon', url: 'https://cdn.example/icon.png' }, { role: 'default', url: 'https://cdn.example/gates.png' }] },
          { uuid: '7d1c0a52-6b8e-4f3a-a2c9-0e4b7d9f1a23', code: 'sweet', name: 'Sweet Bonanza', provider: 'Pragmatic Play', images: [{ role: 'icon', url: 'https://cdn.example/sweet.png' }] },
        ]
      : [{ uuid: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', code: 'aviator', name: 'Aviator', provider: 'Spribe', images: [] }];
    res.json({ success: true, data, meta: { page, per_page: 100, total: 3, last_page: 2 } });
  });
  app.post('/api/v1/game/launch', (req, res) => {
    const body = JSON.parse((req.body as Buffer).toString());
    const extra = Object.keys(body).filter((k) => !['player_id', 'currency', 'lang', 'gametype'].includes(k));
    if (extra.length || !req.header('x-game-uuid')) return void res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', extra } });
    sessions += 1;
    res.json({ success: true, data: { link: `https://vendor.example/play/${sessions}`, vendor_session_id: `vs-${sessions}`, session_id: 48213, environment: 'sandbox' } });
  });
  const l = await listen(app);
  return { ...l, calls };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const CB_PATH = '/hub/v1/providers/api-matic/callback/sandbox';

/** Postback firmado como lo envía API-Matic. */
async function postback(base: string, body: Record<string, unknown>, o: { ts?: number; nonce?: string; sign?: string; path?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(o.ts ?? nowSec());
  const nonce = o.nonce ?? randomBytes(16).toString('hex');
  const path = o.path ?? CB_PATH;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Sign': o.sign ?? apiMaticSign(KEY, ts, nonce, 'POST', path, raw) },
    body: raw,
  });
  return { status: res.status, text: await res.text() };
}

describe('API-Matic de punta a punta (catálogo, launch y postbacks contra el ledger)', () => {
  let h: HubHarness;
  let fake: FakeServer;
  let gameId: string;
  let vs: string;

  beforeAll(async () => {
    fake = await fakeApiMatic();
    h = await startHub({ env: { HUB_APIMATIC_API_KEY: 'uks_test', HUB_APIMATIC_SECRET_KEY: SECRET, HUB_APIMATIC_HOST: fake.base, HUB_APIMATIC_CATALOG_CURRENCY: 'USD', HUB_APIMATIC_CURRENCY_MAP: 'USD:USD_PA' } });
    h.wallet.seed(OP, PLAYER, 'USD', 100_000n); // 1000.00
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  const pb = (action: string, extra: Record<string, unknown> = {}) =>
    postback(h.base, { action, type: action, currency: 'USD', session_id: vs, game_uuid: '3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43', player_id: PLAYER, transaction_datetime: '2026-09-28 14:03:15.120447', casino_request_retry_count: 0, ...extra });
  const balanceOf = async () => JSON.parse((await pb('balance', { transaction_id: '' })).text).balance as number;

  it('sincroniza el catálogo paginado (imagen "default", estudio en tags, sin demo)', async () => {
    const r = await api(h.base, 'POST', '/hub/v1/admin/providers/api-matic/sync', undefined, ADMIN);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const listed = await api(h.base, 'GET', '/hub/v1/games?provider=api-matic&pageSize=50');
    expect(listed.body.total).toBe(3);
    gameId = catalogGameId('api-matic', '3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43');
    const g = await api(h.base, 'GET', `/hub/v1/games/${gameId}`);
    expect(g.body).toMatchObject({ title: 'Gates of Olympus', hasDemo: false });
    expect(g.body.images.thumb).toBe('https://cdn.example/gates.png');
    expect(g.body.tags).toEqual(expect.arrayContaining(['aggregator:api-matic', 'studio:Pragmatic Play']));
    const pages = fake.calls.filter((c) => c.path === '/api/v1/games').map((c) => c.query.page);
    expect(pages).toEqual(['1', '2']);
    expect(fake.calls[0].query).toMatchObject({ currency: 'USD', per_page: '100' });
  });

  it('launch firmado: solo player_id/currency/lang, moneda mapeada y vendor_session_id guardado', async () => {
    const r = await api(h.base, 'POST', `/hub/v1/games/${gameId}/launch`, { mode: 'real', currency: 'USD', language: 'es' }, devToken('PLAYER', OP, PLAYER));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.url).toMatch(/^https:\/\/vendor\.example\/play\/\d+$/);
    const call = fake.calls.filter((c) => c.path === '/api/v1/game/launch').at(-1)!;
    expect(call.headers['x-game-uuid']).toBe('3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43');
    expect(call.body).toEqual({ player_id: PLAYER, currency: 'USD_PA', lang: 'es' });
    vs = `vs-${r.body.url.split('/').pop()}`;
    expect((await api(h.base, 'POST', `/hub/v1/games/${gameId}/launch`, { mode: 'demo', currency: 'USD' })).status).toBe(403);
  });

  it('balance responde un número JSON exacto (no string)', async () => {
    const r = await pb('balance', { transaction_id: '' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"balance":1000.00}');
  });

  it('bet debita; sin saldo se rechaza con 200 + INSUFFICIENT_FUNDS', async () => {
    const r = await pb('bet', { transaction_id: '88213457@sbx', round_id: 'r1@sbx', amount: '100.00' });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^\{"balance":900\.00,"transaction_id":"[0-9a-f-]{36}"\}$/);
    const poor = await pb('bet', { transaction_id: 'big@sbx', round_id: 'r9@sbx', amount: '99999.00' });
    expect(poor).toEqual({ status: 200, text: '{"error_code":"INSUFFICIENT_FUNDS"}' });
    expect(await balanceOf()).toBe(900);
  });

  it('win acredita una sola vez aunque llegue dos veces (nonces distintos); el mismo nonce es un replay → 401', async () => {
    // Cuerpo del contrato (borde_test.go): la reentrega trae el mismo contenido con otro nonce/firma y otro orden de claves.
    const win = { action: 'win', type: 'win', amount: '50.00', currency: 'USD', transaction_id: '88213458@sbx', session_id: vs, game_uuid: '3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43', player_id: PLAYER, round_id: 'r1@sbx', transaction_datetime: '2026-09-28 14:03:15.120447', casino_request_retry_count: 0 };
    const nonce = randomBytes(16).toString('hex');
    const first = await postback(h.base, win, { nonce });
    expect(first.status).toBe(200);
    const reordered = Object.fromEntries(Object.entries({ ...win, casino_request_retry_count: 1 }).reverse());
    const again = await postback(h.base, reordered);
    expect(JSON.parse(again.text)).toEqual(JSON.parse(first.text));
    expect(await balanceOf()).toBe(950);
    const replay = await postback(h.base, win, { nonce });
    expect(replay).toEqual({ status: 401, text: '{"error_code":"INVALID_SIGNATURE"}' });
  });

  it('varios wins en la misma ronda (ya liquidada) se acreditan en una sub-ronda, sin duplicar en reentregas', async () => {
    const settled: unknown[] = [];
    const off = h.bus.subscribe('bet.settled', (e) => void settled.push(e));
    expect((await pb('win', { transaction_id: 'w-extra@sbx', round_id: 'r1@sbx', amount: '25.00' })).status).toBe(200);
    expect((await pb('win', { transaction_id: 'w-extra@sbx', round_id: 'r1@sbx', amount: '25.00' })).status).toBe(200);
    await h.bus.drain();
    off();
    expect(await balanceOf()).toBe(975);
    expect(settled).toHaveLength(1);
  });

  it('rollback anticipado de un win: cuando el win llega después, no se acredita y se confirma la entrega', async () => {
    const before = await balanceOf();
    expect((await pb('rollback', { transaction_id: 'rb-early@sbx', rollback_transactions: [{ transaction_id: 'win-tardio@sbx', amount: '100.00', type: 'win' }] })).status).toBe(200);
    const late = await pb('win', { transaction_id: 'win-tardio@sbx', round_id: 'r2@sbx', amount: '100.00' });
    expect(late.status).toBe(200);
    expect(JSON.parse(late.text)).toEqual({ balance: before });
    expect(await balanceOf()).toBe(before);
  });

  it('refund antes de la apuesta: la apuesta tardía se rechaza con BET_ALREADY_REFUNDED', async () => {
    expect((await pb('refund', { transaction_id: 'rf-early@sbx', bet_transaction_id: 'refund-bet-tardio@sbx', amount: '10.00' })).status).toBe(200);
    const late = await pb('bet', { transaction_id: 'refund-bet-tardio@sbx', round_id: 'r3@sbx', amount: '10.00' });
    expect(late).toEqual({ status: 200, text: '{"error_code":"BET_ALREADY_REFUNDED"}' });
  });

  it('bet + refund + rollback de la misma apuesta deja el saldo intacto (cada tx se revierte una sola vez)', async () => {
    const start = await balanceOf();
    await pb('bet', { transaction_id: 'b200@sbx', round_id: 'r4@sbx', amount: '200.00' });
    expect(await balanceOf()).toBe(start - 200);
    await pb('refund', { transaction_id: 'rf200@sbx', bet_transaction_id: 'b200@sbx', amount: '200.00' });
    await pb('rollback', { transaction_id: 'rb200@sbx', rollback_transactions: [{ transaction_id: 'b200@sbx', amount: '200.00', type: 'bet' }] });
    expect(await balanceOf()).toBe(start);
  });

  it('bet y win con el MISMO transaction_id se registran por separado y un rollback de ambos vuelve al inicio', async () => {
    const start = await balanceOf();
    await pb('bet', { transaction_id: 'mismo@sbx', round_id: 'r5@sbx', amount: '100.00' });
    await pb('win', { transaction_id: 'mismo@sbx', round_id: 'r5@sbx', amount: '250.00' });
    expect(await balanceOf()).toBe(start + 150);
    const rb = await pb('rollback', { transaction_id: 'rb-mismo@sbx', rollback_transactions: [{ transaction_id: 'mismo@sbx', type: 'bet' }, { transaction_id: 'mismo@sbx', type: 'win' }] });
    expect(rb.status).toBe(200);
    expect(await balanceOf()).toBe(start);
  });

  it('un win ya gastado no deja saldo negativo: la reversión se registra y no se aplica', async () => {
    h.wallet.seed(OP, 'p-pobre', 'USD', 0n);
    const launch = await api(h.base, 'POST', `/hub/v1/games/${gameId}/launch`, { mode: 'real', currency: 'USD' }, devToken('PLAYER', OP, 'p-pobre'));
    const vs2 = `vs-${launch.body.url.split('/').pop()}`;
    const send = (action: string, extra: Record<string, unknown>) => postback(h.base, { action, session_id: vs2, ...extra });
    await send('win', { transaction_id: 'gw@sbx', round_id: 'rg', amount: '30.00' });
    await send('bet', { transaction_id: 'gb@sbx', round_id: 'rg2', amount: '30.00' });
    const rb = await send('rollback', { transaction_id: 'rb-g@sbx', rollback_transactions: [{ transaction_id: 'gw@sbx', type: 'win' }] });
    expect(rb.status).toBe(200);
    expect(JSON.parse(rb.text).balance).toBe(0);
  });

  it('rechazos del borde y del contenido', async () => {
    expect(await pb('balance', { session_id: 'no-existe', transaction_id: '' })).toEqual({ status: 200, text: '{"error_code":"UNKNOWN_SESSION"}' });
    expect((await postback(h.base, { action: 'balance', session_id: vs }, { path: '/hub/v1/providers/api-matic/callback/produccion' })).status).toBe(503);
    expect((await postback(h.base, { action: 'balance', session_id: vs }, { sign: '0'.repeat(64) })).status).toBe(401);
    expect((await postback(h.base, { action: 'balance', session_id: vs }, { ts: nowSec() - 301 })).status).toBe(401);
    expect((await postback(h.base, { action: 'balance', session_id: vs }, { ts: nowSec() - 299 })).status).toBe(200);
    expect((await postback(h.base, { action: 'balance', session_id: vs }, { nonce: 'n'.repeat(129) })).status).toBe(401);
    expect((await pb('bet', { transaction_id: 'sin-monto@sbx' })).status).toBe(400);
    expect((await pb('rollback', { transaction_id: 'rb-vacio@sbx', rollback_transactions: [] })).status).toBe(400);
    expect((await pb('bet', { transaction_id: 'tres-dec@sbx', round_id: 'r6', amount: '1.005' })).status).toBe(400);
    expect((await pb('nada', { transaction_id: 'x' })).status).toBe(400);
    // Mismo transaction_id con otro contenido: se rechaza (nunca se debita dos veces).
    const before = await balanceOf();
    expect(await pb('bet', { transaction_id: '88213457@sbx', round_id: 'r1@sbx', amount: '5.00' })).toEqual({ status: 200, text: '{"error_code":"DUPLICATE_TRANSACTION"}' });
    expect(await balanceOf()).toBe(before);
  });

  it('allowlist de IP: una IP fuera de la lista recibe 403', async () => {
    const h2 = await startHub({ env: { HUB_APIMATIC_API_KEY: 'uks_test', HUB_APIMATIC_SECRET_KEY: SECRET, HUB_APIMATIC_HOST: fake.base, HUB_APIMATIC_ALLOWED_IPS: '203.0.113.0/24' } });
    try {
      expect((await postback(h2.base, { action: 'balance', session_id: 'x' })).status).toBe(403);
    } finally {
      await h2.close();
    }
  });
});

// ------------------------------------------------------------------ API-Slots

async function fakeApiSlots(opts: { failFirst?: number } = {}): Promise<FakeServer & { catalogHits: number }> {
  const app = express();
  app.use(express.json());
  const calls: FakeServer['calls'] = [];
  const state = { catalogHits: 0 };
  app.get('/api/allgamelist', (_req, res) => {
    state.catalogHits += 1;
    if (state.catalogHits <= (opts.failFirst ?? 0)) return void res.status(503).send('busy');
    res.json({
      slots: [
        { symbol: 'vs20olympgate', name: 'Gates of Olympus', status: true, imageurl: 'img/gates.png', provider_code: { provider_code: 'PragmaticPlay', provider_name: 'Pragmatic Play' } },
        { symbol: 'vs20off', name: 'Apagado', status: false, imageurl: 'x.png', provider_code: { provider_code: 'PragmaticPlay', provider_name: 'Pragmatic Play' } },
        { symbol: 'copy1', name: 'Copia', status: true, imageurl: 'https://img.example/copy.png', provider_code: { provider_code: 'CloneCo', provider_name: 'Clone Co' } },
        { symbol: 'mystery', name: 'Sin clasificar', status: true, imageurl: null, provider_code: { provider_code: 'Mystery', provider_name: 'Mystery' } },
      ],
    });
  });
  app.post('/api/playGame.do', (req, res) => {
    calls.push({ path: req.path, headers: req.headers, body: req.body, query: req.query });
    if (req.body.api_key !== 'the-provider-key') return void res.status(401).json({ message: `bad key the-provider-key` });
    res.json({ meta: { session_id: `sess-${calls.length}` }, url: 'https://games.example/play' });
  });
  const l = await listen(app);
  return { ...l, calls, get catalogHits() { return state.catalogHits; } };
}

describe('API-Slots de punta a punta', () => {
  let h: HubHarness;
  let fake: Awaited<ReturnType<typeof fakeApiSlots>>;
  let sess: string;
  const KEY_OK = 'the-provider-key';

  beforeAll(async () => {
    fake = await fakeApiSlots({ failFirst: 2 });
    h = await startHub({ env: { HUB_APISLOTS_API_URL: fake.base, HUB_APISLOTS_PARTNER_ID: 'partner-1', HUB_APISLOTS_API_KEY: KEY_OK, HUB_APISLOTS_GAME_TYPES: 'PragmaticPlay:official,CloneCo:clone' } });
    h.wallet.seed(OP, PLAYER, 'USD', 100_000n);
  });
  afterAll(async () => {
    await h.close();
    await fake.close();
  });

  const cb = async (body: Record<string, unknown>) => {
    const res = await fetch(`${h.base}/hub/v1/providers/api-slots/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: KEY_OK, player_id: PLAYER, session_id: sess, ...body }) });
    return { status: res.status, text: await res.text() };
  };

  it('catálogo con reintentos ante 503; solo juegos oficiales y activos; imagen relativa al CDN', async () => {
    const r = await api(h.base, 'POST', '/hub/v1/admin/providers/api-slots/sync', undefined, ADMIN);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.catalogHits).toBe(3);
    const listed = await api(h.base, 'GET', '/hub/v1/games?provider=api-slots&pageSize=50');
    expect(listed.body.items.map((g: { title: string }) => g.title)).toEqual(['Gates of Olympus']);
    expect(listed.body.items[0].images.thumb).toBe('https://cdn.api-slots.network/img/gates.png');
    expect(listed.body.items[0].tags).toEqual(expect.arrayContaining(['license:official', 'studio:Pragmatic Play']));
  });

  it('launch: cuerpo del contrato y session_id del proveedor', async () => {
    const id = catalogGameId('api-slots', 'PragmaticPlay:vs20olympgate');
    const r = await api(h.base, 'POST', `/hub/v1/games/${id}/launch`, { mode: 'real', currency: 'USD' }, devToken('PLAYER', OP, PLAYER));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.url).toBe('https://games.example/play');
    expect(fake.calls.at(-1)!.body).toEqual({ symbol: 'vs20olympgate', provider: 'PragmaticPlay', currency: 'USD', partner: 'partner-1', api_key: KEY_OK, player_id: PLAYER, lang: 'en' });
    sess = `sess-${fake.calls.length}`;
  });

  it('session_info, bet, sin saldo, win y montos inválidos con las respuestas exactas del protocolo', async () => {
    expect(await cb({ method: 'session_info' })).toEqual({ status: 200, text: '{"balance":"1000.00","currency":"USD","status":"ok"}\n' });
    expect(await cb({ method: 'bet', amount: 100, meta: { transaction: 'tx-bet-1', symbol: 'vs20olympgate', round_id: 'r1' } })).toEqual({ status: 200, text: '{"balance":"900.00","currency":"USD","status":"ok"}\n' });
    expect(await cb({ method: 'bet', amount: 5000, meta: { transaction: 'tx-bet-2', round_id: 'r2' } })).toEqual({ status: 200, text: '{"balance":"900.00","currency":"USD","message":"INSUFFICIENT_FUNDS","status":"error"}\n' });
    expect(await cb({ method: 'win', amount: '250', meta: { transaction: 'tx-win-1', round_id: 'r1' } })).toEqual({ status: 200, text: '{"balance":"1150.00","currency":"USD","status":"ok"}\n' });
    expect(await cb({ method: 'bet', amount: 10, meta: {} })).toEqual({ status: 400, text: '{"message":"missing transaction id","status":"error"}\n' });
    for (const amount of [-100, 0, '-5000']) {
      expect(await cb({ method: 'bet', amount, meta: { transaction: `neg-${amount}` } }), String(amount)).toEqual({ status: 400, text: '{"message":"invalid amount","status":"error"}\n' });
    }
    expect((await cb({ method: 'bet', amount: '1.005', meta: { transaction: 'dec3' } })).text).toBe('{"message":"amount has more than two decimals","status":"error"}\n');
  });

  it('autenticación: api_key exacta, sesión del mismo jugador', async () => {
    for (const k of ['wrong-key', '', 'the-provider-ke', 'the-provider-keyy']) expect((await cb({ method: 'session_info', api_key: k })).status, k).toBe(403);
    expect((await cb({ method: 'session_info', player_id: 'otro' })).status).toBe(403);
    expect((await cb({ method: 'session_info', session_id: 'no-existe' })).status).toBe(403);
  });

  it('rollback: anula la apuesta referenciada; sin referencia 400; desconocida → la apuesta tardía se rechaza', async () => {
    await cb({ method: 'bet', amount: 40, meta: { transaction: 'tx-rb', round_id: 'r7' } });
    expect((await cb({ method: 'rollback', meta: { transaction: 'rb-1', ref_transaction: 'tx-rb' } })).text).toBe('{"balance":"1150.00","currency":"USD","status":"ok"}\n');
    expect(await cb({ method: 'rollback', meta: { transaction: 'rb-2' } })).toEqual({ status: 400, text: '{"message":"missing original transaction reference","status":"error"}\n' });
    expect((await cb({ method: 'rollback', meta: { transaction: 'rb-3', original_transaction: 'tx-futura' } })).status).toBe(200);
    expect((await cb({ method: 'bet', amount: 10, meta: { transaction: 'tx-futura', round_id: 'r8' } })).text).toBe('{"balance":"1150.00","currency":"USD","message":"TRANSACTION_ROLLED_BACK","status":"error"}\n');
  });

  it('round_info valida el estado; método desconocido 400', async () => {
    for (const status of ['start', 'started', 'finish', 'finished']) expect((await cb({ method: 'round_info', status })).status, status).toBe(200);
    expect((await cb({ method: 'round_info', status: 'cualquiera' })).status).toBe(400);
    expect(await cb({ method: 'hackear' })).toEqual({ status: 400, text: '{"message":"unknown method","status":"error"}\n' });
  });
});
