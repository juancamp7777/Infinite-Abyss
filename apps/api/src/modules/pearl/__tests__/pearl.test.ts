import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { ExternalDepositError, type ExternalDepositPort, type ExternalDepositRequest } from '../../shared/ports/ExternalDepositPort';
import { PearlService, type PearlOutcome } from '../application/PearlService';
import { parseFeedPayload } from '../domain/feeds';
import { isOwnAccount, isWalletOrOwnName, matchBankTx, parseAmountToMinor, sameHolder } from '../domain/matching';
import { createPearlModule } from '../index';
import { InMemoryPearlRepository } from '../infrastructure/InMemoryPearlRepository';

const OP = 'op-pearl';

describe('reglas deterministas', () => {
  it('montos en formatos locales', () => {
    expect(parseAmountToMinor('12.345,67', 2)).toBe(1234567n);
    expect(parseAmountToMinor('$ 12,345.67', 2)).toBe(1234567n);
    expect(parseAmountToMinor('12.345', 2)).toBe(1234500n);
    expect(parseAmountToMinor('5000', 2)).toBe(500000n);
    expect(parseAmountToMinor('0', 2)).toBeNull();
    expect(parseAmountToMinor('-10', 2)).toBeNull();
    expect(parseAmountToMinor('abc', 2)).toBeNull();
  });

  it('mismo titular', () => {
    expect(sameHolder('Juan Pérez', 'PEREZ JUAN')).toBe(true);
    expect(sameHolder('Juan Carlos Pérez', 'Juan Pérez')).toBe(true);
    expect(sameHolder('Juan Carlos Perez', 'Juan Carlo Perez')).toBe(true);
    expect(sameHolder('Juan Pérez', 'Ana Pérez')).toBe(false);
    expect(sameHolder('Pérez', 'Juan Pérez')).toBe(false);
    expect(sameHolder('', 'Juan')).toBe(false);
  });

  it('cuentas propias y nombres prohibidos', () => {
    const accounts = [{ accountNumber: '0000003100012345678901', alias: 'casino.abyss.mp' }];
    expect(isOwnAccount('0000003100012345678901', accounts)).toBe(true);
    expect(isOwnAccount('...678901', accounts)).toBe(true);
    expect(isOwnAccount('CASINO.ABYSS.MP', accounts)).toBe(true);
    expect(isOwnAccount('0000003100099999999999', accounts)).toBe(false);
    expect(isWalletOrOwnName('Mercado Pago', [])).toBe(true);
    expect(isWalletOrOwnName('Abyss Gaming SRL', ['Abyss Gaming SRL'])).toBe(true);
    expect(isWalletOrOwnName('Juan Pérez', ['Abyss Gaming SRL'])).toBe(false);
  });

  it('conciliación: único, ninguno, ambiguo y desempate por hora', () => {
    const at = new Date('2026-10-23T15:00:00Z');
    const t = (id: string, amount: bigint, name: string, mins: number) => ({ id, amount, senderName: name, occurredAt: new Date(at.getTime() + mins * 60_000) });
    expect(matchBankTx({ amount: 1000n, names: ['Juan Pérez'], at }, [t('a', 1000n, 'PEREZ JUAN', 2), t('b', 999n, 'Juan Perez', 1)])).toMatchObject({ kind: 'unique', tx: { id: 'a' } });
    expect(matchBankTx({ amount: 1000n, names: ['Juan Pérez'], at }, [t('a', 1000n, 'Ana Gomez', 0)])).toEqual({ kind: 'none' });
    expect(matchBankTx({ amount: 1000n, names: ['Juan Pérez'], at }, [t('a', 1000n, 'Juan Perez', 30), t('b', 1000n, 'Juan Perez', 5)])).toMatchObject({ kind: 'unique', tx: { id: 'b' } });
    expect(matchBankTx({ amount: 1000n, names: ['Juan Pérez'], at }, [t('a', 1000n, 'Juan Perez', 5), t('b', 1000n, 'Juan Perez', -5)]).kind).toBe('ambiguous');
    expect(matchBankTx({ amount: 1000n, names: ['Otro', 'Juan Pérez'] }, [t('a', 1000n, 'juan perez', 0)]).kind).toBe('unique');
  });

  it('feeds: Quikipay, HG Cash (ignora salientes) y genérico', () => {
    const q = parseFeedPayload('quikipay', { coelsa_id: 'C1', monto: '15000.50', status: 'APROBADA', origen: { titular: 'Juan Perez', cuit: '20-1', cvu: '000111' }, cvu: { cvu: '000999' } }, 2, -180);
    expect(q[0]).toMatchObject({ externalId: 'C1', amount: 1500050n, senderName: 'Juan Perez', receiverAccount: '000999', usable: true });
    const h = parseFeedPayload('hgcash', [{ id: 'H1', amount: '2000', direction: 'Inbound', fromName: 'Ana', date: '2026-10-23T12:00:00', timezone: 'America/Argentina/Buenos_Aires' }, { id: 'H2', amount: '50', direction: 'Outbound' }], 2, -180);
    expect(h.map((x) => [x.externalId, x.usable])).toEqual([['H1', true], ['H2', false]]);
    expect(h[0].occurredAt.toISOString()).toBe('2026-10-23T15:00:00.000Z');
    expect(parseFeedPayload('generic', { id: 'G1', amount: 'x' }, 2, 0)).toEqual([]);
  });
});

