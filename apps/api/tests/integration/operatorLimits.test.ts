import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

const BO = '/backoffice/v1';
let created: CreatedApp;
let admin: string;
let agent: string;
let opId: string;
let otherOp: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' })).id;
  otherOp = (await createTestOperator()).id;
  admin = jwt.signAccess({ sub: (await createBackofficeUser('OPERATOR_ADMIN', opId)).id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  agent = jwt.signAccess({ sub: (await createBackofficeUser('OPERATOR_SUPPORT', opId)).id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Límites del casino', () => {
  it('guarda mínimos y máximos, valida, borra con "" y sincroniza el mínimo de Pearl', async () => {
    const url = `${BO}/admin/limits/${opId}`;
    const empty = await request(created.app).get(url).set(bearer(admin)).expect(200);
    expect(empty.body).toMatchObject({ currency: 'COP', limits: { minBet: '', minDeposit: '' } });

    const put = (body: Record<string, string>) => request(created.app).put(url).set(bearer(admin)).send(body);
    const ok = await put({ minBet: '50000', maxBet: '100000000', minDeposit: '1000000', minWithdrawal: '2000000' });
    expect(ok.status).toBe(200);
    expect(ok.body.limits).toMatchObject({ minBet: '50000', maxBet: '100000000', minDeposit: '1000000', minWithdrawal: '2000000', maxDeposit: '' });

    expect((await put({ minDeposit: '5000000', maxDeposit: '1000000' })).status).toBe(400);
    expect((await put({ minBet: '5.000' })).status).toBe(400);
    expect((await put({ maxBet: '' })).body.limits).toMatchObject({ maxBet: '', minBet: '50000' });

    const pearl = await request(created.app).get('/pearl/v1/admin/settings').set(bearer(admin)).expect(200);
    expect(pearl.body.minAmount).toBe('1000000');

    // Solo administradores, y cada uno de su casino.
    expect((await request(created.app).get(url).set(bearer(agent))).status).toBe(403);
    expect((await request(created.app).get(`${BO}/admin/limits/${otherOp}`).set(bearer(admin))).status).toBe(403);
  });
});
