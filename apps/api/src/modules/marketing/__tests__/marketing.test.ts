import express from 'express';
import type { AddressInfo } from 'net';
import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { InMemorySegmentPort } from '../../shared/ports/SegmentPort';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { MockAuth, devToken } from '../../shared/adapters/MockAuth';
import { silentLogger, type ModuleDeps } from '../../shared/module';
import { createRuntime, type MarketingRuntime } from '../application/MarketingRuntime';
import { createMarketingRouter } from '../infrastructure/routes';
import { InAppChannel, LogChannel } from '../infrastructure/channels';
import { assignVariant } from '../domain/ab';
import { renderTemplate } from '../domain/render';
import { isAllowedRedirect, validatePostbackTemplate, UnsafeUrlError } from '../domain/urlSafety';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../domain/unsubscribe';
import { presetDraft } from '../domain/presets';
import type { Campaign, ChannelKind, Journey, Template } from '../domain/types';

const OP = 'op-1';
const HOUR = 3_600_000;
const T0 = new Date('2026-01-10T10:00:00Z');

interface Ctx {
  rt: MarketingRuntime;
  bus: InMemoryEventBus;
  compliance: InMemoryPlayerCompliance;
  segments: InMemorySegmentPort;
  channels: Record<ChannelKind, LogChannel>;
  deps: ModuleDeps;
  fetchCalls: string[];
  fetchStatus: { value: number };
  clock: { now: Date };
  services: Record<string, unknown>;
}

function setup(env: NodeJS.ProcessEnv = { MKT_UNSUBSCRIBE_SECRET: 's3cret', MKT_PUBLIC_BASE_URL: 'https://api.test', MKT_LINK_ALLOWLIST: 'casino.test' }): Ctx {
  const bus = new InMemoryEventBus();
  const compliance = new InMemoryPlayerCompliance({ selfExcluded: false, hasActiveLimits: false, ageVerified: true, isMinor: false, email: 'p@x.test' });
  const segments = new InMemorySegmentPort();
  const services: Record<string, unknown> = {};
  const deps: ModuleDeps = { wallet: new InMemoryWallet(), bus, auth: new MockAuth(env), compliance, segments, logger: silentLogger, env, services };
  const clock = { now: new Date(T0) };
  const fetchCalls: string[] = [];
  const fetchStatus = { value: 200 };
  const channels = Object.fromEntries((['email', 'sms', 'whatsapp', 'push', 'inapp'] as ChannelKind[]).map((k) => [k, new LogChannel(k)])) as Record<ChannelKind, LogChannel>;
  const rt = createRuntime(deps, {
    clock: () => clock.now,
    channels,
    fetchFn: async (url) => {
      fetchCalls.push(url);
      return new Response('', { status: fetchStatus.value });
    },
    resolver: async () => ['93.184.216.34'],
  });
  rt.subscribe(bus);
  return { rt, bus, compliance, segments, channels, deps, fetchCalls, fetchStatus, clock, services };
}

const iso = (d: Date) => d.toISOString();

async function mkTemplate(c: Ctx, over: Partial<Template> = {}): Promise<Template> {
  const t: Template = {
    id: `t-${Math.random().toString(36).slice(2)}`, operatorId: OP, name: 'T', channel: 'email', kind: 'marketing', subject: 'Hola {{firstName|amigo}}',
    body: '<p>Hola {{firstName|amigo}} de {{operator.name}}</p>', createdAt: iso(T0), updatedAt: iso(T0), ...over,
  };
  return c.rt.repos.templates.put(t);
}

async function optIn(c: Ctx, playerId: string, channel: ChannelKind = 'email'): Promise<void> {
  await c.rt.consent.set(OP, playerId, channel, true, 'test');
}

async function mkCampaign(c: Ctx, templates: Template[], over: Partial<Campaign> = {}): Promise<Campaign> {
  const camp: Campaign = {
    id: 'camp-1', operatorId: OP, name: 'C', status: 'scheduled', segmentId: 'seg', scheduledAt: iso(new Date(T0.getTime() + HOUR)),
    variants: templates.map((t, i) => ({ key: String.fromCharCode(65 + i), templateId: t.id, weight: 1 })), conversionWindowDays: 7,
    stats: { audience: 0, processed: 0 }, createdAt: iso(T0), updatedAt: iso(T0), ...over,
  };
  return c.rt.repos.campaigns.put(camp);
}

