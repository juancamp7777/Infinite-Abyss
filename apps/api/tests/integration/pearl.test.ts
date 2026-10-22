import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { accountBalance, assertOperatorLedgerBalanced, bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let admin: string;
let playerId: string;
let currency: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  opId = (await createTestOperator()).id;
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const p = await createTestPlayer(opId);
  playerId = p.id;
  currency = (await prisma.user.findUniqueOrThrow({ where: { id: p.id } })).currency;
});

afterAll(async () => {
  await created.close?.();
});

describe('Pearl con Postgres y el ledger real', () => {
  it('feed + comprobante → depósito PEARL confirmado, saldo y ledger cuadrados; el pago no se reutiliza', async () => {
    await request(created.app).put('/pearl/v1/admin/settings').set(bearer(admin)).send({ mode: 'auto', currency, autoMaxAmount: '100000000', minAmount: '100' }).expect(200);
    const feed = await request(created.app).post('/pearl/v1/admin/feeds').set(bearer(admin)).send({ type: 'generic', name: 'Banco IT' });
    expect(feed.status).toBe(201);
    const ext = `IT-${randomUUID()}`;
    await request(created.app).post(feed.body.webhookPath).send({ id: ext, amount: '125.50', senderName: 'Lucia Fernandez', occurredAt: new Date().toISOString() }).expect(200);
    await request(created.app).post(feed.body.webhookPath).send({ id: ext, amount: '125.50', senderName: 'Lucia Fernandez' }).expect(200); // reentrega
    expect(await prisma.pearlBankTx.count({ where: { operatorId: opId, externalId: ext } })).toBe(1);

    const before = await accountBalance(opId, 'PLAYER_CASH', currency, playerId);
    const r = await request(created.app).post('/pearl/v1/admin/receipts').set(bearer(admin)).send({ playerId, extracted: { amount: '125,50', senderName: 'FERNANDEZ LUCIA' } });
    expect(r.body).toMatchObject({ status: 'credited' });
    const dep = await prisma.deposit.findUniqueOrThrow({ where: { providerReference: `pearl:${r.body.id}` } });
    expect(dep).toMatchObject({ provider: 'PEARL', status: 'CONFIRMED', amount: 12550n, userId: playerId });
    expect(dep.externalId).toContain(ext);
    expect((await accountBalance(opId, 'PLAYER_CASH', currency, playerId)) - before).toBe(12550n);
    await assertOperatorLedgerBalanced(opId);

    // Otro comprobante por el mismo monto y titular: el movimiento ya está usado → no acredita.
    // Hora local del comprobante (UTC-3) una hora atrás: siempre reciente, sea cual sea la hora de la corrida.
    const local = new Date(Date.now() - 4 * 3_600_000).toISOString();
    const again = await request(created.app).post('/pearl/v1/admin/receipts').set(bearer(admin)).send({ playerId, extracted: { amount: '125,50', senderName: 'Lucia Fernandez', date: local.slice(0, 10), time: local.slice(11, 16) } });
    expect(again.body.status).toBe('waiting_bank');
    expect(await prisma.deposit.count({ where: { userId: playerId, provider: 'PEARL' } })).toBe(1);
  });
});
