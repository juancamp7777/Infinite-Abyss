import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { JwtService } from '../../src/infrastructure/auth/JwtService';
import { Phase1ModuleAuth } from '../../src/infrastructure/modules/auth/Phase1ModuleAuth';
import { Phase1BetGuard, Phase1PlayerCompliance } from '../../src/infrastructure/modules/compliance/Phase1Compliance';
import { ResponsibleGamingPolicy } from '../../src/application/responsible-gaming/ResponsibleGamingPolicy';
import { signHmacSha256 } from '../../src/modules/shared/crypto/hmac';
import type { DomainEvents } from '../../src/modules/shared/events/EventBus';
import { createBackofficeUser, createTestOperator, createTestPlayer, TEST_PASSWORD, type TestOperator } from '../setup/factories';

/** Secreto HMAC de PRUEBA del mock-provider del Hub (no es un secreto real). */
const HUB_TEST_SECRET = 'test-only-hub-mock-provider-secret-0123456789';

let created: CreatedApp;
let opA: TestOperator;
let opB: TestOperator;
const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET!, accessTtl: '15m' });

beforeAll(async () => {
  created = createApp(getConfig(), {
    bcryptCost: 4,
    rateLimit: { disabled: true },
    moduleEnv: {
      HUB_PROVIDER_MOCK_PROVIDER_SECRET: HUB_TEST_SECRET,
      MKT_SCHEDULER: 'off',
      STUDIO_CRASH_LIVE: 'false',
      PROMO_TICK_INTERVAL_MS: '0',
    },
  });
  await created.ready;
  opA = await createTestOperator();
  opB = await createTestOperator();
});

