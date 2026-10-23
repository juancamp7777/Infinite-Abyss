import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { passimpaySignature, sha256Hex } from '../../src/domain/payments/signature';
import { PaymentProviderRegistry } from '../../src/infrastructure/payments/PaymentProviderRegistry';
import { PassimpayProvider } from '../../src/infrastructure/payments/PassimpayProvider';
import { WompiProvider } from '../../src/infrastructure/payments/WompiProvider';
import type { FetchLike } from '../../src/infrastructure/payments/types';
import { createBackofficeUser, createTestOperator, createTestPlayer, TEST_PASSWORD, type TestOperator } from '../setup/factories';

const PASSIMPAY = { platformId: '4242', apiKey: 'e2e-passimpay-key', baseUrl: 'https://psp.test', webhookIpAllowlist: [] as string[] };
const WOMPI = {
  publicKey: 'e2e-wompi-public',
  privateKey: 'e2e-wompi-private',
  eventsSecret: 'e2e-wompi-events',
  integritySecret: 'e2e-wompi-integrity',
  baseUrl: 'https://wompi.test/v1',
};

const fetchCalls: string[] = [];
/** PSP falso: createorder devuelve link, orderstatus → paid, withdraw → ok. */
const fakeFetch: FetchLike = async (url) => {
  fetchCalls.push(url);
  let body: Record<string, unknown> = { result: 1 };
  if (url.endsWith('/v2/createorder')) body = { result: 1, url: 'https://psp.test/invoice/abc' };
  else if (url.endsWith('/v2/orderstatus')) body = { result: 1, status: 'paid' };
  else if (url.includes('/transactions')) body = { data: { id: 'w-tx', status: 'APPROVED' } };
  else if (url.endsWith('/v2/withdraw')) body = { result: 1, order_id: `psp-${randomUUID()}` };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

/** Rutas permitidas (lista blanca explícita). Las que pueden mover dinero están marcadas. */
const MONEY_MOVING_ROUTES = new Set([
  'POST /api/webhooks/:provider', // acredita solo con firma verificada + confirmación del PSP
  'POST /api/backoffice/players/:id/adjustments', // ajuste manual con rol, motivo y AuditLog
  'POST /api/backoffice/withdrawals/:id/approve', // mueve fondos de reserva; solo backoffice con AuditLog
  'POST /api/backoffice/withdrawals/:id/reject', // libera la reserva al jugador; backoffice con AuditLog
  'POST /api/backoffice/withdrawals/:id/mark-paid', // completa el retiro; backoffice con AuditLog
  'POST /api/cashier/withdrawals', // reserva fondos propios del jugador (no acredita)
]);

const EXPECTED_ROUTES = new Set<string>([
  ...MONEY_MOVING_ROUTES,
  'GET /health',
  'GET /api/operator/brand',
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'GET /api/me',
  'POST /api/backoffice/auth/login',
  // Verificación en dos pasos de la propia cuenta (no mueve dinero).
  'GET /api/backoffice/auth/2fa',
  'POST /api/backoffice/auth/2fa/setup',
  'POST /api/backoffice/auth/2fa/enable',
  'POST /api/backoffice/auth/2fa/disable',
  'GET /api/me/limits',
  'PUT /api/me/limits',
  'POST /api/me/self-exclusion',
  'POST /api/me/cool-off',
  'POST /api/me/kyc/submit',
  'PUT /api/backoffice/players/:id/kyc',
  'GET /api/backoffice/reconciliation',
  'GET /api/backoffice/stats',
  'GET /api/backoffice/withdrawals/', // listado de retiros (solo lectura, backoffice)
  'GET /api/cashier/methods',
  'POST /api/cashier/deposits',
  'GET /api/cashier/withdrawals',
  'GET /api/cashier/transactions',
]);

/** Recorre el router de Express 5 reconstruyendo `METHOD /ruta` con los prefijos de montaje conocidos. */
function listRoutes(app: any): string[] {
  const prefixes = ['/api/webhooks', '/api/cashier', '/api/backoffice/withdrawals'];
  const out: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
      } else if (layer.handle?.stack) {
        const matched = prefixes.find((p) => layer.matchers?.[0]?.(p));
        walk(layer.handle.stack, matched ?? prefix);
      }
    }
  };
  walk(app.router.stack, '');
  return out;
}

