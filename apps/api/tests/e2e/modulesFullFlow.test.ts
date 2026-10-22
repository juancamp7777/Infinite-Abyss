import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { passimpaySignature } from '../../src/domain/payments/signature';
import { PaymentProviderRegistry } from '../../src/infrastructure/payments/PaymentProviderRegistry';
import { PassimpayProvider } from '../../src/infrastructure/payments/PassimpayProvider';
import { WompiProvider } from '../../src/infrastructure/payments/WompiProvider';
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

// (e) E2E con módulos: registro → depósito por webhook firmado → Hub + Studios + bono + jackpot →
// retiro aprobado y pagado → reconciliación de la Fase 1 con totalDiscrepancies = 0.

const PASSIMPAY = { platformId: '4242', apiKey: 'e2e-mod-passimpay-key', baseUrl: 'https://psp.test', webhookIpAllowlist: [] as string[] };
const WOMPI = {
  publicKey: 'e2e-mod-wompi-public',
  privateKey: 'e2e-mod-wompi-private',
  eventsSecret: 'e2e-mod-wompi-events',
  integritySecret: 'e2e-mod-wompi-integrity',
  baseUrl: 'https://wompi.test/v1',
};

/** PSP falso: createorder devuelve link, orderstatus → paid, payouts → ok. */
const fakeFetch: FetchLike = async (url) => {
  let body: Record<string, unknown> = { result: 1 };
  if (url.endsWith('/v2/createorder')) body = { result: 1, url: 'https://psp.test/invoice/abc' };
  else if (url.endsWith('/v2/orderstatus')) body = { result: 1, status: 'paid' };
  else if (url.includes('/transactions')) body = { data: { id: 'w-tx', status: 'APPROVED' } };
  else if (url.endsWith('/v2/withdraw')) body = { result: 1, order_id: `psp-${randomUUID()}` };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

let created: CreatedApp;

beforeAll(async () => {
  const registry = new PaymentProviderRegistry([new PassimpayProvider(PASSIMPAY, fakeFetch), new WompiProvider(WOMPI, fakeFetch)]);
  created = await buildIntegrationApp({ registry });
});

afterAll(async () => {
  await created.close();
});

describe('(e) flujo completo con módulos (e2e)', () => {
  it('registro → depósito → Hub + Studios + bono + jackpot → retiro → reconciliación en 0', async () => {
    const api = request(created.app);
    const op = await createTestOperator();
    const T = { 'X-Operator-Slug': op.slug };
    const promo = promotionsOf(created);

    // 1. Registro real (emite player.registered/login/session.started).
    const email = `e2e-mod-${randomUUID().slice(0, 8)}@test.local`;
    const reg = await api.post('/api/auth/register').set(T).send({ email, password: TEST_PASSWORD });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const login = await api.post('/api/auth/login').set(T).send({ email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const token: string = login.body.accessToken;
    const userId: string = login.body.user.id;
    const auth = { ...T, ...bearer(token) };
    const cash = async () => BigInt((await api.get('/api/me').set(auth)).body.balances.cash);

    // 2. Depósito Passimpay confirmado por webhook firmado.
    const DEPOSIT = 100_000n;
    const dp = await api.post('/api/cashier/deposits').set(auth).send({ provider: 'PASSIMPAY', amount: DEPOSIT.toString(), currency: 'USD' });
    expect(dp.status, JSON.stringify(dp.body)).toBe(201);
    const dep = await prisma.deposit.findFirstOrThrow({ where: { userId, provider: 'PASSIMPAY' } });
    const raw = JSON.stringify({ order_id: dep.providerReference, status: 'paid', txhash: `tx-${randomUUID()}`, platform_id: 4242 });
    const hook = await api
      .post('/api/webhooks/passimpay')
      .set('content-type', 'application/json')
      .set('x-signature', passimpaySignature(PASSIMPAY.platformId, raw, PASSIMPAY.apiKey))
      .send(raw);
    expect(hook.status).toBe(200);
    expect(await cash()).toBe(DEPOSIT);
    await created.services.bus.drain();

    // 3. Jackpot determinista (cae en semilla + 1) y bono con wagering x1.
    await promo.jackpots.create({
      operatorId: op.id,
      name: 'Jackpot e2e',
      currency: 'USD',
      contributionBps: 1000,
      levels: [{ key: 'mini', seedAmount: 1_000n, shareBps: 10_000, triggerChancePpm: 0, mustDropBy: 1_001n }],
    });
    const code = `E2E${randomUUID().slice(0, 8).toUpperCase()}`;
    await promo.bonuses.createTemplate({ operatorId: op.id, name: 'Bono e2e', type: 'promo_code', currency: 'USD', code, fixedAmount: 2_000n, wageringMultiplier: 1 });
    const bonus = await promo.bonuses.claim(op.id, userId, code);
    expect(bonus.status).toBe('ACTIVE');
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'USD', userId)).toBe(2_000n);

    // 4. Hub: bet + win firmados (la apuesta contribuye al jackpot y lo dispara; también suma wagering).
    const session = await launchHub(created, token, 'USD');
    const roundId = `r-${randomUUID()}`;
    const bet = await hubWallet(created, 'bet', { sessionToken: session, transactionId: `b-${randomUUID()}`, roundId, amount: '1000' });
    expect(bet.status, JSON.stringify(bet.body)).toBe(200);
    const win = await hubWallet(created, 'win', { sessionToken: session, transactionId: `w-${randomUUID()}`, roundId, amount: '500' });
    expect(win.status, JSON.stringify(win.body)).toBe(200);
    await created.services.bus.drain();
    expect(await waitFor(() => ledgerCount(op.id, 'JACKPOT_PAYOUT'), (n) => n >= 1)).toBe(1);

    // 5. Studios: rondas de nymfo-dice con la billetera real (completan el wagering del bono).
    for (let i = 0; i < 2; i++) {
      const play = await api.post('/studio/v1/play/nymfo-dice').set(bearer(token)).send({ amount: '1000', currency: 'USD', params: { target: 50, over: true } });
      expect(play.status, JSON.stringify(play.body)).toBe(200);
      expect(play.body.round.status).toBe('SETTLED');
      await created.services.bus.drain();
    }
    const done = await waitFor(() => promo.bonuses.getBonus(bonus.id), (b) => b?.status === 'COMPLETED');
    expect(done?.status).toBe('COMPLETED');
    expect(await ledgerCount(op.id, 'BONUS_CONVERT')).toBe(1);
    expect(await accountBalance(op.id, 'PLAYER_BONUS', 'USD', userId)).toBe(0n);

    // 6. KYC → retiro → aprobación → pagado.
    const admin = await createBackofficeUser('OPERATOR_ADMIN', op.id);
    const finance = await createBackofficeUser('OPERATOR_FINANCE', op.id);
    const loginBo = async (u: { email: string }) => {
      const r = await api.post('/api/backoffice/auth/login').send({ email: u.email, password: TEST_PASSWORD });
      expect(r.status).toBe(200);
      return bearer(r.body.accessToken);
    };
    const adminH = await loginBo(admin);
    const financeH = await loginBo(finance);
    expect((await api.put(`/api/backoffice/players/${userId}/kyc`).set(adminH).send({ status: 'VERIFIED' })).status).toBe(200);

    const beforeWd = await cash();
    const WD = 50_000n;
    const wd = await api.post('/api/cashier/withdrawals').set(auth).send({ provider: 'WOMPI', amount: WD.toString(), currency: 'USD', destination: { account: '1234567890' } });
    expect(wd.status, JSON.stringify(wd.body)).toBe(201);
    expect((await api.post(`/api/backoffice/withdrawals/${wd.body.id}/approve`).set(financeH)).status).toBe(200);
    const paid = await api.post(`/api/backoffice/withdrawals/${wd.body.id}/mark-paid`).set(financeH);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(await cash()).toBe(beforeWd - WD);
    await created.services.bus.drain();

    // 7. Ledger: todo suma 0, están todos los tipos esperados y la reconciliación da 0 discrepancias.
    const byType = await assertOperatorLedgerBalanced(op.id);
    // Con mustDropBy = semilla + 1 cada apuesta (Hub y Studios) contribuye, dispara y re-siembra: 3 pagos.
    expect(byType).toMatchObject({ DEPOSIT: 1, BONUS_GRANT: 1, BET: 3, JACKPOT_PAYOUT: 3, BONUS_CONVERT: 1 });
    expect(byType.JACKPOT_CONTRIBUTION).toBe(1 + 3 + 3); // semilla inicial + 3 contribuciones + 3 re-siembras
    const pool = await accountBalance(op.id, 'JACKPOT_POOL', 'USD');
    expect(pool).toBe(1_000n);
    const rec = await api.get(`/api/backoffice/reconciliation?operatorId=${op.id}`).set(financeH);
    expect(rec.status).toBe(200);
    expect(rec.body.totalDiscrepancies).toBe(0);
    await expectReconciled(created, op.id);
  }, 90_000);
});