/** Servicio con repositorio en memoria, depósitos falsos (idempotentes por referencia) y reloj controlable. */
function setup(mode: 'auto' | 'review_all' = 'auto') {
  let now = new Date('2026-10-23T15:00:00Z');
  const credited = new Map<string, ExternalDepositRequest>();
  let failNext: Error | null = null;
  const deposits: ExternalDepositPort = {
    async credit(req) {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      const dup = credited.has(req.reference);
      credited.set(req.reference, req);
      return { depositId: `dep-${req.reference}`, txId: `tx-${req.reference}`, duplicate: dup };
    },
  };
  const repo = new InMemoryPearlRepository();
  const pearl = new PearlService(repo, { deposits, logger: silentLogger, defaultCurrency: 'ARS', now: () => now });
  const outcomes: PearlOutcome[] = [];
  pearl.setNotifier(async (_r, o) => { outcomes.push(o); });
  const ready = (async () => {
    await pearl.updateSettings(OP, { mode, autoMaxAmount: 50_000_00n, minAmount: 1_000_00n });
    await pearl.saveAccount(OP, { holderName: 'Abyss Gaming SRL', alias: 'abyss.casino', accountNumber: '0000003100012345678901' });
    return pearl.createFeed(OP, 'generic', 'Banco');
  })();
  const pay = async (id: string, amount: string, name: string, minsAgo = 2) => {
    const { feed, token } = await ready;
    return pearl.ingest(feed.id, token, { id, amount, senderName: name, occurredAt: new Date(now.getTime() - minsAgo * 60_000).toISOString() });
  };
  const receipt = (over: Partial<Parameters<PearlService['submit']>[0]['extracted']> = {}, extra: { playerId?: string; image?: Buffer } = { playerId: 'p1' }) =>
    pearl.submit({ operatorId: OP, conversationId: undefined, ...extra, source: 'ai', extracted: { amount: '10.000,00', date: '2026-10-23', time: '11:58', senderName: 'Juan Pérez', receiverAccount: '345678901', ...over } });
  return { pearl, repo, credited, outcomes, ready, pay, receipt, failOnce: (e: Error) => { failNext = e; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('Pearl: flujo de caja', () => {
  it('Cajero IA: cargas bajo el mínimo se suman dentro de la ventana; fuera de ella, no', async () => {
    const t = setup();
    const policy = { autoCredit: true, autoCreditMax: 0n, minDeposit: 1_000_000n, accumulateMinutes: 10, noChargeNow: false, pendingStage: 'deposit_review', noChargeMessage: '' };
    t.pearl.setPolicy(async () => policy);
    await t.pay('A1', '5000.00', 'PEREZ JUAN', 3);
    const first = await t.receipt({ amount: '5.000,00', time: '11:57' });
    expect(first).toMatchObject({ status: 'pending_review', reason: 'bajo_minimo_cajero_ia' });
    t.advance(4 * 60_000);
    await t.pay('A2', '5000.00', 'PEREZ JUAN', 1);
    const second = await t.receipt({ amount: '5.000,00', time: '12:03' });
    expect(second.status).toBe('credited');
    expect((await t.repo.findReceipt(OP, first.id))?.status).toBe('credited');
    expect(t.credited.size).toBe(2);

    // Pasados los 10 minutos ya no se suman: la nueva carga chica espera a una persona.
    await t.pay('B1', '4000.00', 'PEREZ JUAN', 1);
    const late1 = await t.receipt({ amount: '4.000,00', time: '12:06' });
    expect(late1.reason).toBe('bajo_minimo_cajero_ia');
    t.advance(15 * 60_000);
    await t.pay('B2', '6000.00', 'PEREZ JUAN', 1);
    const late2 = await t.receipt({ amount: '6.000,00', time: '12:21' });
    expect(late2).toMatchObject({ status: 'pending_review', reason: 'bajo_minimo_cajero_ia' });
    expect(t.credited.size).toBe(2);
  });

  it('Cajero IA: modo sin cargas y tope mandan a revisión aunque el pago cuadre', async () => {
    const t = setup();
    t.pearl.setPolicy(async () => ({ autoCredit: false, autoCreditMax: 0n, minDeposit: 0n, accumulateMinutes: 0, noChargeNow: true, pendingStage: 'deposit_review', noChargeMessage: '' }));
    await t.pay('N1', '10000.00', 'PEREZ JUAN');
    expect(await t.receipt()).toMatchObject({ status: 'pending_review', reason: 'modo_sin_cargas' });
    const u = setup();
    u.pearl.setPolicy(async () => ({ autoCredit: true, autoCreditMax: 500_000n, minDeposit: 0n, accumulateMinutes: 0, noChargeNow: false, pendingStage: 'deposit_review', noChargeMessage: '' }));
    await u.pay('N2', '10000.00', 'PEREZ JUAN');
    expect(await u.receipt()).toMatchObject({ status: 'pending_review', reason: 'supera_tope_cajero_ia' });
  });

  it('pago en el feed + comprobante → acredita sola, una sola vez', async () => {
    const t = setup();
    await t.pay('TX1', '10000.00', 'PEREZ JUAN');
    const r = await t.receipt({}, { playerId: 'p1', image: Buffer.from('img-1') });
    expect(r.status).toBe('credited');
    expect(t.credited.get(`pearl:${r.id}`)).toMatchObject({ amount: 1_000_000n, playerId: 'p1', currency: 'ARS' });
    expect((await t.repo.listBankTxs(OP, { limit: 5 }))[0]).toMatchObject({ status: 'used', receiptId: r.id });
    // Misma imagen otra vez, y mismo pago con otra captura: duplicados, sin segunda carga.
    expect((await t.receipt({}, { playerId: 'p1', image: Buffer.from('img-1') })).status).toBe('duplicate');
    expect((await t.receipt({}, { playerId: 'p1', image: Buffer.from('img-2') })).status).toBe('duplicate');
    expect(t.credited.size).toBe(1);
    expect(t.outcomes).toEqual(['credited', 'duplicate', 'duplicate']);
  });

  it('comprobante antes que el banco: espera y acredita al instante cuando llega el pago', async () => {
    const t = setup();
    await t.ready;
    const r = await t.receipt();
    expect(r.status).toBe('waiting_bank');
    await t.pay('TX2', '10000', 'Juan Perez');
    expect((await t.pearl.getReceipt(OP, r.id)).status).toBe('credited');
    expect(t.outcomes).toEqual(['waiting_bank', 'credited']);
  });

  it('si el pago no aparece, vencida la espera pasa a revisión humana', async () => {
    const t = setup();
    await t.ready;
    const r = await t.receipt();
    await t.pearl.tick();
    expect((await t.pearl.getReceipt(OP, r.id)).status).toBe('waiting_bank');
    t.advance(21 * 60_000);
    await t.pearl.tick();
    expect(await t.pearl.getReceipt(OP, r.id)).toMatchObject({ status: 'pending_review', reason: 'pago_no_encontrado' });
  });

  it('antifraude: pantalla previa, billetera como titular, cuenta ajena, edición y fecha vieja', async () => {
    const t = setup();
    await t.ready;
    expect(await t.receipt({ notAReceipt: true })).toMatchObject({ status: 'rejected', reason: 'no_es_comprobante' });
    expect(await t.receipt({ senderName: 'Mercado Pago', time: '11:01' })).toMatchObject({ status: 'needs_info' });
    expect(await t.receipt({ receiverAccount: '0000003100099999999999', time: '11:02' })).toMatchObject({ status: 'pending_review', reason: 'cuenta_destino' });
    expect(await t.receipt({ tamperSignals: ['tipografía del monto distinta'], time: '11:03' })).toMatchObject({ status: 'pending_review', reason: 'sin_edicion' });
    expect(await t.receipt({ date: '2026-10-01', time: '11:04' })).toMatchObject({ status: 'pending_review', reason: 'fecha_reciente' });
    expect(await t.receipt({ amount: '500', time: '11:05' })).toMatchObject({ status: 'pending_review', reason: 'monto_minimo' });
    expect(t.credited.size).toBe(0);
  });

  it('tope, jugador sin vincular, ambigüedad y juez → revisión humana', async () => {
    const t = setup();
    await t.pay('BIG', '60000', 'Juan Perez');
    expect(await t.receipt({ amount: '60000', time: '11:10' })).toMatchObject({ status: 'pending_review', reason: 'supera_tope_automatico' });
    await t.pay('NP', '2000', 'Juan Perez');
    expect(await t.receipt({ amount: '2000', time: '11:11' }, {})).toMatchObject({ status: 'pending_review', reason: 'sin_jugador_vinculado' });
    await t.pay('A1', '3000', 'Juan Perez', 3);
    await t.pay('A2', '3000', 'Juan Perez', 1);
    expect(await t.receipt({ amount: '3000', time: undefined })).toMatchObject({ status: 'pending_review', reason: 'varios_pagos_coinciden' });
    t.pearl.setJudge(async () => ({ approve: false, reason: 'el titular no coincide con el historial' }));
    await t.pay('J1', '4000', 'Juan Perez');
    expect((await t.receipt({ amount: '4000', time: '11:12' })).reason).toMatch(/^juez: el titular/);
    expect(t.credited.size).toBe(0);
  });

  it('revisión humana: aprobar con el pago sugerido, rechazar y no repetir', async () => {
    const t = setup('review_all');
    await t.pay('R1', '10000', 'Juan Perez');
    const r = await t.receipt();
    expect(r).toMatchObject({ status: 'pending_review', reason: 'modo_revision' });
    expect(r.bankTxId).toBeTruthy();
    const ok = await t.pearl.approve(OP, r.id, 'cajero-1');
    expect(ok).toMatchObject({ status: 'credited', reviewerId: 'cajero-1' });
    await expect(t.pearl.approve(OP, r.id, 'cajero-2')).rejects.toMatchObject({ status: 409 });
    const r2 = await t.receipt({ amount: '7000', time: '11:20' });
    expect((await t.pearl.reject(OP, r2.id, 'cajero-1', 'comprobante ilegible')).status).toBe('rejected');
    await expect(t.pearl.reject(OP, r2.id, 'cajero-1', 'otra vez')).rejects.toMatchObject({ status: 409 });
  });

  it('fallo del depósito (juego responsable) → revisión y el pago queda libre', async () => {
    const t = setup();
    await t.pay('RG', '10000', 'Juan Perez');
    t.failOnce(new ExternalDepositError('RG_BLOCKED', 'Autoexcluido'));
    const r = await t.receipt();
    expect(r).toMatchObject({ status: 'pending_review', reason: 'acreditacion: RG_BLOCKED' });
    expect((await t.repo.listBankTxs(OP, { limit: 5 }))[0].status).toBe('available');
  });

  it('webhook con token incorrecto o feed pausado → 404; reentregas no duplican', async () => {
    const t = setup();
    const { feed, token } = await t.ready;
    await expect(t.pearl.ingest(feed.id, 'x'.repeat(32), { id: 'Z', amount: '1', senderName: 'a' })).rejects.toMatchObject({ status: 404 });
    expect(await t.pearl.ingest(feed.id, token, { id: 'Z', amount: '10', senderName: 'a' })).toEqual({ received: 1, created: 1 });
    expect(await t.pearl.ingest(feed.id, token, { id: 'Z', amount: '10', senderName: 'a' })).toEqual({ received: 1, created: 0 });
    await t.pearl.setFeedEnabled(OP, feed.id, false);
    await expect(t.pearl.ingest(feed.id, token, { id: 'Y', amount: '10', senderName: 'a' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('API de Pearl', () => {
  let server: HttpServer;
  let base: string;
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');
  const agent = devToken('OPERATOR_AGENT', OP, 'cajero-1');
  const other = devToken('OPERATOR_ADMIN', 'op-otro', 'admin-2');
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    const deps: ModuleDeps = { wallet: new InMemoryWallet(), bus: new InMemoryEventBus(), auth: new MockAuth({ NODE_ENV: 'test' }), compliance: new InMemoryPlayerCompliance(), logger: silentLogger, env: {}, services: {} };
    await createPearlModule({ tickMs: 0 }).register(app, undefined, deps);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pearl/v1`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('roles, token mostrado una vez y aislamiento', async () => {
    expect((await call('GET', '/admin/settings', agent)).status).toBe(403);
    expect((await call('GET', '/admin/settings', admin)).body).toMatchObject({ mode: 'review_all', currency: 'ARS' });
    expect((await call('PUT', '/admin/settings', admin, { mode: 'auto', autoMaxAmount: '5000000' })).body).toMatchObject({ mode: 'auto', autoMaxAmount: '5000000' });
    const f = await call('POST', '/admin/feeds', admin, { type: 'hgcash', name: 'HG' });
    expect(f.status).toBe(201);
    expect(f.body.webhookPath).toBe(`/pearl/v1/feeds/${f.body.feed.id}/${f.body.token}`);
    const listed = await call('GET', '/admin/feeds', admin);
    expect(JSON.stringify(listed.body)).not.toMatch(/tokenHash|token"/);
    expect((await call('GET', '/admin/feeds', other)).body.items).toHaveLength(0);
    expect((await call('POST', f.body.webhookPath.replace('/pearl/v1', ''), undefined, { id: 'H9', amount: '1500', direction: 'Inbound', fromName: 'Ana Gomez' })).body).toMatchObject({ ok: true, created: 1 });
    expect((await call('GET', '/admin/bank-txs', agent)).body.items[0]).toMatchObject({ externalId: 'H9', amount: '150000', status: 'available' });
    const r = await call('POST', '/admin/receipts', agent, { extracted: { amount: '1500', senderName: 'Ana Gomez' } });
    expect(r.body).toMatchObject({ status: 'pending_review', reason: 'sin_jugador_vinculado' });
    expect((await call('GET', '/admin/receipts?status=pending_review', other)).body.items).toHaveLength(0);
  });
});
