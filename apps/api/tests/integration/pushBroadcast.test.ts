import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let admin: string;
let agent: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const opId = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const s = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  agent = jwt.signAccess({ sub: s.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Push premium a todos', () => {
  it('crea la plantilla con su diseño y responde la audiencia; links externos y roles sin permiso se rechazan', async () => {
    const ok = await request(created.app).post('/marketing/v1/admin/push/broadcast').set(bearer(admin))
      .send({ title: '🔥 ¡Happy hour!', body: 'Recarga y llévate 25 % extra', push: { image: '/brand/push/bono.png', url: '/cashier', actions: [{ title: '💰 Recargar', url: '/cashier' }] } });
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ audience: 0, devices: 0 });
    const tpls = await request(created.app).get('/marketing/v1/admin/templates').set(bearer(admin));
    expect(tpls.body.items.find((t: { id: string }) => t.id === ok.body.templateId)).toMatchObject({ channel: 'push', subject: '🔥 ¡Happy hour!', push: { url: '/cashier', image: '/brand/push/bono.png' } });

    const external = await request(created.app).post('/marketing/v1/admin/push/broadcast').set(bearer(admin)).send({ title: 'x', body: 'y', push: { url: 'https://phishing.example' } });
    expect(external.status).toBe(400);
    const tooMany = await request(created.app).post('/marketing/v1/admin/push/broadcast').set(bearer(admin)).send({ title: 'x', body: 'y', push: { actions: [{ title: 'a', url: '/a' }, { title: 'b', url: '/b' }, { title: 'c', url: '/c' }] } });
    expect(tooMany.status).toBe(400);
    expect((await request(created.app).post('/marketing/v1/admin/push/broadcast').set(bearer(agent)).send({ title: 'x', body: 'y' })).status).toBe(403);
  });
});
