import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { MockAuth, devToken } from '../../shared/adapters/MockAuth';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { silentLogger, type ModuleDeps } from '../../shared/module';
import { createCrm, ruleSchema } from '../index';
import { churnRiskOf, buildRfmScorer, vipScoreOf } from '../domain/rfm';
import { newProfile } from '../domain/projection';

const OP = 'op-1';
let now = new Date('2026-03-31T12:00:00Z');
const clock = () => now;
const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

function setup() {
  const bus = new InMemoryEventBus();
  const compliance = new InMemoryPlayerCompliance();
  const deps: ModuleDeps = {
    wallet: new InMemoryWallet(), bus, auth: new MockAuth({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), compliance,
    logger: silentLogger, env: {}, services: {},
  };
  const crm = createCrm(deps, { clock });
  crm.profiles.subscribe(bus);
  return { bus, compliance, crm };
}

const reg = (playerId: string, at: string, extra = {}) => ({ operatorId: OP, playerId, at, currency: 'COP', ...extra });

beforeEach(() => {
  now = new Date('2026-03-31T12:00:00Z');
});

describe('proyección del perfil 360', () => {
  it('agrega eventos: LTV, GGR, favoritos, atribución y dedupe', async () => {
    const { bus, crm } = setup();
    await bus.publish('player.registered', reg('p1', iso(20), { country: 'CO', utm: { source: 'fb' }, affiliateCode: 'AFF1' }));
    await bus.publish('deposit.completed', { operatorId: OP, playerId: 'p1', at: iso(19), amount: 10_000n, currency: 'COP', isFirst: true, txId: 't1' });
    const dep2 = { operatorId: OP, playerId: 'p1', at: iso(5), amount: 5_000n, currency: 'COP', isFirst: false, txId: 't2' };
    await bus.publish('deposit.completed', dep2);
    await bus.publish('deposit.completed', dep2); // duplicado
    await bus.publish('withdrawal.completed', { operatorId: OP, playerId: 'p1', at: iso(2), amount: 3_000n, currency: 'COP', txId: 'w1' });
    const bet = (roundId: string, gameId: string, category: string, amount: bigint) => ({ operatorId: OP, playerId: 'p1', at: iso(1), amount, currency: 'COP', gameId, provider: 'nymfo', category, roundId });
    await bus.publish('bet.placed', bet('r1', 'g-a', 'slots', 1_000n));
    await bus.publish('bet.placed', bet('r2', 'g-b', 'originals', 4_000n));
    await bus.publish('bet.placed', bet('r3', 'g-a', 'slots', 2_000n));
    await bus.publish('bet.settled', { ...bet('r1', 'g-a', 'slots', 1_000n), win: 2_500n, multiplier: 2.5 });
    await bus.publish('bet.settled', { ...bet('r1', 'g-a', 'slots', 1_000n), win: 2_500n, multiplier: 2.5 }); // duplicado
    await bus.publish('session.started', { operatorId: OP, playerId: 'p1', at: iso(1), sessionId: 's1' });
    await bus.publish('login', { operatorId: OP, playerId: 'p1', at: iso(0) });
    await bus.drain();
    expect(bus.errors).toEqual([]);

    const v = (await crm.profiles.getProfile(OP, 'p1'))!;
    expect(v.depositsTotal).toBe(15_000n);
    expect(v.depositsCount).toBe(2);
    expect(v.withdrawalsTotal).toBe(3_000n);
    expect(v.ltv).toBe(12_000n);
    expect(v.totalWagered).toBe(7_000n);
    expect(v.totalWon).toBe(2_500n);
    expect(v.ggr).toBe(4_500n);
    expect(v.firstDepositAt).toBe(iso(19));
    expect(v.lastDepositAt).toBe(iso(5));
    expect(v.lastLoginAt).toBe(iso(0));
    expect(v.lastBetAt).toBe(iso(1));
    expect(v.favoriteGames.map((f) => f.id)).toEqual(['g-b', 'g-a']);
    expect(v.favoriteCategories[0]).toEqual({ id: 'originals', wagered: 4_000n });
    expect(v.affiliateCode).toBe('AFF1');
    expect(v.utm?.source).toBe('fb');
    expect(v.activeDays30).toBe(6);
    const tl = await crm.timeline.list(OP, 'p1');
    expect(tl.filter((t) => t.type === 'deposit')).toHaveLength(2);
  });

  it('adjunta cumplimiento bajo demanda', async () => {
    const { bus, compliance, crm } = setup();
    await bus.publish('login', { operatorId: OP, playerId: 'p1', at: iso(0) });
    compliance.set(OP, 'p1', { selfExcluded: true });
    const v = await crm.profiles.getProfile(OP, 'p1', { compliance: true });
    expect(v?.compliance?.selfExcluded).toBe(true);
  });
});

describe('RFM y riesgo de abandono', () => {
  it('casos borde del riesgo', () => {
    expect(churnRiskOf(null, { r: 1, f: 1 })).toBe('high');
    expect(churnRiskOf(0, { r: 5, f: 5 })).toBe('low');
    expect(churnRiskOf(3, { r: 1, f: 1 })).toBe('medium'); // nunca high en la primera semana
    expect(churnRiskOf(10, { r: 5, f: 5 })).toBe('low');
    expect(churnRiskOf(20, { r: 4, f: 4 })).toBe('medium');
    expect(churnRiskOf(30, { r: 3, f: 3 })).toBe('medium');
    expect(churnRiskOf(45, { r: 2, f: 5 })).toBe('high');
  });

  it('quintiles por operador y valor VIP', () => {
    const mk = (id: string, daysAgo: number, wagered: bigint, days: number) => {
      const p = newProfile(OP, id, iso(0));
      p.lastActivityAt = iso(daysAgo);
      p.totalWagered = wagered;
      p.activeDays = Array.from({ length: days }, (_, i) => iso(i).slice(0, 10));
      return p;
    };
    const pop = [mk('a', 0, 1_000_000n, 20), mk('b', 5, 100n, 3), mk('c', 15, 50n, 1), mk('d', 40, 10n, 1), mk('e', 90, 0n, 0), mk('z', 200, 0n, 0)];
    const s = buildRfmScorer(pop, now);
    const top = s.score(pop[0]);
    expect(top).toEqual({ r: 5, f: 5, m: 5 });
    expect(vipScoreOf(top)).toBe(100);
    const dead = s.score(pop[5]);
    expect(dead.m).toBe(1);
    expect(dead.f).toBe(1);
    expect(dead.r).toBe(1);
    expect(vipScoreOf(dead)).toBe(0);
    // población vacía de actividad: todos quintil 1 en M
    const empty = buildRfmScorer([newProfile(OP, 'x', iso(0))], now).score(newProfile(OP, 'x', iso(0)));
    expect(empty).toEqual({ r: 1, f: 1, m: 1 });
  });
});

describe('segmentación', () => {
  async function seed() {
    const s = setup();
    const { bus } = s;
    await bus.publish('player.registered', reg('co-rich', iso(60), { country: 'CO' }));
    await bus.publish('player.registered', reg('co-poor', iso(3), { country: 'CO' }));
    await bus.publish('player.registered', reg('mx', iso(40), { country: 'MX' }));
    for (const [p, amt, at] of [['co-rich', 500_000n, 2], ['co-poor', 1_000n, 3], ['mx', 900_000n, 35]] as const) {
      await bus.publish('deposit.completed', { operatorId: OP, playerId: p, at: iso(at), amount: amt, currency: 'COP', isFirst: true, txId: `d-${p}` });
    }
    await bus.publish('login', { operatorId: OP, playerId: 'co-rich', at: iso(1) });
    await bus.publish('login', { operatorId: OP, playerId: 'mx', at: iso(35) });
    await bus.drain();
    return s;
  }

  it('AND/OR anidados, within_days y older_than_days', async () => {
    const { crm } = await seed();
    const rule = ruleSchema.parse({
      all: [
        { field: 'country', op: 'eq', value: 'CO' },
        { any: [{ field: 'totalDeposits', op: 'gte', value: 100000 }, { field: 'lastLoginAt', op: 'within_days', value: 7 }] },
      ],
    });
    const seg = await crm.segments.create(OP, { name: 'CO activos', rule });
    expect(await crm.segments.listPlayers(OP, seg.id)).toEqual(['co-rich']);
    expect(await crm.segments.isMember(OP, seg.id, 'co-rich')).toBe(true);
    expect(await crm.segments.isMember(OP, seg.id, 'mx')).toBe(false);

    const old = await crm.segments.preview(OP, { field: 'lastLoginAt', op: 'older_than_days', value: 30 });
    expect(old).toEqual({ count: 1, sample: ['mx'] });
    const reg7 = await crm.segments.preview(OP, { field: 'registeredAt', op: 'within_days', value: 7 });
    expect(reg7.sample).toEqual(['co-poor']);
    const noLogin = await crm.segments.preview(OP, { field: 'lastLoginAt', op: 'exists', value: false });
    expect(noLogin.sample).toEqual(['co-poor']);
    const either = await crm.segments.preview(OP, { any: [{ field: 'country', op: 'eq', value: 'MX' }, { field: 'ltv', op: 'lt', value: 5000 }] });
    expect(either.count).toBe(2);
    expect((await crm.segments.preview('otro-op', rule)).count).toBe(0);
  });

  it('valida el DSL', () => {
    expect(ruleSchema.safeParse({ field: 'x', op: 'bogus', value: 1 }).success).toBe(false);
    expect(ruleSchema.safeParse({ field: 'x', op: 'in', value: 1 }).success).toBe(false);
    expect(ruleSchema.safeParse({ field: 'x', op: 'within_days', value: 'a' }).success).toBe(false);
    expect(ruleSchema.safeParse({}).success).toBe(false);
  });
});

describe('HTTP: aislamiento por operador', () => {
  let server: Server;
  let base = '';
  afterEach(() => new Promise<void>((r) => server?.close(() => r())));

  async function boot() {
    const s = await (async () => {
      const x = setup();
      await x.bus.publish('login', { operatorId: 'op-A', playerId: 'pa', at: iso(0) });
      await x.bus.publish('login', { operatorId: 'op-B', playerId: 'pb', at: iso(0) });
      await x.bus.drain();
      return x;
    })();
    const app = express();
    app.use('/crm/v1', express.json(), s.crm.router);
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/crm/v1`;
    return s;
  }
  const call = (path: string, token: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

  it('un admin no ve jugadores de otro operador', async () => {
    await boot();
    const adminA = devToken('OPERATOR_ADMIN', 'op-A', 'u1');
    const list = await (await call('/admin/players', adminA)).json();
    expect(list.items.map((i: { playerId: string }) => i.playerId)).toEqual(['pa']);
    expect((await call('/admin/players/pb', adminA)).status).toBe(404);
    expect((await call('/admin/players?operatorId=op-B', adminA)).status).toBe(403);
    expect((await call('/admin/players/pa', adminA)).status).toBe(200);
    expect((await call('/admin/players', devToken('PLAYER', 'op-A', 'pa'))).status).toBe(403);
    expect((await call('/admin/players', 'basura')).status).toBe(401);
    const root = await call('/admin/players?operatorId=op-B', devToken('PLATFORM_ADMIN', '*', 'root'));
    expect((await root.json()).items[0].playerId).toBe('pb');
  });

  it('notas, etiquetas, segmentos y tickets por HTTP', async () => {
    await boot();
    const a = devToken('OPERATOR_AGENT', 'op-A', 'ag1');
    expect((await call('/admin/players/pa/notes', a, { method: 'POST', body: JSON.stringify({ text: 'VIP potencial' }) })).status).toBe(201);
    const tags = await (await call('/admin/players/pa/tags', a, { method: 'POST', body: JSON.stringify({ tag: 'vip' }) })).json();
    expect(tags.tags).toEqual(['vip']);
    const seg = await (await call('/admin/segments', a, { method: 'POST', body: JSON.stringify({ name: 'vips', rule: { field: 'tags', op: 'contains', value: 'vip' } }) })).json();
    const members = await (await call(`/admin/segments/${seg.id}/members`, a)).json();
    expect(members.total).toBe(1);
    expect((await call('/admin/segments/preview', a, { method: 'POST', body: JSON.stringify({ rule: { field: 'x', op: 'nope' } }) })).status).toBe(400);
    expect((await call(`/admin/segments/${seg.id}`, devToken('OPERATOR_ADMIN', 'op-B', 'u2'))).status).toBe(404);

    const player = devToken('PLAYER', 'op-A', 'pa');
    const t = await (await call('/tickets', player, { method: 'POST', body: JSON.stringify({ subject: 'Retiro lento', message: 'Hola' }) })).json();
    expect((await (await call('/tickets/mine', player)).json()).items).toHaveLength(1);
    const replied = await (await call(`/admin/tickets/${t.id}/messages`, a, { method: 'POST', body: JSON.stringify({ text: 'Lo revisamos' }) })).json();
    expect(replied.status).toBe('pending');
    const closed = await (await call(`/admin/tickets/${t.id}`, a, { method: 'PATCH', body: JSON.stringify({ status: 'closed', assignedTo: 'ag1' }) })).json();
    expect(closed.status).toBe('closed');
    expect((await call(`/admin/tickets/${t.id}`, devToken('OPERATOR_ADMIN', 'op-B', 'u2'))).status).toBe(404);
    const detail = await (await call('/admin/players/pa', a)).json();
    expect(detail.timeline.map((x: { type: string }) => x.type)).toEqual(expect.arrayContaining(['note', 'tag', 'ticket']));
  });
});
