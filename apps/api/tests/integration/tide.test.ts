import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let adminToken: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const admin = await createBackofficeUser('OPERATOR_ADMIN', opId);
  adminToken = jwt.signAccess({ sub: admin.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Tide con Postgres (app real)', () => {
  it('flujo publicado atiende el webchat, guarda la sesión y pasa a humano', async () => {
    const f = await request(created.app).post('/tide/v1/admin/flows').set(bearer(adminToken)).send({ name: 'Bienvenida IT', template: 'welcome' });
    expect(f.status).toBe(201);
    const pub = await request(created.app).post(`/tide/v1/admin/flows/${f.body.id}/publish`).set(bearer(adminToken));
    expect(pub.body).toMatchObject({ publishedVersion: 1, enabled: true });
    expect(await prisma.tideFlowVersion.count({ where: { flowId: f.body.id } })).toBe(1);

    const s = await request(created.app).post('/inbox/v1/webchat/session').send({ operatorId: opId, name: 'Visitante Tide' });
    const visitor = s.body.token as string;
    await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body: 'hola' }).expect(201);
    let history = await request(created.app).get('/inbox/v1/webchat/conversation').set('x-visitor-token', visitor);
    expect(history.body.messages.map((m: { authorType: string }) => m.authorType)).toEqual(['contact', 'bot', 'bot']);
    const convId = history.body.conversation.id as string;
    expect(await prisma.tideSession.findUnique({ where: { conversationId: convId } })).toMatchObject({ status: 'waiting', nodeId: 'menu', version: 1 });

    await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body: '3' }).expect(201);
    expect(await prisma.tideSession.findUnique({ where: { conversationId: convId } })).toMatchObject({ status: 'handoff', vars: { motivo: '3' } });
    history = await request(created.app).get('/inbox/v1/webchat/conversation').set('x-visitor-token', visitor);
    expect(JSON.stringify(history.body)).not.toContain('El bot pasó la conversación'); // la nota es interna

    await request(created.app).patch(`/inbox/v1/admin/conversations/${convId}`).set(bearer(adminToken)).send({ status: 'closed' }).expect(200);
    expect(await prisma.tideSession.findUnique({ where: { conversationId: convId } })).toBeNull();
  });
});