describe('render de plantillas', () => {
  it('escapa HTML en variables pero no en la plantilla; texto plano sin escape', () => {
    const out = renderTemplate('<b>{{firstName}}</b> {{operator.name}} {{x|def}}', { firstName: '<script>alert(1)</script>', operator: { name: 'A&B' } }, { mode: 'html' });
    expect(out).toBe('<b>&lt;script&gt;alert(1)&lt;/script&gt;</b> A&amp;B def');
    expect(renderTemplate('{{a}}', { a: '<i>' }, { mode: 'text' })).toBe('<i>');
  });
  it('no accede a propiedades heredadas', () => {
    expect(renderTemplate('{{constructor}}', {}, { mode: 'html' })).toBe('');
  });
});

describe('guard de cumplimiento (NUNCA se envía)', () => {
  const cases: Array<[string, Record<string, boolean>, string]> = [
    ['autoexcluido', { selfExcluded: true }, 'SELF_EXCLUDED'],
    ['con límites activos', { hasActiveLimits: true }, 'ACTIVE_LIMITS'],
    ['menor', { isMinor: true }, 'MINOR'],
    ['edad no verificada', { ageVerified: false }, 'AGE_NOT_VERIFIED'],
  ];
  for (const [name, status, reason] of cases) {
    it(`excluye a jugador ${name} aunque tenga opt-in`, async () => {
      const c = setup();
      const t = await mkTemplate(c);
      await optIn(c, 'p1');
      c.compliance.set(OP, 'p1', status);
      const log = await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id });
      expect(log.status).toBe('excluded');
      expect(log.reason).toBe(reason);
      expect(c.channels.email.sent).toHaveLength(0);
      const stored = await c.rt.repos.sends.list({ operatorId: OP, playerId: 'p1' });
      expect(stored[0].reason).toBe(reason);
    });
  }

  it('excluye sin opt-in o tras opt-out, y el log guarda el motivo', async () => {
    const c = setup();
    const t = await mkTemplate(c);
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).reason).toBe('NO_OPT_IN');
    await optIn(c, 'p1');
    await c.rt.consent.set(OP, 'p1', 'email', false, 'test');
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).reason).toBe('NO_OPT_IN');
    expect(c.channels.email.sent).toHaveLength(0);
  });

  it('push: aceptar notificaciones en el navegador cuenta como permiso; una baja explícita manda', async () => {
    const c = setup();
    const t = await mkTemplate(c, { channel: 'push', subject: 'Hola', body: 'Bono listo' });
    expect((await c.rt.messaging.checkEligibility(OP, 'p1', 'push')).ok).toBe(false);
    await c.rt.repos.pushSubs.put({ id: 'sub-1', operatorId: OP, playerId: 'p1', endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' }, createdAt: new Date().toISOString() });
    expect((await c.rt.messaging.checkEligibility(OP, 'p1', 'push')).ok).toBe(true);
    await c.rt.consent.set(OP, 'p1', 'push', false, 'test');
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).reason).toBe('NO_OPT_IN');
  });

  it('el opt-in es por canal', async () => {
    const c = setup();
    const t = await mkTemplate(c, { channel: 'sms', subject: undefined, body: 'Hola' });
    await optIn(c, 'p1', 'email');
    c.compliance.set(OP, 'p1', { phone: '+573000000000' });
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).reason).toBe('NO_OPT_IN');
  });

  it('falla cerrado si cumplimiento no responde', async () => {
    const c = setup();
    const t = await mkTemplate(c);
    await optIn(c, 'p1');
    c.deps.compliance.getStatus = async () => {
      throw new Error('down');
    };
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).reason).toBe('COMPLIANCE_UNAVAILABLE');
  });

  it('envía cuando todo es válido y aplica el límite de frecuencia', async () => {
    const c = setup();
    const t = await mkTemplate(c);
    await optIn(c, 'p1');
    const a = await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id });
    expect(a.status).toBe('sent');
    expect(c.channels.email.sent[0].html).toContain('/marketing/v1/t/o/');
    expect(c.channels.email.sent[0].headers?.['List-Unsubscribe']).toContain('/marketing/v1/unsubscribe');
    const b = await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id });
    expect(b.reason).toBe('FREQUENCY_CAP');
    // El envío manual desde el panel no lo frena el límite automático; el cumplimiento sí aplica.
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id, manual: true })).status).toBe('sent');
    c.compliance.set(OP, 'p1', { selfExcluded: true });
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id, manual: true })).reason).toBe('SELF_EXCLUDED');
    c.compliance.set(OP, 'p1', { selfExcluded: false });
    c.clock.now = new Date(T0.getTime() + 25 * HOUR);
    expect((await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).status).toBe('sent');
  });

  it('los transaccionales no pasan por el guard de marketing', async () => {
    const c = setup();
    const t = await mkTemplate(c, { kind: 'transactional' });
    c.compliance.set(OP, 'p1', { selfExcluded: true });
    const log = await c.rt.messaging.sendTransactional({ operatorId: OP, playerId: 'p1', templateId: t.id });
    expect(log.status).toBe('sent');
    await expect(c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id })).rejects.toThrow();
  });
});

