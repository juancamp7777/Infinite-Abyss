import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let admin: string;
let agent: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const g = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  agent = jwt.signAccess({ sub: g.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
  await request(created.app).post('/crew/v1/admin/members').set(bearer(admin)).send({ name: 'Sofía Agente', role: 'agente', currency: 'ARS', backofficeUserId: g.id }).expect(201);
});

afterAll(async () => {
  await created.close?.();
});

describe('Ascend con actividad real (Sonar + Pearl + Crew)', () => {
  it('primera respuesta rápida, carga aprobada y trabajo del turno suman XP; el ranking y el perfil lo reflejan', async () => {
    // Sonar: el contacto escribe, el agente responde rápido (5 XP); una segunda respuesta sin nuevo mensaje no suma.
    const s = await request(created.app).post('/inbox/v1/webchat/session').send({ operatorId: opId, name: 'Jugador X' });
    await request(created.app).post('/inbox/v1/webchat/messages').set('x-visitor-token', s.body.token).send({ body: 'hola, necesito ayuda' }).expect(201);
    const conv = (await request(created.app).get('/inbox/v1/admin/conversations').set(bearer(agent))).body.items[0];
    await request(created.app).post(`/inbox/v1/admin/conversations/${conv.id}/messages`).set(bearer(agent)).send({ body: 'Hola, te ayudo' }).expect(201);
    await request(created.app).post(`/inbox/v1/admin/conversations/${conv.id}/messages`).set(bearer(agent)).send({ body: '¿Sigues ahí?' }).expect(201);
    await request(created.app).post(`/inbox/v1/admin/conversations/${conv.id}/messages`).set(bearer(agent)).send({ body: 'nota', kind: 'note' }).expect(201);
    expect(await prisma.crewActivity.findMany({ where: { operatorId: opId, type: 'first_response' } })).toHaveLength(1);

    // Pearl: el cajero aprueba una carga en revisión (5 XP).
    const player = await createTestPlayer(opId);
    const currency = (await prisma.user.findUniqueOrThrow({ where: { id: player.id } })).currency;
    await request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ mode: 'review_all', currency, minAmount: '100' }).expect(200);
    const r = await request(created.app).post('/pearl/v1/admin/receipts').set(bearer(agent)).send({ playerId: player.id, extracted: { amount: '50', senderName: 'Ana Perez' } });
    expect(['pending_review', 'waiting_bank']).toContain(r.body.status);
    expect((await request(created.app).post(`/pearl/v1/admin/receipts/${r.body.id}/approve`).set(bearer(agent)).send({})).body.status).toBe('credited');

    // Crew: checklist (2), tarea terminada (10), caja sin diferencia (10); repetir no vuelve a sumar.
    await request(created.app).post('/crew/v1/me/clock-in').set(bearer(agent)).send({}).expect(201);
    const item = await request(created.app).post('/crew/v1/admin/checklist').set(bearer(admin)).send({ title: 'Revisar feeds' });
    await request(created.app).post(`/crew/v1/me/checklist/${item.body.id}`).set(bearer(agent)).send({ done: true }).expect(200);
    await request(created.app).post(`/crew/v1/me/checklist/${item.body.id}`).set(bearer(agent)).send({ done: false }).expect(200);
    await request(created.app).post(`/crew/v1/me/checklist/${item.body.id}`).set(bearer(agent)).send({ done: true }).expect(200);
    const me = (await request(created.app).get('/crew/v1/me').set(bearer(agent))).body.member;
    const task = await request(created.app).post('/crew/v1/admin/tasks').set(bearer(admin)).send({ title: 'Contactar VIPs', assigneeId: me.id });
    await request(created.app).patch(`/crew/v1/me/tasks/${task.body.id}`).set(bearer(agent)).send({ status: 'done' }).expect(200);
    await request(created.app).patch(`/crew/v1/me/tasks/${task.body.id}`).set(bearer(agent)).send({ status: 'doing' }).expect(200);
    await request(created.app).patch(`/crew/v1/me/tasks/${task.body.id}`).set(bearer(agent)).send({ status: 'done' }).expect(200);
    const box = await request(created.app).post('/crew/v1/cash').set(bearer(agent)).send({ box: 'Caja Ascend', currency: 'ARS', openingBalance: '1000' });
    await request(created.app).post(`/crew/v1/cash/${box.body.id}/close`).set(bearer(agent)).send({ declaredBalance: '1000' }).expect(200);

    const profile = (await request(created.app).get('/crew/v1/me/ascend').set(bearer(agent))).body;
    expect(profile).toMatchObject({ xp: 5 + 5 + 2 + 10 + 10, weeklyXp: 32, level: 2, rank: 1, kpis30d: { firstResponses: 1, depositsApproved: 1, checklist: 1, tasksDone: 1, cashPerfect: 1 } });
    expect(profile.kpis30d.avgFirstResponseSec).toBeLessThan(60);
    expect(profile.league.key).toBe('bronce');
    expect(profile.badges.every((b: { earned: boolean }) => !b.earned)).toBe(true);

    const board = (await request(created.app).get('/crew/v1/leaderboard?period=week').set(bearer(admin))).body.items;
    expect(board[0]).toMatchObject({ rank: 1, xp: 32, member: { name: 'Sofía Agente' }, kpis: { fastResponses: 1 } });
  });
});
