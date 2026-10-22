import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { passimpaySignature, sha256Hex } from '../../src/domain/payments/signature';
import { createTestOperator, createTestPlayer } from '../setup/factories';
import { PASSIMPAY, WOMPI, buildHarness } from './harness';

async function setupDeposit(provider: 'PASSIMPAY' | 'WOMPI', amount = 50_000n) {
  const op = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
  const user = await createTestPlayer(op.id, { currency: 'COP' });
  const deposit = await prisma.deposit.create({
    data: {
      operatorId: op.id,
      userId: user.id,
      provider,
      status: 'PENDING',
      amount,
      currency: 'COP',
      providerReference: `dep_${randomUUID().replace(/-/g, '')}`,
    },
  });
  return { op, user, deposit };
}

function passimpayWebhook(body: object, key = PASSIMPAY.apiKey) {
  const raw = JSON.stringify(body);
  return { raw, signature: passimpaySignature(PASSIMPAY.platformId, raw, key) };
}

function wompiWebhook(ref: string, txId: string, status: string, cents: number, secret = WOMPI.eventsSecret) {
  const timestamp = 1_700_000_000;
  const checksum = sha256Hex(`${txId}${status}${cents}${timestamp}${secret}`);
  const body = {
    event: 'transaction.updated',
    data: { transaction: { id: txId, reference: ref, status, amount_in_cents: cents, currency: 'COP' } },
    timestamp,
    signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum },
  };
  return { raw: JSON.stringify(body), checksum };
}

const U = randomUUID().slice(0, 8);
const paidStatus = () => ({ body: { result: 1, status: 'paid' } });

describe('Passimpay webhook', () => {
  it('firma inválida → 401, payload guardado con signatureValid=false y sin acreditar', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    const { raw } = passimpayWebhook({ order_id: deposit.providerReference, status: 'paid', txhash: `tx1-${randomUUID()}` }, 'otra-clave');
    const sig = passimpaySignature(PASSIMPAY.platformId, raw, 'otra-clave');
    const res = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', sig).send(raw);
    expect(res.status).toBe(401);
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
    const events = await prisma.webhookEvent.findMany({ where: { rawBody: raw } });
    expect(events).toHaveLength(1);
    expect(events[0].signatureValid).toBe(false);
    expect((await prisma.deposit.findUnique({ where: { id: deposit.id } }))!.status).toBe('PENDING');
  });

  it('sin cabecera de firma o con longitud distinta → 401 sin excepción', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    const raw = JSON.stringify({ order_id: deposit.providerReference, status: 'paid' });
    const r1 = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').send(raw);
    const r2 = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', 'abc').send(raw);
    expect([r1.status, r2.status]).toEqual([401, 401]);
  });

  it('firma válida → CONFIRMED, acredita una vez con deposit:<id> y el monto del Deposit', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY', 12_345n);
    h.setFetch(paidStatus);
    // el monto en cripto del webhook NO se usa para acreditar
    const { raw, signature } = passimpayWebhook({ order_id: deposit.providerReference, status: 'paid', txhash: `tx1-${randomUUID()}`, amount: '999.9', platform_id: 4242 });
    const res = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', signature).send(raw);
    expect(res.status).toBe(200);
    const calls = h.wallet.callsOf('creditDeposit');
    expect(calls).toHaveLength(1);
    expect(calls[0].input.idempotencyKey).toBe(`deposit:${deposit.id}`);
    expect(calls[0].input.amount).toBe(12_345n);
    const d = await prisma.deposit.findUnique({ where: { id: deposit.id } });
    expect(d!.status).toBe('CONFIRMED');
    expect(d!.ledgerTransactionId).toBeTruthy();
    expect(d!.confirmedAt).toBeTruthy();
    expect(h.fetchCalls.some((c) => c.url.endsWith('/v2/orderstatus'))).toBe(true);
  });

  it('reenvío idéntico y webhooks de 1 y 2 confirmaciones → una sola acreditación', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    h.setFetch(paidStatus);
    const send = async (body: object) => {
      const { raw, signature } = passimpayWebhook(body);
      return request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', signature).send(raw);
    };
    const base = { order_id: deposit.providerReference, status: 'paid', txhash: `tx-btc-${randomUUID()}` };
    expect((await send({ ...base, confirmations: 1 })).status).toBe(200);
    const second = await send({ ...base, confirmations: 2 });
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('duplicate');
    expect((await send({ ...base, confirmations: 1 })).status).toBe(200);
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(1);
  });

  it('webhooks concurrentes del mismo evento acreditan una sola vez en el ledger', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    h.setFetch(paidStatus);
    const { raw, signature } = passimpayWebhook({ order_id: deposit.providerReference, status: 'paid', txhash: `tx-c-${randomUUID()}` });
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', signature).send(raw),
      ),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const txIds = new Set(h.wallet.callsOf('creditDeposit').map((c) => c.input.idempotencyKey));
    expect(txIds.size).toBe(1);
    expect(h.wallet.cash.get(deposit.userId)).toBe(deposit.amount); // el fake respeta idempotencia
  });

  it('si check-invoice no confirma, no acredita y responde 409 (el PSP reintentará)', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    h.setFetch(() => ({ body: { result: 1, status: 'wait' } }));
    const { raw, signature } = passimpayWebhook({ order_id: deposit.providerReference, status: 'paid', txhash: `tx-x-${randomUUID()}` });
    const res = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', signature).send(raw);
    expect(res.status).toBe(409);
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
  });

  it('IP fuera de la lista permitida → 401', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('PASSIMPAY');
    const registry = h.registry.get('PASSIMPAY') as any;
    registry.config.webhookIpAllowlist = ['10.9.9.9'];
    h.setFetch(paidStatus);
    const { raw, signature } = passimpayWebhook({ order_id: deposit.providerReference, status: 'paid', txhash: `tx-ip-${randomUUID()}` });
    const res = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').set('x-signature', signature).send(raw);
    expect(res.status).toBe(401);
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
  });
});