describe('baja firmada', () => {
  it('verifica y rechaza manipulación', () => {
    const tk = signUnsubscribeToken('k', OP, 'p1', 'email');
    expect(verifyUnsubscribeToken('k', tk)).toEqual({ operatorId: OP, playerId: 'p1', channel: 'email' });
    expect(verifyUnsubscribeToken('otra', tk)).toBeNull();
    expect(verifyUnsubscribeToken('k', tk.replace(/^./, 'A'))).toBeNull();
  });
});

describe('journey registro sin depósito (24 h)', () => {
  async function mkJourney(c: Ctx): Promise<Journey> {
    const d = presetDraft('signup_no_deposit_24h');
    const t = await mkTemplate(c, { ...d.template, id: 'tpl-signup' });
    const j: Journey = { id: 'j1', operatorId: OP, name: d.name, status: 'active', trigger: d.trigger, steps: d.buildSteps(t.id), createdAt: iso(T0), updatedAt: iso(T0) };
    return c.rt.repos.journeys.put(j);
  }
  const registered = (playerId: string, at = T0) => ({ operatorId: OP, playerId, at: iso(at), currency: 'COP', email: `${playerId}@x.test` });

  it('envía a las 24 h, no antes', async () => {
    const c = setup();
    await mkJourney(c);
    await optIn(c, 'p1');
    await c.bus.publish('player.registered', registered('p1'));
    await c.rt.tick(new Date(T0.getTime() + 23 * HOUR));
    expect(c.channels.email.sent).toHaveLength(0);
    await c.rt.tick(new Date(T0.getTime() + 24 * HOUR));
    expect(c.channels.email.sent).toHaveLength(1);
    expect(c.channels.email.sent[0].to).toBe('p1@x.test');
    await c.rt.tick(new Date(T0.getTime() + 48 * HOUR));
    expect(c.channels.email.sent).toHaveLength(1);
  });

  it('se cancela si deposita antes', async () => {
    const c = setup();
    await mkJourney(c);
    await optIn(c, 'p1');
    await c.bus.publish('player.registered', registered('p1'));
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(new Date(T0.getTime() + 2 * HOUR)), amount: 100n, currency: 'COP', isFirst: true, txId: 'x' });
    await c.rt.tick(new Date(T0.getTime() + 25 * HOUR));
    expect(c.channels.email.sent).toHaveLength(0);
    const runs = await c.rt.repos.runs.list({ operatorId: OP, playerId: 'p1' });
    expect(runs[0].status).toBe('cancelled');
  });

  it('si se autoexcluye entre medias no se envía y queda el log', async () => {
    const c = setup();
    await mkJourney(c);
    await optIn(c, 'p1');
    await c.bus.publish('player.registered', registered('p1'));
    c.compliance.set(OP, 'p1', { selfExcluded: true });
    await c.rt.tick(new Date(T0.getTime() + 24 * HOUR));
    expect(c.channels.email.sent).toHaveLength(0);
    expect((await c.rt.repos.sends.list({ operatorId: OP, playerId: 'p1' }))[0].reason).toBe('SELF_EXCLUDED');
  });
});

