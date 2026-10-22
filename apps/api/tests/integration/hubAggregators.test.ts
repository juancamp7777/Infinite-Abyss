import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { catalogGameId } from '../../src/modules/hub/domain/types';
import { apiMaticKey, apiMaticSign, apiMaticVerify } from '../../src/modules/hub/infrastructure/adapters/aggregators/apiMaticSign';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { accountBalance, assertOperatorLedgerBalanced, bearer, buildIntegrationApp, expectReconciled, fundPlayer, jwt, playerToken } from './helpers';

// API-Matic de punta a punta sobre la app real (Prisma + ledger de doble partida de la Fase 1).

/** Secreto de PRUEBA (vector del contrato de API-Matic), no es una credencial real. */
const SECRET = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY = apiMaticKey(SECRET);
const GAME_UUID = '3f6b2c1e-8d4a-4f7b-9c2e-5a1d0b7e9f43';
const CB = '/hub/v1/providers/api-matic/callback/sandbox';

let created: CreatedApp;
let fake: { base: string; close(): Promise<void> };
let sessions = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.raw({ type: '*/*' }));
  app.use((req, res, next) => {
    const body = req.body instanceof Buffer ? req.body : Buffer.alloc(0);
    if (!apiMaticVerify(KEY, req.header('x-sign'), String(req.header('x-timestamp')), String(req.header('x-nonce')), req.method, req.path, body)) return void res.status(401).end();
    next();
  });
  app.get('/api/v1/games', (_req, res) => res.json({ success: true, data: [{ uuid: GAME_UUID, name: 'Gates of Olympus', provider: 'Pragmatic Play', images: [] }], meta: { page: 1, last_page: 1 } }));
  app.post('/api/v1/game/launch', (_req, res) => {
    sessions += 1;
    res.json({ success: true, data: { link: `https://vendor.example/play/${sessions}`, vendor_session_id: `it-vs-${randomUUID()}` } });
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  fake = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  created = await buildIntegrationApp({
    moduleEnv: { HUB_APIMATIC_API_KEY: 'uks_test', HUB_APIMATIC_SECRET_KEY: SECRET, HUB_APIMATIC_HOST: fake.base, HUB_APIMATIC_CATALOG_CURRENCY: 'USD' },
  });
  const root = await createBackofficeUser('PLATFORM_ADMIN', null);
  const sync = await request(created.app)
    .post('/hub/v1/admin/providers/api-matic/sync')
    .set(bearer(jwt.signAccess({ sub: root.id, op: '', typ: 'backoffice', role: 'PLATFORM_ADMIN' })));
  expect(sync.status, JSON.stringify(sync.body)).toBe(200);
});

afterAll(async () => {
  await created.close();
  await fake.close();
});

function postback(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  return request(created.app)
    .post(CB)
    .set({ 'Content-Type': 'application/json', 'X-Timestamp': ts, 'X-Nonce': nonce, 'X-Sign': apiMaticSign(KEY, ts, nonce, 'POST', CB, raw) })
    .send(raw);
}

async function setup(funds: bigint) {
  const op = await createTestOperator();
  const player = await createTestPlayer(op.id);
  await fundPlayer(created, op.id, player.id, 'USD', funds);
  const launch = await request(created.app)
    .post(`/hub/v1/games/${catalogGameId('api-matic', GAME_UUID)}/launch`)
    .set(bearer(playerToken(player.id, op.id)))
    .send({ mode: 'real', currency: 'USD' });
  expect(launch.status, JSON.stringify(launch.body)).toBe(201);
  const row = await prisma.hubSession.findUnique({ where: { id: launch.body.sessionId } });
  expect(row?.externalSessionId).toMatch(/^it-vs-/);
  return { op, player, vs: row!.externalSessionId! };
}

describe('API-Matic sobre el ledger real', () => {
  it('bet, win, reentrega, refund y rollback mueven el ledger exacto, cuadrado y conciliado', async () => {
    const { op, player, vs } = await setup(100_000n); // 1000.00 USD
    // La BD de pruebas se comparte entre corridas: ids únicos por ejecución (como los de API-Matic).
    const u = randomUUID().slice(0, 8);
    const id = (s: string) => `${s}-${u}@sbx`;
    const pb = (action: string, extra: Record<string, unknown>) => postback({ action, type: action, currency: 'USD', session_id: vs, game_uuid: GAME_UUID, player_id: player.id, ...extra });

    const bet = await pb('bet', { transaction_id: id('it-b1'), round_id: id('it-r1'), amount: '100.00' });
    expect(bet.status).toBe(200);
    expect(bet.text).toMatch(/^\{"balance":900\.00,/);

    const win = await pb('win', { transaction_id: id('it-w1'), round_id: id('it-r1'), amount: '250.50' });
    expect(win.text).toMatch(/^\{"balance":1150\.50,/);
    const redelivered = await pb('win', { transaction_id: id('it-w1'), round_id: id('it-r1'), amount: '250.50', casino_request_retry_count: 1 });
    expect(redelivered.text).toBe(win.text);

    await pb('bet', { transaction_id: id('it-b2'), round_id: id('it-r2'), amount: '40.00' });
    await pb('refund', { transaction_id: id('it-rf2'), bet_transaction_id: id('it-b2'), amount: '40.00' });
    const rb = await pb('rollback', { transaction_id: id('it-rb2'), rollback_transactions: [{ transaction_id: id('it-b2'), type: 'bet' }] });
    expect(rb.text).toMatch(/^\{"balance":1150\.50,/);

    expect(await pb('bet', { transaction_id: id('it-big'), round_id: id('it-r3'), amount: '99999.00' }).then((r) => r.text)).toBe('{"error_code":"INSUFFICIENT_FUNDS"}');

    expect(await accountBalance(op.id, 'PLAYER_CASH', 'USD', player.id)).toBe(115_050n);
    expect(await accountBalance(op.id, 'HOUSE', 'USD')).toBe(10_000n - 25_050n);
    await assertOperatorLedgerBalanced(op.id);
    await expectReconciled(created, op.id);
  });

  it('el id de sesión del proveedor es único por proveedor (índice en BD)', async () => {
    const { vs } = await setup(1_000n);
    const other = await setup(1_000n);
    await expect(prisma.hubSession.update({ where: { providerId_externalSessionId: { providerId: 'api-matic', externalSessionId: other.vs } }, data: { externalSessionId: vs } })).rejects.toThrow();
  });

  it('postback de una sesión de otro operador nunca toca su saldo: sesión desconocida → UNKNOWN_SESSION', async () => {
    const r = await postback({ action: 'bet', session_id: `inexistente-${randomUUID()}`, transaction_id: 'x', amount: '1.00' });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"error_code":"UNKNOWN_SESSION"}');
  });
});
