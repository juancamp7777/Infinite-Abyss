import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt, playerToken } from './helpers';

let created: CreatedApp;
let opId: string;
let otherOp: string;
let agentToken: string;
let otherToken: string;
let pToken: string;
let playerId: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  const other = await createTestOperator();
  opId = op.id;
  otherOp = other.id;
  const support = await createBackofficeUser('OPERATOR_SUPPORT' as never, opId);
  const admin2 = await createBackofficeUser('OPERATOR_ADMIN', otherOp);
  agentToken = jwt.signAccess({ sub: support.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
  otherToken = jwt.signAccess({ sub: admin2.id, op: otherOp, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const player = await createTestPlayer(opId);
  playerId = player.id;
  pToken = playerToken(player.id, opId);
});

afterAll(async () => {
  await created.close?.();
});

describe('inbox con Postgres (app real)', () => {
  it('visitante ↔ agente: persistencia, idempotencia, notas y aislamiento', async () => {
    const s = await request(created.app).post('/inbox/v1/webchat/session').send({ operatorId: opId, name: 'Visitante IT' });
    expect(s.status).toBe(201);
    const visitor = s.body.token as string;
    const stored = await prisma.inboxVisitor.findUnique({ where: { id: s.body.visitorId } });
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash).not.toBe(visitor);

    const m1 = await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body: 'hola desde IT', clientMsgId: 'it-1' });
    expect(m1.status).toBe(201);
    const m1b = await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body: 'hola desde IT', clientMsgId: 'it-1' });
    expect(m1b.body.id).toBe(m1.body.id);

    const list = await request(created.app).get('/inbox/v1/admin/conversations?q=Visitante IT').set(bearer(agentToken));
    expect(list.status).toBe(200);
    const conv = list.body.items[0];
    expect(conv).toMatchObject({ operatorId: opId, channel: 'webchat', unread: 1, status: 'open' });

    expect((await request(created.app).get(`/inbox/v1/admin/conversations/${conv.id}`).set(bearer(otherToken))).status).toBe(404);
    expect((await request(created.app).get('/inbox/v1/admin/conversations').set(bearer(otherToken))).body.items.some((c: { id: string }) => c.id === conv.id)).toBe(false);
    expect((await request(created.app).get('/inbox/v1/admin/conversations').set(bearer(pToken))).status).toBe(403);

    await request(created.app).post(`/inbox/v1/admin/conversations/${conv.id}/messages`).set(bearer(agentToken)).send({ body: 'nota secreta', kind: 'note' }).expect(201);
    await request(created.app).post(`/inbox/v1/admin/conversations/${conv.id}/messages`).set(bearer(agentToken)).send({ body: 'respuesta pública' }).expect(201);

    const history = await request(created.app).get('/inbox/v1/webchat/conversation').set('x-visitor-token', visitor);
    expect(history.body.messages.map((m: { body: string }) => m.body)).toEqual(['hola desde IT', 'respuesta pública']);
    const after = await request(created.app).get(`/inbox/v1/webchat/conversation?after=${encodeURIComponent(m1.body.createdAt)}`).set('x-visitor-token', visitor);
    expect(after.body.messages.map((m: { body: string }) => m.body)).toEqual(['respuesta pública']);

    const full = await request(created.app).get(`/inbox/v1/admin/conversations/${conv.id}`).set(bearer(agentToken));
    expect(full.body.messages.map((m: { direction: string }) => m.direction)).toEqual(['in', 'note', 'out']);
    expect(full.body.conversation).toMatchObject({ status: 'pending', unread: 0 });

    await request(created.app).patch(`/inbox/v1/admin/conversations/${conv.id}`).set(bearer(agentToken)).send({ status: 'closed' }).expect(200);
    await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body: 'vuelvo' }).expect(201);
    const reopened = await prisma.inboxConversation.findUnique({ where: { id: conv.id } });
    expect(reopened).toMatchObject({ status: 'open', unread: 1, lastMessagePreview: 'vuelvo' });
  });

  it('jugador con JWT real y respuestas rápidas en Postgres', async () => {
    await request(created.app).post('/inbox/v1/webchat/messages').set(bearer(pToken)).send({ body: 'soy jugador' }).expect(201);
    const conv = await prisma.inboxConversation.findFirst({ where: { operatorId: opId, playerId } });
    expect(conv?.externalId).toBe(`player:${playerId}`);

    const shortcut = `it${Date.now()}`;
    const q = await request(created.app).post('/inbox/v1/admin/quick-replies').set(bearer(agentToken)).send({ shortcut, body: 'Hola 👋' });
    expect(q.status).toBe(201);
    expect((await request(created.app).post('/inbox/v1/admin/quick-replies').set(bearer(agentToken)).send({ shortcut, body: 'dup' })).status).toBe(409);
    expect((await request(created.app).delete(`/inbox/v1/admin/quick-replies/${q.body.id}`).set(bearer(otherToken))).status).toBe(404);
    expect((await request(created.app).delete(`/inbox/v1/admin/quick-replies/${q.body.id}`).set(bearer(agentToken))).status).toBe(200);
  });

  it('canal de WhatsApp en Postgres: credenciales cifradas, webhook firmado e idempotente', async () => {
    const appSecret = '0123456789abcdef0123456789abcdef';
    const accessToken = 'EAAG-it-test-only-token-abcdefghijklmnop';
    const adminTok = jwt.signAccess({ sub: (await createBackofficeUser('OPERATOR_ADMIN', opId)).id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
    const c = await request(created.app).post('/inbox/v1/admin/channels').set(bearer(adminTok))
      .send({ type: 'whatsapp', name: 'WA IT', config: { phoneNumberId: '1098765432', accessToken, appSecret } });
    expect(c.status).toBe(201);
    const row = await prisma.inboxChannel.findUnique({ where: { id: c.body.channel.id } });
    expect(row?.configEnc).toMatch(/^v1./);
    expect(row?.configEnc).not.toContain(accessToken);
    expect(JSON.stringify(c.body)).not.toContain(appSecret);

    const wamid = `wamid.it-${Date.now()}`;
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: '573009998877', profile: { name: 'Cliente WA' } }], messages: [{ from: '573009998877', id: wamid, type: 'text', text: { body: 'hola por WhatsApp' } }] } }] }] });
    const sig = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
    const hook = `/inbox/v1/channels/${c.body.channel.id}/webhook`;
    for (let i = 0; i < 2; i++) {
      await request(created.app).post(hook).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(raw).expect(200);
    }
    await request(created.app).post(hook).set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=00').send(raw).expect(401);
    const conv = await prisma.inboxConversation.findFirst({ where: { operatorId: opId, channelId: c.body.channel.id } });
    expect(conv).toMatchObject({ channel: 'whatsapp', contactName: 'Cliente WA', unread: 1 });
    expect(await prisma.inboxMessage.count({ where: { conversationId: conv!.id } })).toBe(1);
    expect((await request(created.app).get('/inbox/v1/admin/channels').set(bearer(otherToken))).body.items).toHaveLength(0);
  });
});