let created: CreatedApp;
let base: string;
let url: string;
const sockets: Socket[] = [];

const withTenant = (slug: string) => ({ 'X-Operator-Slug': slug });
const emit = (s: Socket, event: string, payload: unknown): Promise<any> =>
  new Promise((resolve) => s.emit(event, payload, resolve));
const connectSocket = (token: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });

beforeAll(async () => {
  const registry = new PaymentProviderRegistry([
    new PassimpayProvider(PASSIMPAY, fakeFetch),
    new WompiProvider(WOMPI, fakeFetch),
  ]);
  // Sin módulos Infinite Abyss: esta prueba audita la lista blanca de rutas de dinero de la Fase 1; el cableado de los
  // módulos se prueba en tests/modules-wiring y el flujo completo con módulos en tests/e2e/modulesFullFlow.test.ts.
  created = createApp(getConfig(), { registry, bcryptCost: 4, rateLimit: { disabled: true } as any, modules: false });
  await new Promise<void>((r) => created.httpServer.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(created.httpServer.address() as AddressInfo).port}`;
  base = url;
});

afterAll(async () => {
  sockets.forEach((s) => s.close());
  await created.close();
});

function passimpayWebhook(body: object, key = PASSIMPAY.apiKey) {
  const raw = JSON.stringify(body);
  return { raw, signature: passimpaySignature(PASSIMPAY.platformId, raw, key) };
}

function wompiWebhook(ref: string, txId: string, cents: bigint, secret = WOMPI.eventsSecret) {
  const timestamp = 1_700_000_000;
  const status = 'APPROVED';
  const checksum = sha256Hex(`${txId}${status}${cents}${timestamp}${secret}`);
  const body = {
    event: 'transaction.updated',
    data: { transaction: { id: txId, reference: ref, status, amount_in_cents: Number(cents), currency: 'COP' } },
    timestamp,
    signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum },
  };
  return { raw: JSON.stringify(body), checksum };
}

describe('flujo completo (e2e)', () => {
  it('registro → depósitos → juegos → retiro → reconciliación en 0', async () => {
    const api = request(created.app);
    const op: TestOperator = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
    const T = withTenant(op.slug);

    // 1. Registro y login
    const email = `e2e-${randomUUID().slice(0, 8)}@test.local`;
    const reg = await api.post('/api/auth/register').set(T).send({ email, password: TEST_PASSWORD });
    expect(reg.status).toBe(201);
    const login = await api.post('/api/auth/login').set(T).send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const token: string = login.body.accessToken;
    const userId: string = login.body.user.id;
    const auth = { ...T, Authorization: `Bearer ${token}` };
    const balance = async (): Promise<bigint> => {
      const me = await api.get('/api/me').set(auth);
      expect(me.status).toBe(200);
      return BigInt(me.body.balances.cash);
    };

    // 2. Depósito Passimpay
    const AMOUNT_P = 500_000n;
    const dp = await api.post('/api/cashier/deposits').set(auth).send({ provider: 'PASSIMPAY', amount: AMOUNT_P.toString(), currency: 'COP' });
    expect(dp.status).toBe(201);
    const depP = await prisma.deposit.findFirstOrThrow({ where: { userId, provider: 'PASSIMPAY' } });

    // 2a. Webhook con firma inválida → 401 y sin saldo
    const bad = passimpayWebhook({ order_id: depP.providerReference, status: 'paid', txhash: `tx-${randomUUID()}` }, 'clave-falsa');
    const badRes = await api.post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', bad.signature).send(bad.raw);
    expect(badRes.status).toBe(401);
    expect(await balance()).toBe(0n);

    // 2b. Webhook firmado → acredita; reenvío → sin cambio
    const good = passimpayWebhook({ order_id: depP.providerReference, status: 'paid', txhash: `tx-${randomUUID()}`, platform_id: 4242 });
    const send = () => api.post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', good.signature).send(good.raw);
    const first = await send();
    expect(first.status).toBe(200);
    expect(await balance()).toBe(AMOUNT_P);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await balance()).toBe(AMOUNT_P);

    // 3. Depósito Wompi
    const AMOUNT_W = 300_000n;
    const dw = await api.post('/api/cashier/deposits').set(auth).send({ provider: 'WOMPI', amount: AMOUNT_W.toString(), currency: 'COP' });
    expect(dw.status).toBe(201);
    const depW = await prisma.deposit.findFirstOrThrow({ where: { userId, provider: 'WOMPI' } });
    const badW = wompiWebhook(depW.providerReference, `w-${randomUUID()}`, AMOUNT_W, 'secreto-falso');
    expect((await api.post('/api/webhooks/wompi').set('content-type', 'application/json').send(badW.raw)).status).toBe(401);
    const goodW = wompiWebhook(depW.providerReference, `w-${randomUUID()}`, AMOUNT_W);
    const sendW = () => api.post('/api/webhooks/wompi').set('content-type', 'application/json').set('x-event-checksum', goodW.checksum).send(goodW.raw);
    expect((await sendW()).status).toBe(200);
    expect((await sendW()).status).toBe(200);
    const DEPOSITED = AMOUNT_P + AMOUNT_W;
    expect(await balance()).toBe(DEPOSITED);

    // 4. Juegos por socket autenticado
    const s = await connectSocket(token);
    let expected = DEPOSITED;
    const BET = 1_000n;

    const slots = await emit(s, 'playSlots', { amount: BET.toString() });
    expect(slots.success).toBe(true);
    expected = expected - BET + BigInt(slots.data.payout);
    expect(BigInt(slots.data.newBalance)).toBe(expected);

    const roulette = await emit(s, 'placeBet', { type: 'color', value: 'red', amount: BET.toString() });
    expect(roulette.success).toBe(true);
    expected = expected - BET + BigInt(roulette.data.payout);
    expect(BigInt(roulette.data.newBalance)).toBe(expected);

    const plinko = await emit(s, 'plinko:drop', { amount: BET.toString(), rows: 8, risk: 'LOW' });
    expect(plinko.success).toBe(true);
    expected = expected - BET + BigInt(plinko.data.payout);
    expect(BigInt(plinko.data.newBalance)).toBe(expected);

    const mines = await emit(s, 'mines:start', { amount: BET.toString(), numMines: 3 });
    expect(mines.success).toBe(true);
    expected -= BET;
    expect(BigInt(mines.data.newBalance)).toBe(expected);
    const reveal = await emit(s, 'mines:reveal', { sessionId: mines.data.session.id, index: 0 });
    expect(reveal.success).toBe(true);
    if (reveal.data.session.status === 'ACTIVE') {
      const cash = await emit(s, 'mines:cashout', { sessionId: mines.data.session.id });
      expect(cash.success).toBe(true);
      expected = BigInt(cash.data.newBalance);
    } else {
      expected = BigInt(reveal.data.newBalance); // perdida (o completada): el saldo lo informa el servidor
    }

    const bj = await emit(s, 'blackjack:start', { amount: BET.toString() });
    expect(bj.success).toBe(true);
    if (bj.data.session.status === 'ACTIVE') {
      const stand = await emit(s, 'blackjack:stand', { sessionId: bj.data.session.id });
      expect(stand.success).toBe(true);
      expected = BigInt(stand.data.newBalance);
    } else {
      expected = BigInt(bj.data.newBalance);
    }
    // El saldo informado por el socket coincide con el de la API (y con el ledger, ver reconciliación).
    expect(await balance()).toBe(expected);
    const afterGames = expected;
    s.close();

    // Un socket sin token o con userId del cliente es rechazado
    await expect(
      new Promise((_, reject) => {
        const bad = connect(url, { auth: { userId } as any, transports: ['websocket'], reconnection: false });
        sockets.push(bad);
        bad.on('connect_error', (e) => reject(e));
      }),
    ).rejects.toThrow('UNAUTHORIZED');

    // 5. KYC por backoffice → retiro → aprobación y pago
    const admin = await createBackofficeUser('OPERATOR_ADMIN', op.id);
    const finance = await createBackofficeUser('OPERATOR_FINANCE', op.id);
    const loginBo = async (u: { email: string }) => {
      const r = await api.post('/api/backoffice/auth/login').send({ email: u.email, password: TEST_PASSWORD });
      expect(r.status).toBe(200);
      return { Authorization: `Bearer ${r.body.accessToken}` };
    };
    const adminH = await loginBo(admin);
    const financeH = await loginBo(finance);

    // sin KYC no se puede retirar
    const WD = 200_000n;
    const wdBody = { provider: 'WOMPI', amount: WD.toString(), currency: 'COP', destination: { account: '1234567890' } };
    const noKyc = await api.post('/api/cashier/withdrawals').set(auth).send(wdBody);
    expect(noKyc.status).toBeGreaterThanOrEqual(400);
    expect(await balance()).toBe(afterGames);

    const kyc = await api.put(`/api/backoffice/players/${userId}/kyc`).set(adminH).send({ status: 'VERIFIED' });
    expect(kyc.status).toBe(200);

    const wd = await api.post('/api/cashier/withdrawals').set(auth).send(wdBody);
    expect(wd.status).toBe(201);
    expect(await balance()).toBe(afterGames - WD); // reservado
    const approve = await api.post(`/api/backoffice/withdrawals/${wd.body.id}/approve`).set(financeH);
    expect(approve.status).toBe(200);
    const paid = await api.post(`/api/backoffice/withdrawals/${wd.body.id}/mark-paid`).set(financeH);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(await balance()).toBe(afterGames - WD);

    // 6. Reconciliación: 0 discrepancias
    const rec = await api.get(`/api/backoffice/reconciliation?operatorId=${op.id}`).set(financeH);
    expect(rec.status).toBe(200);
    expect(rec.body.totalDiscrepancies).toBe(0);

    // 7. Aislamiento: un jugador de otro operador no ve nada del primero
    const op2 = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
    const other = await createTestPlayer(op2.id, { currency: 'COP' });
    const otherLogin = await api.post('/api/auth/login').set(withTenant(op2.slug)).send({ email: other.email, password: TEST_PASSWORD });
    const otherAuth = { ...withTenant(op2.slug), Authorization: `Bearer ${otherLogin.body.accessToken}` };
    expect(await prisma.user.count({ where: { operatorId: op2.id } })).toBe(1);
    const otherTx = await api.get('/api/cashier/transactions').set(otherAuth);
    expect(otherTx.status).toBe(200);
    expect(JSON.stringify(otherTx.body)).not.toContain(userId);
    const otherWd = await api.get('/api/cashier/withdrawals').set(otherAuth);
    expect(JSON.stringify(otherWd.body)).not.toContain(wd.body.id);
    // el token del operador 1 no vale en el tenant 2
    const cross = await api.get('/api/me').set({ ...withTenant(op2.slug), Authorization: `Bearer ${token}` });
    expect(cross.status).toBe(403);
    // el admin del operador 1 no puede consultar la reconciliación del operador 2
    const crossRec = await api.get(`/api/backoffice/reconciliation?operatorId=${op2.id}`).set(financeH);
    expect(crossRec.status).toBe(403);
    // ...y la reconciliación del 2 no incluye nada del 1
    const rec2 = await created.services.reconciliationService.run({ operatorId: op2.id });
    expect(rec2.totalDiscrepancies).toBe(0);
  }, 60_000);

  it('no existe ningún endpoint que acredite dinero fuera de la lista blanca', () => {
    const routes = new Set(listRoutes(created.app));
    expect([...routes].sort()).toEqual([...EXPECTED_ROUTES].sort());
    // Los endpoints antiguos no existen
    for (const r of routes) {
      expect(r).not.toMatch(/deposits\/crypto|admin\/stats/);
    }
  });

  it('POST /api/deposits/crypto y /api/admin/stats ya no existen', async () => {
    const api = request(created.app);
    expect((await api.post('/api/deposits/crypto').send({ userId: 'x', amount: 1 })).status).toBe(404);
    expect((await api.get('/api/admin/stats')).status).toBe(404);
  });

  it('GET /health comprueba la base de datos', async () => {
    const res = await request(base).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe('up');
  });
});
