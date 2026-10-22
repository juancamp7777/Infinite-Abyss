import request from 'supertest';
import jwtLib from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator, createTestPlayer, TEST_PASSWORD } from '../setup/factories';
import { buildApp } from './helpers';

const { app, jwt } = buildApp();
const PW = 'Correct-Horse-9';

const reg = (slug: string, email: string, password = PW) =>
  request(app).post('/api/auth/register').set('X-Operator-Slug', slug).send({ email, password });

describe('registro y login', () => {
  it('registra, hace login y /api/me devuelve el jugador', async () => {
    const op = await createTestOperator({ defaultCurrency: 'COP', currencies: ['COP'] });
    const email = `ana-${op.slug}@mail.test`;
    const r = await reg(op.slug, email);
    expect(r.status).toBe(201);
    expect(r.body.user.currency).toBe('COP');
    expect(r.body.user.operatorId).toBe(op.id);
    expect(r.body.user.passwordHash).toBeUndefined();

    const l = await request(app).post('/api/auth/login').set('X-Operator-Slug', op.slug).send({ email: email.toUpperCase(), password: PW });
    expect(l.status).toBe(200);
    const me = await request(app).get('/api/me').set('X-Operator-Slug', op.slug).set('Authorization', `Bearer ${l.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.balances.cash).toBe('0');
    const sessions = await prisma.playerSession.count({ where: { userId: r.body.user.id } });
    expect(sessions).toBe(1); // login reutiliza la sesión abierta
  });

  it('rechaza contraseñas cortas con 422', async () => {
    const op = await createTestOperator();
    const r = await reg(op.slug, 'x@mail.test', 'short');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('contraseña errónea y usuario inexistente dan el mismo 401 genérico', async () => {
    const op = await createTestOperator();
    await reg(op.slug, `a-${op.slug}@mail.test`);
    const bad = await request(app).post('/api/auth/login').set('X-Operator-Slug', op.slug).send({ email: `a-${op.slug}@mail.test`, password: 'Wrong-Password-1' });
    const none = await request(app).post('/api/auth/login').set('X-Operator-Slug', op.slug).send({ email: 'nadie@mail.test', password: 'Wrong-Password-1' });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body).toEqual(none.body);
  });

  it('mismo email en dos operadores OK; duplicado en el mismo → 409', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    const email = `dup-${a.slug}@mail.test`;
    expect((await reg(a.slug, email)).status).toBe(201);
    expect((await reg(b.slug, email)).status).toBe(201);
    expect((await reg(a.slug, email.toUpperCase())).status).toBe(409);
  });
});

describe('refresh tokens', () => {
  it('rota en cada uso y detecta reutilización revocando la cadena', async () => {
    const op = await createTestOperator();
    const r1 = await reg(op.slug, `rt-${op.slug}@mail.test`);
    const t1 = r1.body.refreshToken as string;
    const refresh = (t: string) => request(app).post('/api/auth/refresh').set('X-Operator-Slug', op.slug).send({ refreshToken: t });

    const r2 = await refresh(t1);
    expect(r2.status).toBe(200);
    const t2 = r2.body.refreshToken as string;
    expect(t2).not.toBe(t1);

    // Reutilizar t1 (ya rotado) → 401 y t2 queda revocado.
    expect((await refresh(t1)).status).toBe(401);
    expect((await refresh(t2)).status).toBe(401);
    const active = await prisma.refreshToken.count({ where: { userId: r1.body.user.id, revokedAt: null } });
    expect(active).toBe(0);
  });

  it('refresh concurrente: solo uno rota', async () => {
    const op = await createTestOperator();
    const r1 = await reg(op.slug, `cc-${op.slug}@mail.test`);
    const t = r1.body.refreshToken as string;
    const res = await Promise.all(
      [1, 2].map(() => request(app).post('/api/auth/refresh').set('X-Operator-Slug', op.slug).send({ refreshToken: t })),
    );
    expect(res.filter((x) => x.status === 200).length).toBe(1);
  });

  it('logout revoca el token y el token de otro operador es 403', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    const r = await reg(a.slug, `lo-${a.slug}@mail.test`);
    const cross = await request(app).post('/api/auth/refresh').set('X-Operator-Slug', b.slug).send({ refreshToken: r.body.refreshToken });
    expect(cross.status).toBe(403);
    const out = await request(app).post('/api/auth/logout').set('X-Operator-Slug', a.slug).send({ refreshToken: r.body.refreshToken });
    expect(out.status).toBe(204);
    const again = await request(app).post('/api/auth/refresh').set('X-Operator-Slug', a.slug).send({ refreshToken: r.body.refreshToken });
    expect(again.status).toBe(401);
  });
});

describe('aislamiento entre operadores y validación de JWT', () => {
  it('token de jugador de A contra tenant B → 403', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    const r = await reg(a.slug, `iso-${a.slug}@mail.test`);
    const auth = `Bearer ${r.body.accessToken}`;
    expect((await request(app).get('/test/player-ping').set('X-Operator-Slug', a.slug).set('Authorization', auth)).status).toBe(200);
    expect((await request(app).get('/test/player-ping').set('X-Operator-Slug', b.slug).set('Authorization', auth)).status).toBe(403);
  });

  it('OPERATOR_ADMIN de A no accede a B; PLATFORM_ADMIN sí', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    const adminA = await createBackofficeUser('OPERATOR_ADMIN', a.id, { password: PW });
    const platform = await createBackofficeUser('PLATFORM_ADMIN', null, { password: PW });
    const login = async (email: string) =>
      (await request(app).post('/api/backoffice/auth/login').send({ email, password: PW })).body.accessToken as string;
    const tA = await login(adminA.email);
    const tP = await login(platform.email);

    expect((await request(app).get(`/test/operators/${a.id}/ping`).set('Authorization', `Bearer ${tA}`)).status).toBe(200);
    expect((await request(app).get(`/test/operators/${b.id}/ping`).set('Authorization', `Bearer ${tA}`)).status).toBe(403);
    expect((await request(app).get(`/test/operators/${b.id}/ping`).set('Authorization', `Bearer ${tP}`)).status).toBe(200);
    // Con tenant B resuelto, el admin de A tampoco pasa (enforceTenant).
    const player = await createTestPlayer(b.id);
    const kyc = await request(app).put(`/api/backoffice/players/${player.id}/kyc`).set('Authorization', `Bearer ${tA}`).send({ status: 'VERIFIED' });
    expect(kyc.status).toBe(403);
    const kycP = await request(app).put(`/api/backoffice/players/${player.id}/kyc`).set('Authorization', `Bearer ${tP}`).send({ status: 'VERIFIED', reason: 'docs ok' });
    expect(kycP.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { targetId: player.id, action: 'player.kyc.review' } })).toBe(1);
  });

  it('un token de jugador no sirve en backoffice y el rol insuficiente es 403', async () => {
    const op = await createTestOperator();
    const r = await reg(op.slug, `x-${op.slug}@mail.test`);
    const res = await request(app).get(`/test/operators/${op.id}/ping`).set('Authorization', `Bearer ${r.body.accessToken}`);
    expect(res.status).toBe(401);
    const fin = await createBackofficeUser('OPERATOR_FINANCE', op.id, { password: TEST_PASSWORD });
    const t = jwt.signAccess({ sub: fin.id, op: op.id, typ: 'backoffice', role: 'OPERATOR_FINANCE' });
    expect((await request(app).get(`/test/operators/${op.id}/ping`).set('Authorization', `Bearer ${t}`)).status).toBe(403);
  });

  it('JWT alg none o firma alterada → 401', async () => {
    const op = await createTestOperator();
    const r = await reg(op.slug, `j-${op.slug}@mail.test`);
    const [h, p, s] = (r.body.accessToken as string).split('.');
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`;
    const tampered = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    const wrongKey = jwtLib.sign({ sub: r.body.user.id, op: op.id, typ: 'player' }, 'another-secret-another-secret-123456', { algorithm: 'HS256' });
    const hs512 = jwtLib.sign({ sub: r.body.user.id, op: op.id, typ: 'player' }, process.env.JWT_ACCESS_SECRET!, { algorithm: 'HS512' });
    for (const t of [none, tampered, wrongKey, hs512]) {
      const res = await request(app).get('/test/player-ping').set('X-Operator-Slug', op.slug).set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(401);
    }
  });
});

describe('rate limit de login', () => {
  it('devuelve 429 tras superar el umbral', async () => {
    const limited = buildApp({ rateLimit: { loginMax: 3, loginWindowMs: 60_000 } }).app;
    const op = await createTestOperator();
    const attempt = () =>
      request(limited).post('/api/auth/login').set('X-Operator-Slug', op.slug).send({ email: `rl-${op.slug}@mail.test`, password: 'Wrong-Password-1' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await attempt()).status);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
