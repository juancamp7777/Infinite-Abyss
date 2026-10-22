import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator, createTestPlayer } from '../setup/factories';
import { buildHarness } from './harness';

async function setup(opts: { kyc?: 'VERIFIED' | 'NONE'; cash?: bigint; limits?: Record<string, unknown> } = {}) {
  const h = buildHarness();
  const op = await createTestOperator({ limits: opts.limits });
  const user = await createTestPlayer(op.id, { kycStatus: opts.kyc ?? 'VERIFIED' });
  h.wallet.setCash(user.id, opts.cash ?? 100_000n);
  const finance = await createBackofficeUser('OPERATOR_FINANCE', op.id);
  const support = await createBackofficeUser('OPERATOR_SUPPORT', op.id);
  return { h, op, user, finance, support };
}

const destination = { address: 'TXyz123', network: 'TRC20' };
const requestWd = (h: ReturnType<typeof buildHarness>, userId: string, amount: string) =>
  request(h.app)
    .post('/api/cashier/withdrawals')
    .set('x-test-player', userId)
    .send({ provider: 'PASSIMPAY', amount, currency: 'USD', destination });

describe('Solicitud de retiro', () => {
  it('sin KYC verificado → rechazado y sin reservar', async () => {
    const { h, user } = await setup({ kyc: 'NONE' });
    const res = await requestWd(h, user.id, '1000');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('KYC_REQUIRED');
    expect(h.wallet.callsOf('reserveWithdrawal')).toHaveLength(0);
  });

  it('mayor que el saldo CASH → rechazado', async () => {
    const { h, user } = await setup({ cash: 500n });
    const res = await requestWd(h, user.id, '1000');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.wallet.callsOf('reserveWithdrawal')).toHaveLength(0);
    expect(await prisma.withdrawal.count({ where: { userId: user.id } })).toBe(0);
  });

  it('cuenta demo → rechazado', async () => {
    const h = buildHarness();
    const op = await createTestOperator();
    const user = await createTestPlayer(op.id, { isDemo: true, kycStatus: 'VERIFIED' });
    h.wallet.setCash(user.id, 10_000n);
    expect((await requestWd(h, user.id, '1000')).status).toBe(403);
  });

  it('respeta mínimo, máximo y tope diario del operador', async () => {
    const { h, user } = await setup({ limits: { minWithdrawal: '100', maxWithdrawal: '5000', maxDailyWithdrawal: '6000' } });
    expect((await requestWd(h, user.id, '99')).status).toBeGreaterThanOrEqual(400);
    expect((await requestWd(h, user.id, '5001')).status).toBeGreaterThanOrEqual(400);
    expect((await requestWd(h, user.id, '4000')).status).toBe(201);
    expect((await requestWd(h, user.id, '3000')).status).toBeGreaterThanOrEqual(400); // 7000 > 6000
  });

  it('válido → REQUESTED con reserva wd-reserve:<id> y AuditLog', async () => {
    const { h, user } = await setup();
    const res = await requestWd(h, user.id, '1000');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REQUESTED');
    const calls = h.wallet.callsOf('reserveWithdrawal');
    expect(calls).toHaveLength(1);
    expect(calls[0].input.idempotencyKey).toBe(`wd-reserve:${res.body.id}`);
    expect(h.wallet.cash.get(user.id)).toBe(99_000n);
    expect(await prisma.auditLog.count({ where: { targetId: res.body.id, action: 'withdrawal.requested' } })).toBe(1);
  });
});

