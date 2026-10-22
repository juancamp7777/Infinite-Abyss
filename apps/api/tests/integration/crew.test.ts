import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { CrewService } from '../../src/modules/crew/application/CrewService';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let admin: string;
let cashierToken: string;
let cashierUserId: string;
let otherAdmin: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const otherOp = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const c = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  cashierUserId = c.id;
  cashierToken = jwt.signAccess({ sub: c.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
  const o = await createBackofficeUser('OPERATOR_ADMIN', otherOp);
  otherAdmin = jwt.signAccess({ sub: o.id, op: otherOp, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Crew con Postgres', () => {
  it('equipo, fichaje por HTTP con roles reales, tareas, checklist, avisos y aislamiento', async () => {
    const mem = await request(created.app).post('/crew/v1/admin/members').set(bearer(admin)).send({ name: 'Lucía Cajera', role: 'cajera', currency: 'ARS', baseAmount: '2400000', backofficeUserId: cashierUserId });
    expect(mem.status).toBe(201);
    expect((await request(created.app).post('/crew/v1/admin/members').set(bearer(admin)).send({ name: 'Dup', role: 'xx', currency: 'ARS', backofficeUserId: cashierUserId })).status).toBe(409);
    expect((await request(created.app).get('/crew/v1/admin/members').set(bearer(cashierToken))).status).toBe(403);
    expect((await request(created.app).get('/crew/v1/admin/members').set(bearer(otherAdmin))).body.items).toHaveLength(0);

    await request(created.app).post('/crew/v1/me/clock-in').set(bearer(cashierToken)).send({}).expect(201);
    expect((await request(created.app).post('/crew/v1/me/clock-in').set(bearer(cashierToken)).send({})).status).toBe(409);
    expect((await request(created.app).get('/crew/v1/admin/live').set(bearer(admin))).body.items[0]).toMatchObject({ memberName: 'Lucía Cajera', status: 'working' });
    await request(created.app).post('/crew/v1/me/pause').set(bearer(cashierToken)).expect(200);
    await request(created.app).post('/crew/v1/me/resume').set(bearer(cashierToken)).expect(200);

    const item = await request(created.app).post('/crew/v1/admin/checklist').set(bearer(admin)).send({ title: 'Revisar cuentas receptoras' });
    const marked = await request(created.app).post(`/crew/v1/me/checklist/${item.body.id}`).set(bearer(cashierToken)).send({ done: true });
    expect(marked.body.items[0]).toMatchObject({ title: 'Revisar cuentas receptoras', done: true });

    const task = await request(created.app).post('/crew/v1/admin/tasks').set(bearer(admin)).send({ title: 'Llamar a VIPs inactivos', assigneeId: mem.body.id });
    expect((await request(created.app).patch(`/crew/v1/me/tasks/${task.body.id}`).set(bearer(cashierToken)).send({ status: 'done' })).body).toMatchObject({ status: 'done' });

    const ann = await request(created.app).post('/crew/v1/admin/announcements').set(bearer(admin)).send({ title: 'Nuevo proceso de retiros', body: 'Desde hoy…', mandatory: true, severity: 'warning' });
    expect((await request(created.app).get('/crew/v1/me/announcements').set(bearer(cashierToken))).body.items[0]).toMatchObject({ id: ann.body.id, read: false, mandatory: true });
    await request(created.app).post(`/crew/v1/me/announcements/${ann.body.id}/ack`).set(bearer(cashierToken)).expect(200);
    expect((await request(created.app).get('/crew/v1/admin/announcements').set(bearer(admin))).body.items[0].reads).toBe(1);

    const out = await request(created.app).post('/crew/v1/me/clock-out').set(bearer(cashierToken));
    expect(out.body).toMatchObject({ status: 'closed', closedBy: 'member' });
    expect((await request(created.app).post('/crew/v1/me/clock-out').set(bearer(cashierToken))).status).toBe(409);
  });

  it('reglas con reloj controlado: tardanza, franco, cierre de seguridad, caja y nómina congelada', async () => {
    let now = new Date('2026-11-02T12:20:00Z'); // lunes
    const crew = new CrewService(prisma, { now: () => now });
    const m = await crew.saveMember(opId, { name: 'Mateo Agente', role: 'agente', currency: 'COP', baseAmount: 240_000_000n, timezone: 'America/Bogota', dayOff: 0 });
    await crew.createShift(opId, { memberId: m.id, label: 'Mañana', startsAt: new Date('2026-11-02T12:00:00Z'), endsAt: new Date('2026-11-02T20:00:00Z') });
    await expect(crew.createShift(opId, { memberId: m.id, label: 'X', startsAt: new Date('2026-11-02T19:00:00Z'), endsAt: new Date('2026-11-02T22:00:00Z') })).rejects.toMatchObject({ status: 409 });

    const s1 = await crew.clockIn(opId, m.id);
    expect(s1).toMatchObject({ kind: 'normal', lateMinutes: 20 });
    expect(s1.shiftId).toBeTruthy();
    // Concurrencia: dos cierres a la vez → uno solo gana.
    now = new Date('2026-11-02T20:20:00Z');
    const results = await Promise.allSettled([crew.clockOut(opId, m.id), crew.clockOut(opId, m.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await prisma.crewSession.findUniqueOrThrow({ where: { id: s1.id } })).netMinutes).toBe(480);

    // Domingo en Bogotá = franco → la jornada queda como "dayoff"; olvidada abierta → cierre de seguridad.
    now = new Date('2026-11-08T14:00:00Z');
    const s2 = await crew.clockIn(opId, m.id);
    expect(s2.kind).toBe('dayoff');
    now = new Date('2026-11-09T12:00:00Z');
    expect(await crew.autoCloseTick()).toBeGreaterThanOrEqual(1);
    expect(await prisma.crewSession.findUniqueOrThrow({ where: { id: s2.id } })).toMatchObject({ status: 'closed', closedBy: 'auto', netMinutes: 14 * 60 });

    // Caja: abrir (una por nombre), mover, cerrar con diferencia, no admite cambios, reapertura auditada.
    const box = await crew.openCash(opId, 'Caja Bogotá', 'COP', 100_000n, m.id);
    await expect(crew.openCash(opId, 'Caja Bogotá', 'COP', 0n, m.id)).rejects.toMatchObject({ status: 409 });
    await crew.cashMovement(opId, box.id, { type: 'in', amount: 50_000n, concept: 'Carga jugador' }, m.id);
    await crew.cashMovement(opId, box.id, { type: 'out', amount: 20_000n, concept: 'Retiro jugador' }, m.id);
    const closed = await crew.closeCash(opId, box.id, 125_000n, m.id);
    expect(closed).toMatchObject({ status: 'closed', expectedBalance: 130_000n, declaredBalance: 125_000n, difference: -5_000n });
    await expect(crew.cashMovement(opId, box.id, { type: 'in', amount: 1n, concept: 'tarde' }, m.id)).rejects.toMatchObject({ status: 409 });
    expect(await crew.reopenCash(opId, box.id, 'admin', 'Corrección de un movimiento')).toMatchObject({ status: 'open', reopenReason: 'Corrección de un movimiento' });

    // Nómina de noviembre: 8 h normales + 14 h de franco a 1,5; ajustes; mes congelado.
    await crew.addAdjustment(opId, { memberId: m.id, month: '2026-11', type: 'bonus', amount: 1_000_000n, note: 'Mejor del mes' }, 'admin');
    const pay = (await crew.payroll(opId, '2026-11')).find((r) => r.member.id === m.id)!;
    // valor hora = 240.000.000 / 240 = 1.000.000; franco 14 h × 1,5 = 21.000.000
    expect(pay.result).toMatchObject({ base: 240_000_000n, overtime: 21_000_000n, bonuses: 1_000_000n, total: 262_000_000n });
    expect((await crew.closeMonth(opId, '2026-11', 'admin')).closed).toBeGreaterThanOrEqual(1);
    await expect(crew.addAdjustment(opId, { memberId: m.id, month: '2026-11', type: 'discount', amount: 1n, note: '' }, 'admin')).rejects.toMatchObject({ status: 409 });
    await crew.markPaid(opId, '2026-11', m.id, 'admin');
    await expect(crew.markPaid(opId, '2026-11', m.id, 'admin')).rejects.toMatchObject({ status: 409 });
    expect((await crew.payroll(opId, '2026-11')).find((r) => r.member.id === m.id)!.closed?.paidAt).toBeTruthy();
  });
});