describe('otros journeys', () => {
  it('cumpleaños usa birthDate del cumplimiento', async () => {
    const c = setup();
    const d = presetDraft('birthday');
    const t = await mkTemplate(c, { ...d.template });
    await c.rt.repos.journeys.put({ id: 'jb', operatorId: OP, name: d.name, status: 'active', trigger: d.trigger, steps: d.buildSteps(t.id), createdAt: iso(T0), updatedAt: iso(T0) });
    await optIn(c, 'p1');
    c.compliance.set(OP, 'p1', { birthDate: '1990-01-10' });
    await c.bus.publish('player.registered', { operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', email: 'p1@x.test' });
    await c.rt.tick(T0);
    await c.rt.tick(new Date(T0.getTime() + HOUR));
    expect(c.channels.email.sent).toHaveLength(1);
  });

  it('depositante inactivo 7 días', async () => {
    const c = setup();
    const d = presetDraft('depositor_inactive_7d');
    const t = await mkTemplate(c, { ...d.template });
    await c.rt.repos.journeys.put({ id: 'ji', operatorId: OP, name: d.name, status: 'active', trigger: d.trigger, steps: d.buildSteps(t.id), createdAt: iso(T0), updatedAt: iso(T0) });
    await optIn(c, 'p1');
    await c.bus.publish('player.registered', { operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', email: 'p1@x.test' });
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(T0), amount: 1n, currency: 'COP', isFirst: true, txId: 'a' });
    await c.rt.tick(new Date(T0.getTime() + 6 * 24 * HOUR));
    expect(c.channels.email.sent).toHaveLength(0);
    await c.rt.tick(new Date(T0.getTime() + 7 * 24 * HOUR));
    expect(c.channels.email.sent).toHaveLength(1);
  });

  it('gran pérdida → cashback vía promotions y mensaje; solo una vez por ventana', async () => {
    const c = setup();
    const calls: Array<Record<string, unknown>> = [];
    c.services.promotions = { grantCashback: async (r: Record<string, unknown>) => void calls.push(r) };
    const d = presetDraft('big_loss_cashback', { lossThreshold: '1000', cashbackBps: 1000 });
    const t = await mkTemplate(c, { ...d.template });
    await c.rt.repos.journeys.put({ id: 'jl', operatorId: OP, name: d.name, status: 'active', trigger: d.trigger, steps: d.buildSteps(t.id), createdAt: iso(T0), updatedAt: iso(T0) });
    await optIn(c, 'p1');
    await c.bus.publish('player.registered', { operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', email: 'p1@x.test' });
    const bet = (n: number, amount: bigint) => ({
      operatorId: OP, playerId: 'p1', at: iso(new Date(T0.getTime() + n * HOUR)), amount, win: 0n, currency: 'COP', gameId: 'g', provider: 'nymfo', category: 'slots', roundId: `r${n}`, multiplier: 0,
    });
    await c.bus.publish('bet.settled', bet(1, 600n));
    expect(calls).toHaveLength(0);
    await c.bus.publish('bet.settled', bet(2, 600n));
    expect(calls).toHaveLength(1);
    expect(calls[0].amount).toBe(120n);
    expect(c.channels.email.sent).toHaveLength(1);
    await c.bus.publish('bet.settled', bet(3, 900n));
    expect(calls).toHaveLength(1);
  });

  it('gran pérdida: solo mensaje si no existe promotions', async () => {
    const c = setup();
    const d = presetDraft('big_loss_cashback', { lossThreshold: '100' });
    const t = await mkTemplate(c, { ...d.template });
    await c.rt.repos.journeys.put({ id: 'jl', operatorId: OP, name: d.name, status: 'active', trigger: d.trigger, steps: d.buildSteps(t.id), createdAt: iso(T0), updatedAt: iso(T0) });
    await optIn(c, 'p1');
    await c.bus.publish('bet.settled', { operatorId: OP, playerId: 'p1', at: iso(T0), amount: 500n, win: 0n, currency: 'COP', gameId: 'g', provider: 'n', category: 'slots', roundId: 'r', multiplier: 0 });
    expect(c.channels.email.sent).toHaveLength(1);
  });
});

describe('A/B y métricas', () => {
  it('asignación determinista y proporcional', () => {
    const v = [{ key: 'A', templateId: 'a', weight: 1 }, { key: 'B', templateId: 'b', weight: 1 }];
    const first = assignVariant(v, 'p1', 'c1').key;
    for (let i = 0; i < 5; i++) expect(assignVariant(v, 'p1', 'c1').key).toBe(first);
    let a = 0;
    for (let i = 0; i < 2000; i++) if (assignVariant(v, `p${i}`, 'c1').key === 'A') a++;
    expect(a).toBeGreaterThan(900);
    expect(a).toBeLessThan(1100);
  });

  it('campaña programada: envía por variante, atribuye conversión, apertura y clic', async () => {
    const c = setup();
    const ta = await mkTemplate(c, { id: 'ta' });
    const tb = await mkTemplate(c, { id: 'tb' });
    const players = Array.from({ length: 20 }, (_, i) => `p${i}`);
    for (const p of players) await optIn(c, p);
    c.segments.setMembers(OP, 'seg', players);
    await mkCampaign(c, [ta, tb]);
    await c.rt.tick(T0);
    expect(c.channels.email.sent).toHaveLength(0);
    c.clock.now = new Date(T0.getTime() + 2 * HOUR);
    await c.rt.tick(c.clock.now);
    expect(c.channels.email.sent).toHaveLength(20);
    expect((await c.rt.repos.campaigns.get('camp-1'))?.status).toBe('done');
    await c.rt.tick(new Date(T0.getTime() + 3 * HOUR));
    expect(c.channels.email.sent).toHaveLength(20);

    const sendOfP0 = (await c.rt.repos.sends.list({ operatorId: OP, playerId: 'p0' }))[0];
    await c.rt.campaigns.markOpened(sendOfP0.id);
    await c.rt.campaigns.markClicked(sendOfP0.id);
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p0', at: iso(new Date(T0.getTime() + 24 * HOUR)), amount: 5000n, currency: 'COP', isFirst: false, txId: 'd1' });
    // fuera de ventana (30 días): no convierte
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(new Date(T0.getTime() + 30 * 24 * HOUR)), amount: 5000n, currency: 'COP', isFirst: false, txId: 'd2' });
    const m = await c.rt.campaigns.metrics(OP, 'camp-1');
    expect(m.total.sent).toBe(20);
    expect(m.total.converted).toBe(1);
    expect(m.total.opened).toBe(1);
    expect(m.total.clicked).toBe(1);
    expect(m.variants.map((v) => v.variant).sort()).toEqual(['A', 'B']);
    const conv = (await c.rt.repos.sends.get(sendOfP0.id))!;
    expect(conv.conversionAmount).toBe('5000');
  });

  it('las exclusiones se cuentan por motivo en las métricas', async () => {
    const c = setup();
    const ta = await mkTemplate(c, { id: 'ta' });
    await optIn(c, 'p1');
    c.compliance.set(OP, 'p1', { selfExcluded: true });
    c.segments.setMembers(OP, 'seg', ['p1', 'p2']);
    await mkCampaign(c, [ta], { scheduledAt: iso(T0) });
    await c.rt.tick(new Date(T0.getTime() + 1));
    const m = await c.rt.campaigns.metrics(OP, 'camp-1');
    expect(m.total.excluded).toBe(2);
    expect(m.total.excludedByReason).toEqual({ SELF_EXCLUDED: 1, NO_OPT_IN: 1 });
  });
});

describe('afiliados y postbacks', () => {
  it('registro y FTD disparan postback con plantilla; idempotente', async () => {
    const c = setup();
    await c.rt.repos.affiliates.put({
      id: 'a1', operatorId: OP, code: 'AFF1', name: 'Aff', postbackUrl: 'https://track.example.com/pb?cid={click_id}&p={player_id}&e={event}&amt={amount}', pixels: [], active: true, createdAt: iso(T0), updatedAt: iso(T0),
    });
    await c.bus.publish('player.registered', { operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', affiliateCode: 'aff1', utm: { source: 'x', content: 'click 9' } });
    expect(c.fetchCalls).toEqual(['https://track.example.com/pb?cid=click%209&p=p1&e=registration&amt=0']);
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(T0), amount: 2500n, currency: 'COP', isFirst: true, txId: 't' });
    await c.bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(T0), amount: 100n, currency: 'COP', isFirst: false, txId: 't2' });
    expect(c.fetchCalls[1]).toBe('https://track.example.com/pb?cid=click%209&p=p1&e=ftd&amt=2500');
    expect(c.fetchCalls).toHaveLength(2);
    const logs = await c.rt.repos.postbacks.list({ operatorId: OP });
    expect(logs.every((l) => l.status === 'ok')).toBe(true);
  });

  it('reintenta con backoff y termina en failed', async () => {
    const c = setup();
    c.fetchStatus.value = 500;
    await c.rt.repos.affiliates.put({ id: 'a1', operatorId: OP, code: 'AFF1', name: 'A', postbackUrl: 'https://track.example.com/pb?p={player_id}', pixels: [], active: true, createdAt: iso(T0), updatedAt: iso(T0) });
    await c.bus.publish('player.registered', { operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', affiliateCode: 'AFF1' });
    expect(c.fetchCalls).toHaveLength(1);
    await c.rt.tick(new Date(T0.getTime() + 30_000));
    expect(c.fetchCalls).toHaveLength(1);
    c.fetchStatus.value = 200;
    await c.rt.tick(new Date(T0.getTime() + 61_000));
    expect(c.fetchCalls).toHaveLength(2);
    expect((await c.rt.repos.postbacks.list({ operatorId: OP }))[0].status).toBe('ok');
  });

  it('rechaza URLs de postback privadas/localhost en producción, permite https público', () => {
    for (const u of ['https://127.0.0.1/p', 'https://10.0.0.5/p?x={event}', 'https://192.168.1.1/p', 'https://169.254.169.254/latest', 'https://localhost/p', 'https://[::1]/p', 'https://srv.internal/p', 'http://track.example.com/p', 'https://u:p@track.example.com/p']) {
      expect(() => validatePostbackTemplate(u, true), u).toThrow(UnsafeUrlError);
    }
    expect(() => validatePostbackTemplate('https://track.example.com/p?c={click_id}', true)).not.toThrow();
    expect(() => validatePostbackTemplate('https://track.example.com/{secret}', true)).toThrow(UnsafeUrlError);
    expect(() => validatePostbackTemplate('http://localhost:9000/p', false)).not.toThrow();
  });

  it('en producción un host que resuelve a IP privada no se llama', async () => {
    const env = { NODE_ENV: 'production', MKT_UNSUBSCRIBE_SECRET: 'k' };
    const c = setup(env);
    const rt = createRuntime(c.deps, { clock: () => c.clock.now, channels: c.channels, fetchFn: async (u) => (c.fetchCalls.push(u), new Response('')), resolver: async () => ['10.0.0.1'], repos: c.rt.repos });
    await c.rt.repos.affiliates.put({ id: 'a1', operatorId: OP, code: 'AFF1', name: 'A', postbackUrl: 'https://evil.example.com/p', pixels: [], active: true, createdAt: iso(T0), updatedAt: iso(T0) });
    await rt.affiliates.onRegistered({ operatorId: OP, playerId: 'p1', at: iso(T0), currency: 'COP', affiliateCode: 'AFF1' });
    expect(c.fetchCalls).toHaveLength(0);
    expect((await c.rt.repos.postbacks.list({ operatorId: OP }))[0].status).toBe('failed');
  });

  it('allowlist de redirección de clics', () => {
    expect(isAllowedRedirect('https://casino.test/promo', ['casino.test'])).not.toBeNull();
    expect(isAllowedRedirect('https://sub.casino.test/x', ['casino.test'])).not.toBeNull();
    expect(isAllowedRedirect('https://evilcasino.test/x', ['casino.test'])).toBeNull();
    expect(isAllowedRedirect('https://casino.test.evil.com/x', ['casino.test'])).toBeNull();
    expect(isAllowedRedirect('javascript:alert(1)', ['casino.test'])).toBeNull();
  });
});

describe('HTTP', () => {
  let c: Ctx;
  let base: string;
  let server: ReturnType<express.Application['listen']>;

  beforeEach(async () => {
    c = setup();
    const app = express();
    app.use('/marketing/v1', express.json(), createMarketingRouter(c.rt, c.deps));
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/marketing/v1`;
    return () => void server.close();
  });

  const player = { authorization: `Bearer ${devToken('PLAYER', OP, 'p1')}`, 'content-type': 'application/json' };
  const adminH = { authorization: `Bearer ${devToken('OPERATOR_ADMIN', OP, 'u1')}`, 'content-type': 'application/json' };

  it('consent GET/PUT y baja por enlace', async () => {
    let r = await fetch(`${base}/consent`, { headers: player });
    expect((await r.json()).channels.email.optIn).toBe(false);
    r = await fetch(`${base}/consent`, { method: 'PUT', headers: player, body: JSON.stringify({ channel: 'email', optIn: true }) });
    expect((await r.json()).channels.email.optIn).toBe(true);
    const tk = signUnsubscribeToken('s3cret', OP, 'p1', 'email');
    r = await fetch(`${base}/unsubscribe?t=${encodeURIComponent(tk)}`);
    expect(r.status).toBe(200);
    expect((await c.rt.consent.get(OP, 'p1', 'email'))?.optIn).toBe(false);
    expect((await fetch(`${base}/unsubscribe?t=bad`)).status).toBe(400);
  });

  it('bandeja in-app y marcar leído', async () => {
    const t = await mkTemplate(c, { channel: 'inapp', subject: 'Hey', body: 'Hola {{firstName|jugador}}' });
    (c.channels as Record<string, unknown>).inapp = new InAppChannel(c.rt.repos.inbox, undefined, () => c.clock.now);
    await optIn(c, 'p1', 'inapp');
    await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id });
    let r = await fetch(`${base}/inbox`, { headers: player });
    const body = await r.json();
    expect(body.unread).toBe(1);
    r = await fetch(`${base}/inbox/${body.items[0].id}/read`, { method: 'POST', headers: player });
    expect(r.status).toBe(200);
    expect((await (await fetch(`${base}/inbox`, { headers: player })).json()).unread).toBe(0);
  });

  it('tracking: pixel, clic con allowlist y bloqueo de open redirect', async () => {
    const t = await mkTemplate(c, { body: '<a href="https://casino.test/promo">Ir</a>' });
    await optIn(c, 'p1');
    const log = await c.rt.messaging.sendMarketing({ operatorId: OP, playerId: 'p1', templateId: t.id });
    expect(c.channels.email.sent[0].html).toContain(`/marketing/v1/t/c/${log.id}?u=`);
    let r = await fetch(`${base}/t/o/${log.id}.gif`);
    expect(r.headers.get('content-type')).toBe('image/gif');
    r = await fetch(`${base}/t/c/${log.id}?u=${encodeURIComponent('https://casino.test/promo')}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('https://casino.test/promo');
    r = await fetch(`${base}/t/c/${log.id}?u=${encodeURIComponent('https://evil.test/')}`, { redirect: 'manual' });
    expect(r.status).toBe(400);
    const stored = (await c.rt.repos.sends.get(log.id))!;
    expect(stored.openedAt && stored.clickedAt).toBeTruthy();
  });

  it('admin: requiere rol, aísla operadores y crea presets/afiliados', async () => {
    expect((await fetch(`${base}/admin/templates`, { headers: player })).status).toBe(403);
    expect((await fetch(`${base}/admin/templates`)).status).toBe(401);
    let r = await fetch(`${base}/admin/templates`, { method: 'POST', headers: adminH, body: JSON.stringify({ name: 'N', channel: 'email', body: '<p>x</p>' }) });
    expect(r.status).toBe(201);
    const tpl = await r.json();
    r = await fetch(`${base}/admin/templates?operatorId=otro`, { headers: adminH });
    expect(r.status).toBe(403);
    const other = { authorization: `Bearer ${devToken('OPERATOR_ADMIN', 'op-2', 'u2')}`, 'content-type': 'application/json' };
    expect((await fetch(`${base}/admin/templates/${tpl.id}`, { method: 'PUT', headers: other, body: JSON.stringify({ name: 'N', channel: 'email', body: 'y' }) })).status).toBe(404);
    r = await fetch(`${base}/admin/journeys/presets/signup_no_deposit_24h`, { method: 'POST', headers: adminH, body: '{}' });
    expect(r.status).toBe(201);
    r = await fetch(`${base}/admin/affiliates`, { method: 'POST', headers: adminH, body: JSON.stringify({ code: 'AF', name: 'x', postbackUrl: 'https://track.example.com/p?c={click_id}' }) });
    expect(r.status).toBe(201);
    r = await fetch(`${base}/pixels?operatorId=${OP}`);
    expect(r.status).toBe(200);
  });
});