describe('Wompi webhook', () => {
  it('checksum inválido → 401, guardado con signatureValid=false, sin acreditar', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('WOMPI');
    const { raw } = wompiWebhook(deposit.providerReference, `w-${U}1`, 'APPROVED', 50_000, 'secreto-falso');
    const res = await request(h.app).post('/api/webhooks/wompi').set('content-type', 'application/json').send(raw);
    expect(res.status).toBe(401);
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
    const ev = await prisma.webhookEvent.findFirst({ where: { rawBody: raw } });
    expect(ev!.signatureValid).toBe(false);
  });

  it('APPROVED válido → CONFIRMED, una acreditación; el reenvío responde 200 sin efecto', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('WOMPI');
    h.setFetch(() => ({ body: { data: { id: `w-${U}2`, status: 'APPROVED' } } }));
    const { raw, checksum } = wompiWebhook(deposit.providerReference, `w-${U}2`, 'APPROVED', 50_000);
    const send = () =>
      request(h.app).post('/api/webhooks/wompi').set('content-type', 'application/json').set('x-event-checksum', checksum).send(raw);
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(200);
    expect(again.body.result).toBe('duplicate');
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(1);
    expect(h.wallet.callsOf('creditDeposit')[0].input.idempotencyKey).toBe(`deposit:${deposit.id}`);
    expect((await prisma.deposit.findUnique({ where: { id: deposit.id } }))!.status).toBe('CONFIRMED');
  });

  it('monto distinto al del Deposit → no acredita', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('WOMPI', 50_000n);
    h.setFetch(() => ({ body: { data: { id: `w-${U}3`, status: 'APPROVED' } } }));
    const { raw } = wompiWebhook(deposit.providerReference, `w-${U}3`, 'APPROVED', 1);
    const res = await request(h.app).post('/api/webhooks/wompi').set('content-type', 'application/json').send(raw);
    expect(res.body.result).toBe('amount_mismatch');
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
  });

  it('DECLINED → FAILED sin acreditar', async () => {
    const h = buildHarness();
    const { deposit } = await setupDeposit('WOMPI');
    const { raw } = wompiWebhook(deposit.providerReference, `w-${U}4`, 'DECLINED', 50_000);
    const res = await request(h.app).post('/api/webhooks/wompi').set('content-type', 'application/json').send(raw);
    expect(res.status).toBe(200);
    expect((await prisma.deposit.findUnique({ where: { id: deposit.id } }))!.status).toBe('FAILED');
    expect(h.wallet.callsOf('creditDeposit')).toHaveLength(0);
  });
});

