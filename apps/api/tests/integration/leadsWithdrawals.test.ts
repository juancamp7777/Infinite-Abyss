import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { accountBalance, assertOperatorLedgerBalanced, bearer, buildIntegrationApp, fundPlayer, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let host: string;
let admin: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  opId = op.id;
  host = `${op.slug}.test.local`;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Sonar + Pearl + Tide con la Fase 1 real', () => {
  it('lead del chat → cuenta creada (entra con usuario) → retiro guiado por el bot → saldo reservado → pago manual', async () => {
    // Bot de bienvenida publicado (incluye el retiro guiado).
    const f = await request(created.app).post('/tide/v1/admin/flows').set(bearer(admin)).send({ name: 'Bienvenida', template: 'welcome' });
    await request(created.app).post(`/tide/v1/admin/flows/${f.body.id}/publish`).set(bearer(admin)).expect(200);

    const s = await request(created.app).post('/inbox/v1/webchat/session').send({ operatorId: opId, name: 'Rocío Díaz' });
    const visitor = s.body.token as string;
    const chat = (body: string) => request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', visitor).send({ body }).expect(201);
    const history = async () => (await request(created.app).get('/inbox/v1/webchat/conversation').set('x-visitor-token', visitor)).body;
    await chat('hola');
    const convId = (await history()).conversation.id as string;
    expect((await prisma.inboxConversation.findUniqueOrThrow({ where: { id: convId } })).stage).toBe('new_lead');

    // Retiro sin cuenta: el bot lo explica.
    await chat('Retiros');
    await chat('100');
    await chat('mi.alias.mp');
    await chat('Rocio Diaz');
    expect((await history()).messages.at(-1).body).toMatch(/primero necesitas una cuenta/);

    // El agente crea la cuenta: usuario y contraseña llegan por el chat y sirven para entrar.
    const acc = await request(created.app).post(`/inbox/v1/admin/conversations/${convId}/player`).set(bearer(admin)).send({ create: true });
    expect(acc.status).toBe(201);
    const creds = (await history()).messages.at(-1).body as string;
    const username = creds.match(/Usuario: (\S+)/)![1];
    const password = creds.match(/Contraseña: (\S+)/)![1];
    expect(username).toBe(acc.body.username);
    expect(username).toMatch(/^rocio\d{4}$/);
    const login = await request(created.app).post('/api/auth/login').set('Host', host).send({ email: username, password });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(acc.body.playerId);
    expect((await request(created.app).post(`/inbox/v1/admin/conversations/${convId}/player`).set(bearer(admin)).send({ create: true })).status).toBe(409);

    // Saldo y KYC: el retiro guiado reserva el saldo real y pasa a la sala de retiros.
    const playerId = acc.body.playerId as string;
    const currency = (await prisma.user.findUniqueOrThrow({ where: { id: playerId } })).currency;
    await fundPlayer(created, opId, playerId, currency, 50_000n);
    await prisma.user.update({ where: { id: playerId }, data: { kycStatus: 'VERIFIED' } });
    await chat('hola');
    await chat('Retiros');
    await chat('120');
    await chat('rocio.diaz.mp');
    await chat('Rocío Díaz');
    expect((await history()).messages.at(-1).body).toMatch(/Registramos tu retiro de .* a la cuenta rocio\.diaz\.mp/);
    const w = await prisma.withdrawal.findFirstOrThrow({ where: { userId: playerId } });
    expect(w).toMatchObject({ provider: 'PEARL', status: 'REQUESTED', amount: 12000n });
    expect(w.destination).toMatchObject({ account: 'rocio.diaz.mp', channel: 'chat' });
    expect(await accountBalance(opId, 'PLAYER_CASH', currency, playerId)).toBe(50_000n - 12_000n);
    expect((await prisma.inboxConversation.findUniqueOrThrow({ where: { id: convId } })).stage).toBe('withdraw');

    // Finanzas aprueba y marca como pagado (transferencia hecha por fuera).
    await request(created.app).post(`/api/backoffice/withdrawals/${w.id}/approve`).set(bearer(admin)).expect(200);
    const fin = await createBackofficeUser('OPERATOR_FINANCE', opId);
    const finance = jwt.signAccess({ sub: fin.id, op: opId, typ: 'backoffice', role: 'OPERATOR_FINANCE' });
    await request(created.app).post(`/api/backoffice/withdrawals/${w.id}/mark-paid`).set(bearer(admin)).expect(403);
    await request(created.app).post(`/api/backoffice/withdrawals/${w.id}/mark-paid`).set(bearer(finance)).expect(200);
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('PAID');
    await assertOperatorLedgerBalanced(opId);
  });
});
