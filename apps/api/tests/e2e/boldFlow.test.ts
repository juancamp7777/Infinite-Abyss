import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { BoldProvider, type BoldKeys } from '../../src/infrastructure/payments/BoldProvider';
import { PaymentProviderRegistry } from '../../src/infrastructure/payments/PaymentProviderRegistry';
import type { FetchLike } from '../../src/infrastructure/payments/types';
import { createTestOperator, TEST_PASSWORD } from '../setup/factories';

const KEYS: BoldKeys = { identityKey: 'bold-identidad-e2e', secretKey: 'bold-secreta-e2e' };
const keysByOperator = new Map<string, BoldKeys>();
const calls: Array<{ url: string; auth?: string; body?: string }> = [];
let linkStatus = 'PAID';
/** Cada corrida crea un link distinto (Bold nunca repite el id). */
const LINK = `LNK_${randomUUID().slice(0, 8).toUpperCase()}`;

/** Bold falso: crea el link y responde su estado. */
const fakeFetch: FetchLike = async (url, init) => {
  calls.push({ url, auth: init?.headers?.Authorization, body: init?.body });
  const body = url.endsWith('/online/link/v1')
    ? { payload: { payment_link: LINK, url: `https://checkout.bold.co/payment/${LINK}` }, errors: [] }
    : { id: LINK, status: linkStatus, total: 50000 };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

let created: CreatedApp;

beforeAll(async () => {
  const registry = new PaymentProviderRegistry([
    new BoldProvider({
      keys: async (op) => keysByOperator.get(op) ?? null,
      deposit: (ref) => prisma.deposit.findFirst({ where: { provider: 'BOLD', providerReference: ref }, select: { operatorId: true, externalId: true } }),
      returnUrl: 'https://infinite-abyss.com/cashier',
    }, fakeFetch),
  ]);
  created = createApp(getConfig(), { registry, bcryptCost: 4, rateLimit: { disabled: true } as any, modules: false });
  await new Promise<void>((r) => created.httpServer.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await created.close();
});

/** Aviso de Bold firmado como en su documentación: HMAC-SHA256 (hex) del cuerpo en Base64. */
function boldWebhook(reference: string, total: number, secret = KEYS.secretKey, paymentId = `pay-${reference}`) {
  const raw = JSON.stringify({
    id: randomUUID(), type: 'SALE_APPROVED', subject: 'pay-1', source: '/payments', spec_version: '1.0', time: Date.now(), datacontenttype: 'application/json',
    data: { payment_id: paymentId, merchant_id: 'M1', payment_method: 'PSE', amount: { currency: 'COP', total, tip: 0, taxes: [] }, metadata: { reference } },
  });
  return { raw, signature: createHmac('sha256', secret).update(Buffer.from(raw).toString('base64')).digest('hex') };
}

describe('Bold: PSE, Nequi y tarjetas en la caja', () => {
  it('link de pago → aviso firmado → confirmación con Bold → saldo acreditado una sola vez', async () => {
    const api = request(created.httpServer);
    const op = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
    const other = await createTestOperator({ currencies: ['COP'], defaultCurrency: 'COP' });
    keysByOperator.set(op.id, KEYS);

    const session = async (o: typeof op) => {
      const T = { 'X-Operator-Slug': o.slug };
      const email = `bold-${randomUUID().slice(0, 8)}@test.local`;
      await api.post('/api/auth/register').set(T).send({ email, password: TEST_PASSWORD }).expect(201);
      const login = await api.post('/api/auth/login').set(T).send({ email, password: TEST_PASSWORD }).expect(200);
      return { ...T, Authorization: `Bearer ${login.body.accessToken}` };
    };
    const auth = await session(op);
    const cash = async () => BigInt((await api.get('/api/me').set(auth)).body.balances.cash);

    // Solo aparece en el casino que conectó sus llaves de Bold.
    const methods = await api.get('/api/cashier/methods').set(auth).expect(200);
    expect(methods.body.methods).toEqual([expect.objectContaining({ provider: 'BOLD', label: 'PSE, Nequi o tarjeta' })]);
    expect((await api.get('/api/cashier/methods').set(await session(other))).body.methods).toEqual([]);

    // 50.000 COP (unidades mínimas con 2 decimales).
    const dep = await api.post('/api/cashier/deposits').set(auth).send({ provider: 'BOLD', amount: '5000000', currency: 'COP' });
    expect(dep.status).toBe(201);
    expect(dep.body.redirectUrl).toBe(`https://checkout.bold.co/payment/${LINK}`);
    const sent = JSON.parse(calls.find((c) => c.url.endsWith('/online/link/v1'))!.body!);
    expect(sent).toMatchObject({ amount_type: 'CLOSE', amount: { currency: 'COP', total_amount: 50000 }, reference: dep.body.providerReference, callback_url: 'https://infinite-abyss.com/cashier' });
    expect(calls[0].auth).toBe(`x-api-key ${KEYS.identityKey}`);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: dep.body.depositId } })).externalId).toBe(LINK);

    const before = await cash();
    const hook = (w: { raw: string; signature: string }) => api.post('/api/webhooks/bold').set('content-type', 'application/json').set('x-bold-signature', w.signature).send(w.raw);

    // Firma con otra llave → rechazado. Monto distinto → no acredita.
    expect((await hook(boldWebhook(dep.body.providerReference, 50000, 'otra-llave'))).status).toBe(401);
    expect((await hook(boldWebhook(dep.body.providerReference, 49000, KEYS.secretKey, `pay-${randomUUID()}`))).body.result).toBe('amount_mismatch');

    // Si Bold aún no marca el link como pagado, no se acredita (Bold reintentará el aviso).
    linkStatus = 'PROCESSING';
    expect((await hook(boldWebhook(dep.body.providerReference, 50000))).status).toBe(409);
    expect(await cash()).toBe(before);

    linkStatus = 'PAID';
    const ok = boldWebhook(dep.body.providerReference, 50000);
    const res = await api.post('/api/webhooks/bold').set('content-type', 'application/json').set('x-bold-signature', ok.signature).send(ok.raw);
    expect(res.status).toBe(200);
    expect(await cash()).toBe(before + 5_000_000n);

    // Reenvío del mismo aviso: sin efecto.
    expect((await hook(ok)).body.result).toBe('duplicate');
    expect(await cash()).toBe(before + 5_000_000n);
  });
});