describe('Adaptadores deshabilitados', () => {
  it('sin credenciales: no aparece en /methods y el webhook responde 503', async () => {
    const h = buildHarness({ passimpay: false, wompi: true });
    const op = await createTestOperator();
    const user = await createTestPlayer(op.id);
    const methods = await request(h.app).get('/api/cashier/methods').set('x-test-player', user.id);
    expect(methods.status).toBe(200);
    expect(methods.body.methods.map((m: any) => m.provider)).toEqual(['WOMPI']);

    const res = await request(h.app).post('/api/webhooks/passimpay').set('content-type', 'application/json').send('{}');
    expect(res.status).toBe(503);
    expect(await prisma.webhookEvent.count({ where: { rawBody: '{}', provider: 'PASSIMPAY' } })).toBe(0);
  });

  it('crear un depósito con un proveedor deshabilitado → 503', async () => {
    const h = buildHarness({ passimpay: false, wompi: true });
    const op = await createTestOperator();
    const user = await createTestPlayer(op.id);
    const res = await request(h.app)
      .post('/api/cashier/deposits')
      .set('x-test-player', user.id)
      .send({ provider: 'PASSIMPAY', amount: '1000', currency: 'USD' });
    expect(res.status).toBe(503);
  });
});

describe('Crear depósito', () => {
  it('Passimpay: crea Deposit PENDING con invoice link y no acredita', async () => {
    const h = buildHarness();
    const op = await createTestOperator({ limits: { minDeposit: '500', maxDeposit: '100000' } });
    const user = await createTestPlayer(op.id);
    h.setFetch(() => ({ body: { result: 1, url: 'https://passimpay.io/invoice/abc' } }));
    const res = await request(h.app)
      .post('/api/cashier/deposits')
      .set('x-test-player', user.id)
      .send({ provider: 'PASSIMPAY', amount: '1000', currency: 'USD' });
    expect(res.status).toBe(201);
    expect(res.body.redirectUrl).toBe('https://passimpay.io/invoice/abc');
    const d = await prisma.deposit.findUnique({ where: { id: res.body.depositId } });
    expect(d!.status).toBe('PENDING');
    expect(d!.amount).toBe(1000n);
    const sent = JSON.parse(h.fetchCalls[0].init.body);
    expect(sent.orderId).toBe(d!.providerReference);
    expect(sent.amount).toBe('10.00');
    expect(h.fetchCalls[0].init.headers['x-signature']).toBe(
      passimpaySignature(PASSIMPAY.platformId, h.fetchCalls[0].init.body, PASSIMPAY.apiKey),
    );
    expect(h.wallet.calls).toHaveLength(0);
  });

  it('respeta mínimos/máximos del operador y valida el monto', async () => {
    const h = buildHarness();
    const op = await createTestOperator({ limits: { minDeposit: '500', maxDeposit: '100000' } });
    const user = await createTestPlayer(op.id);
    const post = (amount: string) =>
      request(h.app).post('/api/cashier/deposits').set('x-test-player', user.id).send({ provider: 'PASSIMPAY', amount, currency: 'USD' });
    expect((await post('499')).status).toBeGreaterThanOrEqual(400);
    expect((await post('100001')).status).toBeGreaterThanOrEqual(400);
    expect((await post('12.5')).status).toBe(422);
    expect((await post('-5')).status).toBe(422);
    expect(await prisma.deposit.count({ where: { operatorId: op.id } })).toBe(0);
  });

  it('Wompi: URL de checkout con firma de integridad', async () => {
    const h = buildHarness();
    const op = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
    const user = await createTestPlayer(op.id, { currency: 'COP' });
    const res = await request(h.app)
      .post('/api/cashier/deposits')
      .set('x-test-player', user.id)
      .send({ provider: 'WOMPI', amount: '2000000', currency: 'COP' });
    expect(res.status).toBe(201);
    const url = new URL(res.body.redirectUrl);
    expect(url.searchParams.get('amount-in-cents')).toBe('2000000');
    expect(url.searchParams.get('signature:integrity')).toBe(
      sha256Hex(`${res.body.providerReference}2000000COP${WOMPI.integritySecret}`),
    );
  });
});
