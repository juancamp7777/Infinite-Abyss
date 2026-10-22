import { execSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { mergeLimits, parseExtraDomains, PLATFORM_ADMIN_EMAIL, runSeed } from '../../prisma/seedLib';
import { HUB_TEST_SECRET } from '../integration/helpers';

// El seed corre en un schema PROPIO de la BD de pruebas (las demás pruebas crean usuarios PLATFORM_ADMIN en el
// schema compartido, así que "exactamente uno" solo se puede afirmar aislado). Se borra al terminar.

const PASSWORD = 'Seed-Test-Passw0rd!'; // contraseña de PRUEBA, no real
const schema = `seed_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const baseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL!;
const url = (() => {
  const u = new URL(baseUrl);
  u.searchParams.set('schema', schema);
  return u.toString();
})();

let db: PrismaClient;
let created: CreatedApp;

beforeAll(async () => {
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  const opts = { password: PASSWORD, bcryptCost: 4, extraDomains: 'preview.example.com, aurora=AURORA-preview.example.com:8443' };
  await runSeed(db, opts);
  // Simula una base sembrada con la versión anterior (admin@nymfo.local como PLATFORM_ADMIN) y vuelve a sembrar.
  await db.backofficeUser.update({ where: { email: 'admin@nymfo.local' }, data: { role: 'PLATFORM_ADMIN', operatorId: null } });
  await db.operator.update({ where: { slug: 'nymfo' }, data: { limits: { maxDeposit: '999', betPresets: { USD: ['1'] } } } });
  await runSeed(db, opts);

  created = createApp(getConfig(), {
    prisma: db,
    bcryptCost: 4,
    rateLimit: { disabled: true },
    moduleEnv: { HUB_PROVIDER_MOCK_PROVIDER_SECRET: HUB_TEST_SECRET, MKT_SCHEDULER: 'off', STUDIO_CRASH_LIVE: 'false', PROMO_TICK_INTERVAL_MS: '0' },
  });
  await created.ready;
}, 180_000);

afterAll(async () => {
  await created?.close();
  await db?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
  await db?.$disconnect();
});

describe('seed: administradores', () => {
  it('existe exactamente un PLATFORM_ADMIN (platform@nymfo.local, sin operador) tras dos corridas', async () => {
    const admins = await db.backofficeUser.findMany({ where: { role: 'PLATFORM_ADMIN' } });
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ email: PLATFORM_ADMIN_EMAIL, operatorId: null, status: 'ACTIVE' });
  });

  it('admin@nymfo.local es OPERATOR_ADMIN del operador nymfo (también si venía como PLATFORM_ADMIN)', async () => {
    const nymfo = await db.operator.findUniqueOrThrow({ where: { slug: 'nymfo' } });
    const u = await db.backofficeUser.findUniqueOrThrow({ where: { email: 'admin@nymfo.local' } });
    expect(u).toMatchObject({ role: 'OPERATOR_ADMIN', operatorId: nymfo.id });
    const aurora = await db.operator.findUniqueOrThrow({ where: { slug: 'aurora' } });
    expect(await db.backofficeUser.findUniqueOrThrow({ where: { email: 'admin@aurora.local' } })).toMatchObject({ role: 'OPERATOR_ADMIN', operatorId: aurora.id });
    expect(await db.backofficeUser.findUniqueOrThrow({ where: { email: 'finance@nymfo.local' } })).toMatchObject({ role: 'OPERATOR_FINANCE' });
  });

  it('es idempotente: no duplica operadores, jugadores ni dominios', async () => {
    expect(await db.operator.count()).toBe(2);
    expect(await db.user.count()).toBe(2);
    expect(await db.backofficeUser.count()).toBe(5);
    const primaries = await db.operatorDomain.findMany({ where: { isPrimary: true }, select: { host: true } });
    expect(primaries.map((d) => d.host).sort()).toEqual(['demo.localhost', 'localhost']);
  });

  it('el PLATFORM_ADMIN entra al backoffice con vista de plataforma', async () => {
    const login = await request(created.app).post('/api/backoffice/auth/login').send({ email: PLATFORM_ADMIN_EMAIL, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'PLATFORM_ADMIN', operatorId: null });
    const dash = await request(created.app).get('/backoffice/v1/dashboard').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    // Sin filtrar por operador: alcance de plataforma.
    expect(dash.body.operatorId).toBeNull();
  });

  it('el admin del operador queda aislado a su operador', async () => {
    const nymfo = await db.operator.findUniqueOrThrow({ where: { slug: 'nymfo' } });
    const login = await request(created.app).post('/api/backoffice/auth/login').send({ email: 'admin@nymfo.local', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: 'OPERATOR_ADMIN', operatorId: nymfo.id });
    const dash = await request(created.app).get('/backoffice/v1/dashboard').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(dash.status).toBe(200);
    expect(dash.body.operatorId).toBe(nymfo.id);
  });

  it('se niega en producción', async () => {
    await expect(runSeed(db, { nodeEnv: 'production', password: PASSWORD })).rejects.toThrow(/production/);
  });
});

describe('seed: dominios extra y límites', () => {
  it('SEED_EXTRA_DOMAINS registra los hosts sin cambiar el primario', async () => {
    const nymfo = await db.operator.findUniqueOrThrow({ where: { slug: 'nymfo' } });
    const aurora = await db.operator.findUniqueOrThrow({ where: { slug: 'aurora' } });
    expect(await db.operatorDomain.findUniqueOrThrow({ where: { host: 'preview.example.com' } })).toMatchObject({ operatorId: nymfo.id, isPrimary: false });
    expect(await db.operatorDomain.findUniqueOrThrow({ where: { host: 'aurora-preview.example.com:8443' } })).toMatchObject({ operatorId: aurora.id, isPrimary: false });
    const r = await request(created.app).get('/api/operator/brand').set('X-Operator-Host', 'preview.example.com');
    expect(r.status).toBe(200);
    expect(r.body.operator.slug).toBe('nymfo');
  });

  it('parseExtraDomains: host, slug=host, URL y errores', () => {
    expect(parseExtraDomains('a.example, aurora=https://B.example:8443/x,,a.example')).toEqual([
      { slug: 'nymfo', host: 'a.example' },
      { slug: 'aurora', host: 'b.example:8443' },
    ]);
    expect(parseExtraDomains(undefined)).toEqual([]);
    expect(() => parseExtraDomains('host inválido')).toThrow(/SEED_EXTRA_DOMAINS/);
  });

  it('un operador desconocido en SEED_EXTRA_DOMAINS falla antes de escribir', async () => {
    await expect(runSeed(db, { password: PASSWORD, bcryptCost: 4, extraDomains: 'nope=x.example' })).rejects.toThrow(/operador desconocido/);
    expect(await db.operatorDomain.findUnique({ where: { host: 'x.example' } })).toBeNull();
  });

  it('límites por operador en Operator.limits (unidades mínimas), conservando claves previas', async () => {
    const nymfo = await db.operator.findUniqueOrThrow({ where: { slug: 'nymfo' } });
    expect(nymfo.defaultCurrency).toBe('COP');
    expect(nymfo.limits).toEqual({
      maxDeposit: '999',
      minBet: '50000',
      maxBet: '50000000',
      betPresets: { USD: ['1'], COP: ['50000', '100000', '200000', '500000', '1000000', '5000000'] },
    });
    const aurora = await db.operator.findUniqueOrThrow({ where: { slug: 'aurora' } });
    expect(aurora.limits).toEqual({ minBet: '10', maxBet: '100000', betPresets: { USD: ['10', '50', '100', '200', '500', '1000'] } });
    expect(mergeLimits(null, { minBet: '1', maxBet: '2', betPresets: {} })).toEqual({ minBet: '1', maxBet: '2', betPresets: {} });
  });
});
