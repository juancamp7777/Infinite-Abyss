import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { passimpaySignature } from '../../src/domain/payments/signature';
import { PaymentProviderRegistry } from '../../src/infrastructure/payments/PaymentProviderRegistry';
import { PassimpayProvider } from '../../src/infrastructure/payments/PassimpayProvider';
import type { FetchLike } from '../../src/infrastructure/payments/types';
import { createBackofficeUser, createTestOperator, TEST_PASSWORD } from '../setup/factories';
import {
  accountBalance,
  assertOperatorLedgerBalanced,
  bearer,
  buildIntegrationApp,
  expectReconciled,
  hubWallet,
  launchHub,
  ledgerCount,
  promotionsOf,
  waitFor,
} from '../integration/helpers';

// E2E con módulos en COP: operador COP + jugador COP → depósito → Studios (dice, sin indicar divisa) + Hub +
// bono + jackpot → reconciliación con totalDiscrepancies = 0 y todos los saldos en COP (centavos, 2 decimales).

const PASSIMPAY = { platformId: '4343', apiKey: 'e2e-cop-passimpay-key', baseUrl: 'https://psp.test', webhookIpAllowlist: [] as string[] };

const fakeFetch: FetchLike = async (url) => {
  let body: Record<string, unknown> = { result: 1 };
  if (url.endsWith('/v2/createorder')) body = { result: 1, url: 'https://psp.test/invoice/cop' };
  else if (url.endsWith('/v2/orderstatus')) body = { result: 1, status: 'paid' };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp({ registry: new PaymentProviderRegistry([new PassimpayProvider(PASSIMPAY, fakeFetch)]) });
});

afterAll(async () => {
  await created.close();
});

