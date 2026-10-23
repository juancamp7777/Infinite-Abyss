import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let admin: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const opId = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

const add = (body: Record<string, unknown>) => request(created.app).post('/pearl/v1/admin/accounts').set(bearer(admin)).send(body);

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
  });
});
