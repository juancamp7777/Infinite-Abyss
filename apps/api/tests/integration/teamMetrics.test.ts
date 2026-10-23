import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { TEST_PASSWORD, createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let token: string;
let adminId: string;
let playerId: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator({ defaultCurrency: 'USD' })).id;
  const admin = await createBackofficeUser('OPERATOR_ADMIN', opId);
  adminId = admin.id;
  const login = await request(created.app).post('/api/backoffice/auth/login').send({ email: admin.email, password: TEST_PASSWORD });
  token = login.body.accessToken ?? login.body.token ?? jwt.signAccess({ sub: admin.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  playerId = (await createTestPlayer(opId, { currency: 'USD', email: 'cliente@test.local' })).id;
});

afterAll(async () => {
  await created.close?.();
});

describe('Caja en el chat y métricas del equipo', () => {
  it('carga y descarga a mano: la ficha del jugador y las métricas por persona lo reflejan', async () => {
    const before = new Date(Date.now() - 60_000);
    await prisma.crewMember.create({ data: { operatorId: opId, backofficeUserId: adminId, name: 'Cajera Uno', role: 'cajera', currency: 'USD' } });

    const load = await request(created.app).post(`/api/backoffice/players/${playerId}/adjustments`).set(bearer(token)).set('Idempotency-Key', 'carga-0001').send({ amount: '500000', reason: 'Recarga Nequi' });
    expect(load.status).toBe(201);
    expect((await request(created.app).post(`/api/backoffice/players/${playerId}/adjustments`).set(bearer(token)).set('Idempotency-Key', 'carga-0001').send({ amount: '500000', reason: 'Recarga Nequi' })).status).toBe(200);
    await request(created.app).post(`/api/backoffice/players/${playerId}/adjustments`).set(bearer(token)).set('Idempotency-Key', 'descarga-01').send({ amount: '-100000', reason: 'Retiro por chat' }).expect(201);

    const wallet = await request(created.app).get(`/api/backoffice/players/${playerId}/wallet`).set(bearer(token));
    expect(wallet.status).toBe(200);
    expect(wallet.body).toMatchObject({ playerId, email: 'cliente@test.local', currency: 'USD', cash: '400000', bonus: '0', lastLoad: { amount: '500000', type: 'MANUAL_ADJUSTMENT' } });
    expect(wallet.body.movements[0]).toMatchObject({ type: 'MANUAL_ADJUSTMENT', amount: '-100000', reason: 'Retiro por chat' });

    const other = await createTestOperator();
    const outsider = await createBackofficeUser('OPERATOR_ADMIN', other.id);
    const outsiderToken = jwt.signAccess({ sub: outsider.id, op: other.id, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
    expect((await request(created.app).get(`/api/backoffice/players/${playerId}/wallet`).set(bearer(outsiderToken))).status).toBe(404);

    const to = new Date(Date.now() + 60_000);
    const crewToken = jwt.signAccess({ sub: adminId, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
    const m = await request(created.app).get('/crew/v1/admin/metrics').set(bearer(crewToken)).query({ from: before.toISOString(), to: to.toISOString(), tz: 'America/Bogota' });
    expect(m.status).toBe(200);
    const me = m.body.agents.find((a: { backofficeUserId: string }) => a.backofficeUserId === adminId);
    expect(me).toMatchObject({ name: 'Cajera Uno', loads: { count: 1, amount: '500000' }, debits: { count: 1, amount: '100000' } });
    expect(m.body.totals).toMatchObject({ loads: 1, loaded: '500000', debited: '100000' });
    expect(m.body.hourly).toHaveLength(24);
    expect(m.body.hourly.reduce((n: number, h: { count: number }) => n + h.count, 0)).toBe(1);
    expect(m.body.players).toMatchObject({ registered: 1, loaders: 1, firstTimeLoaders: 1, returningLoaders: 0 });

    expect((await request(created.app).get('/crew/v1/admin/metrics').set(bearer(crewToken)).query({ from: to.toISOString(), to: before.toISOString() })).status).toBe(400);
  });
});