describe('flujo completo con módulos en COP (e2e)', () => {
  it('operador COP: depósito → Studios + Hub + bono + jackpot en COP → reconciliación en 0', async () => {
    const api = request(created.app);
    // 500 COP mínimo y 50.000 COP máximo por apuesta (centavos).
    const op = await createTestOperator({ defaultCurrency: 'COP', currencies: ['COP'], limits: { minBet: '50000', maxBet: '5000000' } });
    const T = { 'X-Operator-Slug': op.slug };
    const promo = promotionsOf(created);

    // 1. Registro: el jugador hereda la moneda del operador.
    const email = `e2e-cop-${randomUUID().slice(0, 8)}@test.local`;
    expect((await api.post('/api/auth/register').set(T).send({ email, password: TEST_PASSWORD })).status).toBe(201);
    const login = await api.post('/api/auth/login').set(T).send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const token: string = login.body.accessToken;
    const userId: string = login.body.user.id;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).currency).toBe('COP');
    const auth = { ...T, ...bearer(token) };
    const cash = async () => BigInt((await api.get('/api/me').set(auth)).body.balances.cash);

    // 2. Depósito de 200.000 COP confirmado por webhook firmado.
    const DEPOSIT = 20_000_000n;
    const dp = await api.post('/api/cashier/deposits').set(auth).send({ provider: 'PASSIMPAY', amount: DEPOSIT.toString(), currency: 'COP' });
    expect(dp.status, JSON.stringify(dp.body)).toBe(201);
    const dep = await prisma.deposit.findFirstOrThrow({ where: { userId, provider: 'PASSIMPAY' } });
    expect(dep.currency).toBe('COP');
    const raw = JSON.stringify({ order_id: dep.providerReference, status: 'paid', txhash: `tx-${randomUUID()}`, platform_id: 4343 });
    const hook = await api
      .post('/api/webhooks/passimpay')
      .set('content-type', 'application/json')
      .set('x-signature', passimpaySignature(PASSIMPAY.platformId, raw, PASSIMPAY.apiKey))
      .send(raw);
    expect(hook.status).toBe(200);
    expect(await cash()).toBe(DEPOSIT);
    await created.services.bus.drain();

    // 3. Jackpot determinista (cae en semilla + 1) y bono de 20.000 COP con wagering x1.
    const SEED = 1_000_000n;
    await promo.jackpots.create({
      operatorId: op.id,
      name: 'Jackpot COP',
      currency: 'COP',
      contributionBps: 1000,
      levels: [{ key: 'mini', seedAmount: SEED, shareBps: 10_000, triggerChancePpm: 0, mustDropBy: SEED + 1n }],
    });
    const BONUS = 2_000_000n;
    const code = `COP${randomUUID().slice(0, 8).toUpperCase()}`;
    await promo.bonuses.createTemplate({ operatorId: op.id, name: 'Bono COP', type: 'promo_code', currency: 'COP', code, fixedAmount: BONUS, wageringMultiplier: 1 });
    const bonus = await promo.bonuses.claim(op.id, userId, code);
    expect(bonus).toMatchObject({ status: 'ACTIVE', currency: 'COP' });
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'COP', userId)).toBe(BONUS);

    // 4. Studios: saldo y apuestas sin indicar divisa → COP (moneda del jugador/operador).
    const bal = await api.get('/studio/v1/balance').set(bearer(token));
    expect(bal.status, JSON.stringify(bal.body)).toBe(200);
    expect(bal.body.currency).toBe('COP');
    // Por debajo del mínimo del operador (100 COP < 500 COP) → rechazada sin tocar el ledger.
    const low = await api.post('/studio/v1/play/nymfo-dice').set(bearer(token)).send({ amount: '10000', params: { target: 50, over: true } });
    expect(low.status).toBe(400);
    expect(low.body.error?.code ?? low.body.code).toBe('BET_TOO_LOW');
    // Una divisa no habilitada por el operador se rechaza.
    const usd = await api.post('/studio/v1/play/nymfo-dice').set(bearer(token)).send({ amount: '100000', currency: 'USD', params: { target: 50, over: true } });
    expect(usd.status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const play = await api.post('/studio/v1/play/nymfo-dice').set(bearer(token)).send({ amount: '1000000', params: { target: 50, over: true } });
      expect(play.status, JSON.stringify(play.body)).toBe(200);
      expect(play.body.round).toMatchObject({ status: 'SETTLED', currency: 'COP' });
      await created.services.bus.drain();
    }

    // 5. Hub en COP: bet + win firmados (completa el wagering).
    const session = await launchHub(created, token, 'COP');
    const roundId = `r-${randomUUID()}`;
    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId, amount: '1000000' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    const win = await hubWallet(created, 'win', { sessionToken: session, transactionId: `w-${randomUUID()}`, roundId, amount: '500000' });
    expect(win.status, JSON.stringify(win.body)).toBe(200);
    await created.services.bus.drain();

    const done = await waitFor(() => promo.bonuses.getBonus(bonus.id), (b) => b?.status === 'COMPLETED');
    expect(done?.status).toBe('COMPLETED');
    expect(await ledgerCount(op.id, 'BONUS_CONVERT')).toBe(1);
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'COP', userId)).toBe(0n);
    expect(await waitFor(() => ledgerCount(op.id, 'JACKPOT_PAYOUT'), (n) => n >= 3)).toBe(3);

    // 6. Demo anónimo del operador: sesión demo en COP sin indicar divisa.
    const demo = await api.post('/studio/v1/demo/session').send({ operatorId: op.id });
    expect(demo.status, JSON.stringify(demo.body)).toBe(201);
    expect(demo.body).toMatchObject({ currency: 'COP', mode: 'demo' });

    // 7. Ledger: todo suma 0, solo hay cuentas COP y la reconciliación da 0 discrepancias.
    const byType = await assertOperatorLedgerBalanced(op.id);
    expect(byType).toMatchObject({ DEPOSIT: 1, BONUS_GRANT: 1, BET: 3, JACKPOT_PAYOUT: 3, BONUS_CONVERT: 1 });
    const currencies = await prisma.ledgerAccount.findMany({ where: { operatorId: op.id }, distinct: ['currency'], select: { currency: true } });
    expect(currencies.map((c) => c.currency)).toEqual(['COP']);
    expect(await accountBalance(op.id, 'JACKPOT_POOL', 'COP')).toBe(SEED);
    expect((await api.get('/studio/v1/balance').set(bearer(token))).body.currency).toBe('COP');

    const finance = await createBackofficeUser('OPERATOR_FINANCE', op.id);
    const bo = await api.post('/api/backoffice/auth/login').send({ email: finance.email, password: TEST_PASSWORD });
    expect(bo.status).toBe(200);
    const rec = await api.get(`/api/backoffice/reconciliation?operatorId=${op.id}`).set(bearer(bo.body.accessToken));
    expect(rec.status).toBe(200);
    expect(rec.body.totalDiscrepancies).toBe(0);
    await expectReconciled(created, op.id);
  }, 90_000);
});