describe('Revisión de retiros (backoffice)', () => {
  it('REQUESTED → approve → mark-paid llama a reserve y complete, con AuditLog', async () => {
    const { h, user, finance } = await setup();
    const w = (await requestWd(h, user.id, '1000')).body;
    // PASSIMPAY habilitado: el payout falla (destino sin cryptoAmount) → queda APPROVED
    const approve = await request(h.app).post(`/api/backoffice/withdrawals/${w.id}/approve`).set('x-test-bo', finance.id);
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('APPROVED');
    const paid = await request(h.app).post(`/api/backoffice/withdrawals/${w.id}/mark-paid`).set('x-test-bo', finance.id);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(h.wallet.callsOf('reserveWithdrawal')).toHaveLength(1);
    const complete = h.wallet.callsOf('completeWithdrawal');
    expect(complete).toHaveLength(1);
    expect(complete[0].input.idempotencyKey).toBe(`wd-payout:${w.id}`);
    const actions = (await prisma.auditLog.findMany({ where: { targetId: w.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['withdrawal.requested', 'withdrawal.approved', 'withdrawal.paid']));
    const approvedLog = await prisma.auditLog.findFirst({ where: { targetId: w.id, action: 'withdrawal.approved' } });
    expect(approvedLog!.actorId).toBe(finance.id);
    expect(approvedLog!.before).toEqual({ status: 'REQUESTED' });
  });

  it('approve con payout aceptado por el PSP → PROCESSING; webhook PAID lo cierra', async () => {
    const { h, user, finance } = await setup();
    const res = await request(h.app)
      .post('/api/cashier/withdrawals')
      .set('x-test-player', user.id)
      .send({ provider: 'PASSIMPAY', amount: '1000', currency: 'USD', destination: { address: 'TX1', currencyId: '7', cryptoAmount: '10.5' } });
    const id = res.body.id;
    h.setFetch(() => ({ body: { result: 1, order_id: 'psp-77' } }));
    const approve = await request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', finance.id);
    expect(approve.body.status).toBe('PROCESSING');
    expect(approve.body.externalId).toBe('psp-77');
    expect(h.fetchCalls.some((c) => c.url.endsWith('/v2/withdraw'))).toBe(true);

    h.setFetch(() => ({ body: { result: 1, status: 'paid' } }));
    const out = await h.review.applyProviderResult(id, 'PAID');
    expect(out).toBe('withdrawal_paid');
    expect((await prisma.withdrawal.findUnique({ where: { id } }))!.status).toBe('PAID');
    expect(h.wallet.callsOf('completeWithdrawal')).toHaveLength(1);
  });

  it('FAILED del PSP → FAILED y libera la reserva', async () => {
    const { h, user, finance } = await setup();
    const id = (await requestWd(h, user.id, '1000')).body.id;
    await request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', finance.id);
    expect(await h.review.applyProviderResult(id, 'FAILED')).toBe('withdrawal_failed');
    expect(h.wallet.callsOf('releaseWithdrawal')).toHaveLength(1);
    expect(h.wallet.cash.get(user.id)).toBe(100_000n);
    expect((await prisma.withdrawal.findUnique({ where: { id } }))!.status).toBe('FAILED');
  });

  it('reject libera la reserva, exige motivo y no se puede pagar después', async () => {
    const { h, user, finance } = await setup();
    const id = (await requestWd(h, user.id, '1000')).body.id;
    const noReason = await request(h.app).post(`/api/backoffice/withdrawals/${id}/reject`).set('x-test-bo', finance.id).send({});
    expect(noReason.status).toBe(422);
    const rej = await request(h.app).post(`/api/backoffice/withdrawals/${id}/reject`).set('x-test-bo', finance.id).send({ reason: 'Documentos dudosos' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('REJECTED');
    const rel = h.wallet.callsOf('releaseWithdrawal');
    expect(rel).toHaveLength(1);
    expect(rel[0].input.idempotencyKey).toBe(`wd-release:${id}`);
    expect(h.wallet.cash.get(user.id)).toBe(100_000n);
    const paid = await request(h.app).post(`/api/backoffice/withdrawals/${id}/mark-paid`).set('x-test-bo', finance.id);
    expect(paid.status).toBe(409);
    expect(h.wallet.callsOf('completeWithdrawal')).toHaveLength(0);
    const log = await prisma.auditLog.findFirst({ where: { targetId: id, action: 'withdrawal.rejected' } });
    expect(log!.reason).toBe('Documentos dudosos');
  });

  it('no se puede aprobar dos veces (secuencial ni concurrente)', async () => {
    const { h, user, finance } = await setup();
    const id = (await requestWd(h, user.id, '1000')).body.id;
    const rs = await Promise.all(
      [1, 2, 3].map(() => request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', finance.id)),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    const again = await request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', finance.id);
    expect(again.status).toBe(409);
  });

  it('no se puede marcar pagado un retiro REQUESTED', async () => {
    const { h, user, finance } = await setup();
    const id = (await requestWd(h, user.id, '1000')).body.id;
    const res = await request(h.app).post(`/api/backoffice/withdrawals/${id}/mark-paid`).set('x-test-bo', finance.id);
    expect(res.status).toBe(409);
  });

  it('OPERATOR_FINANCE de A no puede aprobar un retiro de B (403)', async () => {
    const a = await setup();
    const b = await setup();
    const id = (await requestWd(b.h, b.user.id, '1000')).body.id;
    // mismo arnés lógico: los usuarios están en la misma BD
    const res = await request(b.h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', a.finance.id);
    expect(res.status).toBe(403);
    expect((await prisma.withdrawal.findUnique({ where: { id } }))!.status).toBe('REQUESTED');
    const list = await request(a.h.app).get('/api/backoffice/withdrawals').set('x-test-bo', a.finance.id);
    expect(list.body.items.find((w: any) => w.id === id)).toBeUndefined();
  });

  it('OPERATOR_SUPPORT no puede aprobar ni pagar (403)', async () => {
    const { h, user, support } = await setup();
    const id = (await requestWd(h, user.id, '1000')).body.id;
    expect((await request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', support.id)).status).toBe(403);
    expect((await request(h.app).post(`/api/backoffice/withdrawals/${id}/mark-paid`).set('x-test-bo', support.id)).status).toBe(403);
  });

  it('OPERATOR_ADMIN no puede marcar pagado (solo finanzas/plataforma)', async () => {
    const { h, op, user, finance } = await setup();
    const admin = await createBackofficeUser('OPERATOR_ADMIN', op.id);
    const id = (await requestWd(h, user.id, '1000')).body.id;
    await request(h.app).post(`/api/backoffice/withdrawals/${id}/approve`).set('x-test-bo', finance.id);
    expect((await request(h.app).post(`/api/backoffice/withdrawals/${id}/mark-paid`).set('x-test-bo', admin.id)).status).toBe(403);
    const pa = await createBackofficeUser('PLATFORM_ADMIN', null);
    expect((await request(h.app).post(`/api/backoffice/withdrawals/${id}/mark-paid`).set('x-test-bo', pa.id)).status).toBe(200);
  });

  it('lista con filtro de status', async () => {
    const { h, user, finance } = await setup();
    await requestWd(h, user.id, '1000');
    const res = await request(h.app).get('/api/backoffice/withdrawals?status=REQUESTED').set('x-test-bo', finance.id);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect((await request(h.app).get('/api/backoffice/withdrawals?status=PAID').set('x-test-bo', finance.id)).body.items).toHaveLength(0);
  });
});