afterAll(async () => {
  await created.close();
});

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('cableado de módulos en createApp', () => {
  it('monta las rutas de los módulos y publica sus servicios', async () => {
    const mods = created.services.modules;
    for (const key of ['hub.catalog', 'promotions', 'crm.crmSegments', 'marketing', 'gamification.service', 'backoffice.dashboard', 'feed.service']) {
      expect(mods[key], key).toBeDefined();
    }
    expect(mods['wallet.bonusFunds']).toBeDefined();
    expect(mods['wallet.jackpotLedger']).toBeDefined();
    // Las rutas existen (401 y no 404).
    for (const path of ['/crm/v1/tickets/mine', '/crm/v1/admin/players', '/marketing/v1/admin/me']) {
      const res = await request(created.app).get(path);
      expect(res.status, path).toBe(401);
    }
    // El 404 de la Fase 1 sigue funcionando detrás del router de módulos.
    expect((await request(created.app).get('/no-existe')).status).toBe(404);
  });

  it('rechaza tokens inválidos y tokens dev: en el servidor real', async () => {
    const player = await createTestPlayer(opA.id);
    for (const token of ['basura', `dev:PLAYER:${opA.id}:${player.id}`, `dev:PLATFORM_ADMIN:x:y`]) {
      const res = await request(created.app).get('/crm/v1/tickets/mine').set(bearer(token));
      expect(res.status, token).toBe(401);
    }
  });

  it('acepta el JWT real de jugador (login de la Fase 1) en rutas de jugador', async () => {
    const player = await createTestPlayer(opA.id);
    const login = await request(created.app)
      .post('/api/auth/login')
      .set('X-Operator-Slug', opA.slug)
      .send({ email: player.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const res = await request(created.app).get('/crm/v1/tickets/mine').set(bearer(login.body.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    // Un jugador no entra al admin (403 por rol).
    const admin = await request(created.app).get('/crm/v1/admin/players').set(bearer(login.body.accessToken));
    expect(admin.status).toBe(403);
  });

  it('jugador suspendido o token de otro operador → 401', async () => {
    const suspended = await createTestPlayer(opA.id, { status: 'SUSPENDED' });
    const t1 = jwt.signAccess({ sub: suspended.id, op: opA.id, typ: 'player' });
    expect((await request(created.app).get('/crm/v1/tickets/mine').set(bearer(t1))).status).toBe(401);
    const p = await createTestPlayer(opA.id);
    const forged = jwt.signAccess({ sub: p.id, op: opB.id, typ: 'player' });
    expect((await request(created.app).get('/crm/v1/tickets/mine').set(bearer(forged))).status).toBe(401);
  });

  it('JWT de backoffice: tenant del token, aislamiento entre operadores y PLATFORM_ADMIN global', async () => {
    const adminA = await createBackofficeUser('OPERATOR_ADMIN', opA.id);
    const login = await request(created.app)
      .post('/api/backoffice/auth/login')
      .send({ email: adminA.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    expect((await request(created.app).get('/crm/v1/admin/players').set(bearer(token))).status).toBe(200);
    // Pedir otro operador por parámetro → 403 (el tenant sale del token).
    const cross = await request(created.app).get(`/crm/v1/admin/players?operatorId=${opB.id}`).set(bearer(token));
    expect(cross.status).toBe(403);

    const support = await createBackofficeUser('OPERATOR_SUPPORT', opA.id);
    const supportLogin = await request(created.app)
      .post('/api/backoffice/auth/login')
      .send({ email: support.email, password: TEST_PASSWORD });
    // SUPPORT se mapea a OPERATOR_AGENT: puede ver jugadores de su operador.
    expect((await request(created.app).get('/crm/v1/admin/players').set(bearer(supportLogin.body.accessToken))).status).toBe(200);

    const root = await createBackofficeUser('PLATFORM_ADMIN', null);
    const rootLogin = await request(created.app)
      .post('/api/backoffice/auth/login')
      .send({ email: root.email, password: TEST_PASSWORD });
    const rootRes = await request(created.app)
      .get(`/crm/v1/admin/players?operatorId=${opB.id}`)
      .set(bearer(rootLogin.body.accessToken));
    expect(rootRes.status).toBe(200);
  });

  it('el HMAC de /hub/v1/wallet se verifica sobre el cuerpo crudo', async () => {
    // Espacios y orden propios del proveedor: JSON.stringify(req.body) NO reproduce estos bytes.
    const raw = '{ "sessionToken" : "no-existe-0000000000",  "currency":"USD" }';
    const goodSig = signHmacSha256(HUB_TEST_SECRET, raw);
    const ok = await request(created.app)
      .post('/hub/v1/wallet/balance')
      .set('Content-Type', 'application/json')
      .set('X-Provider-Id', 'mock-provider')
      .set('X-Signature', goodSig)
      .send(raw);
    // La firma pasa; falla después por sesión inexistente.
    expect(JSON.stringify(ok.body)).not.toContain('INVALID_SIGNATURE');
    expect(ok.status).not.toBe(200);

    const reSig = signHmacSha256(HUB_TEST_SECRET, JSON.stringify(JSON.parse(raw)));
    const bad = await request(created.app)
      .post('/hub/v1/wallet/balance')
      .set('Content-Type', 'application/json')
      .set('X-Provider-Id', 'mock-provider')
      .set('X-Signature', reSig)
      .send(raw);
    expect(JSON.stringify(bad.body)).toContain('INVALID_SIGNATURE');
  });

  it('player.registered, login y session.started llegan al bus tras /api/auth/register', async () => {
    const seen: Array<{ name: string; payload: { playerId: string; operatorId: string } }> = [];
    const offs = (['player.registered', 'login', 'session.started'] as const).map((name) =>
      created.services.bus.subscribe(name, (p: DomainEvents[typeof name]) => {
        seen.push({ name, payload: p });
      }),
    );
    const email = `reg-${randomUUID().slice(0, 8)}@test.local`;
    const res = await request(created.app)
      .post('/api/auth/register')
      .set('X-Operator-Slug', opA.slug)
      .send({ email, password: TEST_PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await created.services.bus.drain();
    offs.forEach((off) => off());
    const user = await prisma.user.findFirstOrThrow({ where: { operatorId: opA.id, emailNormalized: email } });
    const names = seen.filter((e) => e.payload.playerId === user.id).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['player.registered', 'login', 'session.started']));
    expect(seen.find((e) => e.name === 'player.registered')!.payload.operatorId).toBe(opA.id);
  });

  it('feed: bet.settled del bus real llega al feed público con alias y sin el id del jugador', async () => {
    const player = await createTestPlayer(opA.id);
    const other = await createTestPlayer(opA.id);
    const roundId = randomUUID();
    await created.services.bus.publish('bet.settled', {
      operatorId: opA.id, playerId: player.id, at: new Date().toISOString(), amount: 500n, win: 6000n, currency: 'USD',
      gameId: 'feed-wiring-game', provider: 'studio', category: 'originals', roundId, multiplier: 12,
    });
    await created.services.bus.drain();

    const pub = await request(created.app).get(`/feed/v1/bets?operatorId=${opA.id}&kind=lucky`);
    expect(pub.status).toBe(200);
    const bet = pub.body.bets.find((b: { id: string }) => b.id === `studio:${roundId}`);
    expect(bet).toMatchObject({ amount: '500', win: '6000', multiplier: 12, currency: 'USD', isMe: false });
    expect(bet.player).toMatch(/^Jugador·[2-9A-Z]{6}$/);
    expect(JSON.stringify(pub.body)).not.toContain(player.id);

    // Otro operador no ve la apuesta.
    const foreign = await request(created.app).get(`/feed/v1/bets?operatorId=${opB.id}`);
    expect(foreign.body.bets.some((b: { id: string }) => b.id === `studio:${roundId}`)).toBe(false);

    // El dueño la ve marcada como suya; otro jugador del mismo operador no.
    const mineTok = jwt.signAccess({ sub: player.id, op: opA.id, typ: 'player' });
    const own = await request(created.app).get('/feed/v1/bets?kind=lucky').set(bearer(mineTok));
    expect(own.body.bets.find((b: { id: string }) => b.id === `studio:${roundId}`).isMe).toBe(true);
    const mine = await request(created.app).get('/feed/v1/bets/mine').set(bearer(mineTok));
    expect(mine.body.bets.map((b: { id: string }) => b.id)).toContain(`studio:${roundId}`);
    const otherTok = jwt.signAccess({ sub: other.id, op: opA.id, typ: 'player' });
    const notOwn = await request(created.app).get('/feed/v1/bets?kind=lucky').set(bearer(otherTok));
    expect(notOwn.body.bets.find((b: { id: string }) => b.id === `studio:${roundId}`).isMe).toBe(false);
    // Un jugador no puede leer el feed de otro operador.
    expect((await request(created.app).get(`/feed/v1/bets?operatorId=${opB.id}`).set(bearer(mineTok))).status).toBe(403);
  });
});

describe('compliance y betGuard sobre juego responsable de la Fase 1', () => {
  it('autoexcluido: selfExcluded=true y no puede apostar; activo sí', async () => {
    const compliance = new Phase1PlayerCompliance(prisma);
    const guard = new Phase1BetGuard(prisma, new ResponsibleGamingPolicy(prisma));
    const ok = await createTestPlayer(opA.id, { kycStatus: 'VERIFIED' });
    const excluded = await createTestPlayer(opA.id);
    await prisma.responsibleGamingSettings.create({
      data: { userId: excluded.id, operatorId: opA.id, selfExclusionPermanent: true },
    } as never);

    const sOk = await compliance.getStatus(opA.id, ok.id);
    expect(sOk).toMatchObject({ selfExcluded: false, ageVerified: true });
    expect((await compliance.getStatus(opA.id, excluded.id)).selfExcluded).toBe(true);
    // Otro operador o inexistente: fail-closed.
    expect((await compliance.getStatus(opB.id, ok.id)).selfExcluded).toBe(true);
    expect((await compliance.getStatus(opA.id, randomUUID())).selfExcluded).toBe(true);

    const bet = { operatorId: opA.id, currency: 'USD', amount: 100n, gameId: 'g', category: 'slots' };
    expect(await guard.checkBet({ ...bet, playerId: ok.id })).toEqual({ allowed: true });
    const denied = await guard.checkBet({ ...bet, playerId: excluded.id });
    expect(denied.allowed).toBe(false);
    expect((await guard.checkBet({ ...bet, operatorId: opB.id, playerId: ok.id })).allowed).toBe(false);
  });

  it('Phase1ModuleAuth mapea roles de backoffice y rechaza dev:', async () => {
    const auth = new Phase1ModuleAuth(jwt, prisma);
    expect(await auth.verify('dev:PLATFORM_ADMIN:x:y')).toBeNull();
    const fin = await createBackofficeUser('OPERATOR_FINANCE', opA.id);
    const t = jwt.signAccess({ sub: fin.id, op: opA.id, typ: 'backoffice', role: 'OPERATOR_FINANCE' });
    expect(await auth.verify(t)).toEqual({ userId: fin.id, role: 'OPERATOR_AGENT', operatorId: opA.id });
  });
});
