import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt, playerToken, waitFor } from './helpers';

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

describe('Push por tipo de jugador', () => {
  it('cuenta y filtra por tipo (nuevos leads vs recurrentes) y por segmento propio', async () => {
    const op = await createTestOperator();
    const a = await createBackofficeUser('OPERATOR_ADMIN', op.id);
    const tok = jwt.signAccess({ sub: a.id, op: op.id, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
    const ids: string[] = [];
    for (const [i, email] of ['lead@test.local', 'fiel@test.local'].entries()) {
      await request(created.app).post('/api/auth/register').set('Host', op.host).send({ email, password: 'Clave-Segura-123', adult: true }).expect(201);
      const u = await prisma.user.findFirstOrThrow({ where: { operatorId: op.id, emailNormalized: email } });
      ids.push(u.id);
      await waitFor(() => prisma.$queryRawUnsafe<unknown[]>('select 1 from crm_player_profiles where "playerId" = $1', u.id), (r) => r.length === 1);
      await request(created.app).post('/marketing/v1/push/subscribe').set(bearer(playerToken(u.id, op.id))).set('Host', op.host)
        .send({ endpoint: `https://fcm.googleapis.com/fcm/send/tipo-${i}`, keys: { p256dh: 'k', auth: 'a' } }).expect(201);
    }
    const now = new Date().toISOString();
    await prisma.$executeRawUnsafe(`update crm_player_profiles set data = data || jsonb_build_object('depositsCount', 4, 'firstDepositAt', $2::text, 'lastDepositAt', $2::text) where "playerId" = $1`, ids[1], now);

    const aud = await request(created.app).get('/marketing/v1/admin/push/audiences').set(bearer(tok)).expect(200);
    const count = (k: string) => aud.body.items.find((x: { key: string }) => x.key === k)?.players;
    expect([count('all'), count('leads'), count('recurring'), count('dormant')]).toEqual([2, 1, 1, 0]);

    const send = (sel: Record<string, string>) => request(created.app).post('/marketing/v1/admin/push/broadcast').set(bearer(tok)).send({ title: 'Hola', body: 'Promo', ...sel });
    expect((await send({ audience: 'recurring' })).body).toMatchObject({ audience: 1, devices: 1 });
    expect((await send({ audience: 'leads' })).body).toMatchObject({ audience: 1, devices: 1 });
    expect((await send({ audience: 'nadie' })).status).toBe(400);

    const seg = await request(created.app).post('/crm/v1/admin/segments').set(bearer(tok)).send({ name: 'Con cargas', rule: { field: 'depositCount', op: 'gte', value: 1 } });
    if (seg.status === 201) {
      expect((await send({ segmentId: seg.body.id })).body).toMatchObject({ audience: 1 });
      const again = await request(created.app).get('/marketing/v1/admin/push/audiences').set(bearer(tok));
      expect(again.body.segments).toEqual([{ id: seg.body.id, name: 'Con cargas', players: 1 }]);
    }
    expect((await send({ segmentId: 'no-existe' })).status).toBe(404);
  });
});
