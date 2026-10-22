import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createBackofficeUser, createTestOperator, TEST_PASSWORD } from '../setup/factories';
import { bearer, buildIntegrationApp, playerToken } from './helpers';

// (g) Endpoints del módulo backoffice-api (/backoffice/v1) con la auth real de la Fase 1:
// sin token → 401; OPERATOR_ADMIN de A no ve datos de B; PLATFORM_ADMIN ve ambos.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

const BO = '/backoffice/v1';

async function boLogin(email: string): Promise<string> {
  const res = await request(created.app).post('/api/backoffice/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.accessToken as string;
}

async function registerPlayers(slug: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await request(created.app)
      .post('/api/auth/register')
      .set('X-Operator-Slug', slug)
      .send({ email: `bo-${randomUUID().slice(0, 8)}@nymfo.test`, password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    ids.push(res.body.user?.id ?? res.body.id);
  }
  return ids;
}

describe('(g) backoffice-api: autenticación y aislamiento de operadores', () => {
  it('rechaza sin token, con token inválido, con token mock dev: y con token de jugador', async () => {
    const op = await createTestOperator();
    const routes = [
      () => request(created.app).get(`${BO}/dashboard`),
      () => request(created.app).get(`${BO}/admin/skins/${op.id}`),
      () => request(created.app).put(`${BO}/admin/skins/${op.id}`).send({ name: 'X' }),
      () => request(created.app).get(`${BO}/admin/reports/kpis-daily.csv`),
    ];
    for (const r of routes) {
      expect((await r()).status).toBe(401);
      expect((await r().set(bearer('no-es-un-jwt'))).status).toBe(401);
    }

    // El login mock de desarrollo emite tokens 'dev:' que la auth real rechaza.
    const dev = await request(created.app).post(`${BO}/dev/login`).send({ role: 'PLATFORM_ADMIN' });
    if (dev.status === 200) {
      expect((await request(created.app).get(`${BO}/dashboard`).set(bearer(dev.body.token))).status).toBe(401);
    }

    // Un jugador autenticado no es administrador.
    const [playerId] = await registerPlayers(op.slug, 1);
    const pt = playerToken(playerId, op.id);
    const asPlayer = await request(created.app).get(`${BO}/dashboard`).set(bearer(pt));
    expect([401, 403]).toContain(asPlayer.status);
  });

  it('OPERATOR_ADMIN de A solo ve A; PLATFORM_ADMIN ve A y B', async () => {
    const opA = await createTestOperator();
    const opB = await createTestOperator();
    await registerPlayers(opA.slug, 1);
    await registerPlayers(opB.slug, 2);
    await created.services.bus.drain();

    const adminA = await createBackofficeUser('OPERATOR_ADMIN', opA.id);
    const support = await createBackofficeUser('OPERATOR_SUPPORT', opA.id);
    const platform = await createBackofficeUser('PLATFORM_ADMIN', null);
    const tA = await boLogin(adminA.email);
    const tSupport = await boLogin(support.email);
    const tP = await boLogin(platform.email);

    // Dashboard: A ve su operador, y su propio filtro; pedir B → 403.
    const dashA = await request(created.app).get(`${BO}/dashboard`).set(bearer(tA));
    expect(dashA.status, JSON.stringify(dashA.body)).toBe(200);
    expect(dashA.body.operatorId).toBe(opA.id);
    expect(dashA.body.totals.registrations).toBe(1);
    expect((await request(created.app).get(`${BO}/dashboard`).query({ operatorId: opB.id }).set(bearer(tA))).status).toBe(403);

    // Soporte del operador no tiene acceso a endpoints de administradores.
    expect((await request(created.app).get(`${BO}/dashboard`).set(bearer(tSupport))).status).toBe(403);

    // Skins: A lee/escribe la suya, no la de B.
    const current = await request(created.app).get(`${BO}/admin/skins/${opA.id}`).set(bearer(tA));
    expect(current.status).toBe(200);
    const skinBody = { ...current.body, name: 'Skin A s6' };
    const putA = await request(created.app).put(`${BO}/admin/skins/${opA.id}`).set(bearer(tA)).send(skinBody);
    expect(putA.status, JSON.stringify(putA.body)).toBe(200);
    expect((await request(created.app).get(`${BO}/admin/skins/${opA.id}`).set(bearer(tA))).body.name).toBe('Skin A s6');
    expect((await request(created.app).get(`${BO}/admin/skins/${opB.id}`).set(bearer(tA))).status).toBe(403);
    expect((await request(created.app).put(`${BO}/admin/skins/${opB.id}`).set(bearer(tA)).send({ ...skinBody, name: 'Intrusa' })).status).toBe(403);
    expect((await request(created.app).get(`${BO}/admin/skins/${opB.id}`).set(bearer(tP))).body.name).not.toBe('Intrusa');

    // CSV: A obtiene solo filas de A; pedir B → 403.
    const csvA = await request(created.app).get(`${BO}/admin/reports/kpis-daily.csv`).set(bearer(tA));
    expect(csvA.status).toBe(200);
    expect(csvA.text).toContain(opA.id);
    expect(csvA.text).not.toContain(opB.id);
    expect((await request(created.app).get(`${BO}/admin/reports/kpis-daily.csv`).query({ operatorId: opB.id }).set(bearer(tA))).status).toBe(403);

    // PLATFORM_ADMIN: ve ambos operadores, por filtro y en el agregado.
    const dashPB = await request(created.app).get(`${BO}/dashboard`).query({ operatorId: opB.id }).set(bearer(tP));
    expect(dashPB.status).toBe(200);
    expect(dashPB.body.operatorId).toBe(opB.id);
    expect(dashPB.body.totals.registrations).toBe(2);
    const dashPA = await request(created.app).get(`${BO}/dashboard`).query({ operatorId: opA.id }).set(bearer(tP));
    expect(dashPA.body.totals.registrations).toBe(1);
    const dashAll = await request(created.app).get(`${BO}/dashboard`).set(bearer(tP));
    expect(dashAll.status).toBe(200);
    expect(dashAll.body.operatorId).toBeNull();
    expect(dashAll.body.totals.registrations).toBeGreaterThanOrEqual(3);
    const csvAll = await request(created.app).get(`${BO}/admin/reports/kpis-daily.csv`).set(bearer(tP));
    expect(csvAll.status).toBe(200);
    expect(csvAll.text).toContain(opA.id);
    expect(csvAll.text).toContain(opB.id);
    expect((await request(created.app).get(`${BO}/admin/skins/${opB.id}`).set(bearer(tP))).status).toBe(200);
  });

  it('un admin suspendido pierde el acceso aunque su JWT siga vigente', async () => {
    const op = await createTestOperator();
    const admin = await createBackofficeUser('OPERATOR_ADMIN', op.id);
    const t = await boLogin(admin.email);
    expect((await request(created.app).get(`${BO}/dashboard`).set(bearer(t))).status).toBe(200);
    const { prisma } = await import('../../src/infrastructure/database/prisma');
    await prisma.backofficeUser.update({ where: { id: admin.id }, data: { status: 'SUSPENDED' } });
    expect((await request(created.app).get(`${BO}/dashboard`).set(bearer(t))).status).toBe(401);
  });
});
