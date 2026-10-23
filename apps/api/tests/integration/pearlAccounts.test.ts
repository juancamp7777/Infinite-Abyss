import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt, playerToken } from './helpers';

let created: CreatedApp;
let admin: string;
let opId: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

const add = (body: Record<string, unknown>) => request(created.app).post('/pearl/v1/admin/accounts').set(bearer(admin)).send(body);

describe('Binance USDT', () => {
  it('guarda la llave cifrada sin devolverla nunca y valida la tasa USDT', async () => {
    const feeds = '/pearl/v1/admin/feeds';
    expect((await request(created.app).post(feeds).set(bearer(admin)).send({ type: 'binance' })).status).toBe(400);
    const ok = await request(created.app).post(feeds).set(bearer(admin)).send({ type: 'binance', apiKey: 'k'.repeat(64), apiSecret: 's'.repeat(64) });
    expect(ok.status).toBe(201);
    expect(ok.body.feed).toMatchObject({ type: 'binance', name: 'Binance USDT' });
    expect(JSON.stringify(ok.body)).not.toContain('s'.repeat(64));
    const list = await request(created.app).get(feeds).set(bearer(admin));
    expect(list.body.items.every((f: Record<string, unknown>) => !('secretEnc' in f) && !('tokenHash' in f))).toBe(true);

    const put = (usdtRate: unknown) => request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ usdtRate });
    expect((await put('3950')).body.usdtRate).toBe('3950');
    expect((await put('abc')).status).toBe(400);
    const fx = await request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ fxRates: { ARS: '4.2', MXN: '' } });
    expect(fx.status).toBe(200);
    expect(fx.body.fxRates).toEqual({ ARS: '4.2' });
    expect((await request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ fxRates: { ARS: 'x' } })).status).toBe(400);
  });
});

describe('Cuentas de cobro por país', () => {
  it('publica los métodos por país y valida número y documento según el método', async () => {
    const m = await request(created.app).get('/pearl/v1/admin/account-methods').set(bearer(admin)).expect(200);
    expect(m.body.countries.map((c: { country: string }) => c.country)).toEqual(['CO', 'MX', 'AR']);
    expect(m.body.methods.find((x: { key: string }) => x.key === 'nequi')).toMatchObject({ country: 'CO', numberLabel: 'Celular Nequi' });

    const nequi = await add({ bank: 'nequi', holderName: 'Juan Campos', accountNumber: '300 123 4567', holderDocument: '1.020 304-050' });
    expect(nequi.status).toBe(201);
    expect(nequi.body).toMatchObject({ country: 'CO', accountNumber: '3001234567', holderDocument: '1020304050' });

    expect((await add({ bank: 'nequi', holderName: 'Juan Campos', accountNumber: '12345678' })).status).toBe(400);
    expect((await add({ bank: 'spei', holderName: 'Juan Campos', accountNumber: '0121800012345678' })).status).toBe(400);
    expect((await add({ bank: 'spei', bankName: 'BBVA México', holderName: 'Juan Campos', accountNumber: '012180001234567891', holderDocument: 'CAPJ800101AB1' })).body).toMatchObject({ country: 'MX' });
    expect((await add({ bank: 'cvu', holderName: 'Juan Campos', accountNumber: '0000003100012345678901', holderDocument: '123' })).status).toBe(400);

    const breb = await add({ bank: 'breb', holderName: 'Juan Campos', accountNumber: '@juancampos' });
    expect(breb.body).toMatchObject({ accountNumber: '@juancampos', alias: '@juancampos', country: 'CO' });

    expect((await add({ bank: 'mercadopago', country: 'AR', holderName: 'Juan Campos', accountNumber: '0000003100012345678901', alias: 'juan.campos.mp' })).body).toMatchObject({ country: 'AR', alias: 'juan.campos.mp' });
    expect((await add({ bank: 'binance_pay', holderName: 'Juan Campos', accountNumber: '123456789' })).status).toBe(400);
    expect((await add({ bank: 'binance_pay', country: 'CO', holderName: 'Juan Campos', accountNumber: '123456789' })).body).toMatchObject({ country: 'CO', accountNumber: '123456789' });
    const trc20 = 'T' + 'R'.repeat(33);
    expect((await add({ bank: 'binance_wallet', country: 'MX', accountNumber: '0x' + 'a'.repeat(40) })).status).toBe(400);
    const usdt = await add({ bank: 'binance_wallet', country: 'MX', accountNumber: trc20 });
    expect(usdt.body).toMatchObject({ country: 'MX', alias: trc20, holderName: 'Binance · USDT (TRC20)' });
    expect((await add({ bank: 'nequi', accountNumber: '3001234567' })).status).toBe(400);
    expect((await add({ bank: 'binance_wallet', country: 'MX', holderName: 'Juan Campos', accountNumber: 'no-es-billetera' })).status).toBe(400);

    expect((await add({ bank: 'banco_co', holderName: 'Juan Campos', accountNumber: '0550123456' })).status).toBe(400);
    expect((await add({ bank: 'banco_co', bankName: 'Banco Inventado', holderName: 'Juan Campos', accountNumber: '0550123456' })).status).toBe(400);
    expect((await add({ bank: 'banco_co', bankName: 'Davivienda', holderName: 'Juan Campos', accountNumber: '0550-1234-5678' })).status).toBe(400);
    expect((await add({ bank: 'banco_co', bankName: 'Davivienda', accountType: 'Ahorros', holderName: 'Juan Campos', accountNumber: '0550-1234-5678' })).body).toMatchObject({ accountType: 'Ahorros', bankName: 'Davivienda', accountNumber: '055012345678', country: 'CO' });
    expect((await add({ bank: 'spei', bankName: 'Banorte', holderName: 'Juan Campos', accountNumber: '072180001234567891' })).body).toMatchObject({ bankName: 'Banorte' });

    // Cuentas antiguas sin método siguen funcionando.
    expect((await add({ holderName: 'Cuenta vieja', accountNumber: '0170099220000067797370' })).status).toBe(201);

    // El jugador ve todas las cuentas con su moneda, sin el documento del titular.
    await request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ currency: 'COP' }).expect(200);
    const player = await createTestPlayer(opId);
    const seen = await request(created.app).get('/pearl/v1/player/accounts').set(bearer(playerToken(player.id, opId))).expect(200);
    const methods = seen.body.items.map((i: { method: string }) => i.method);
    expect(methods).toEqual(expect.arrayContaining(['Nequi', 'Llave Bre-B', 'Otro banco', 'Binance Pay', 'Binance · USDT (TRC20)']));
    // Se muestran todas las monedas: cada cuenta con la suya.
    expect(seen.body.items.find((i: { method: string }) => i.method === 'Transferencia SPEI').currency).toBe('MXN');
    expect(JSON.stringify(seen.body)).not.toContain('1020304050');
    const usdtSeen = seen.body.items.find((i: { method: string }) => i.method === 'Binance · USDT (TRC20)');
    expect(usdtSeen.network).toBe('USDT · TRON (TRC20)');
    expect(usdtSeen.currency).toBe('USDT');
    expect(seen.body.items.find((i: { method: string }) => i.method === 'Nequi').currency).toBe('COP');
    expect(usdtSeen.holderName).toBeUndefined();
    expect((await request(created.app).get('/pearl/v1/player/receipts/latest').set(bearer(playerToken(player.id, opId)))).body).toEqual({ receipt: null });
    expect((await request(created.app).get('/pearl/v1/player/accounts').set(bearer(admin))).status).toBe(403);
  });
});
