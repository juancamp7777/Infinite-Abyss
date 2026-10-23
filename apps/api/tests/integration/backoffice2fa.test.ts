import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { totpAt, totpStep } from '../../src/domain/auth/totp';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { buildIntegrationApp } from './helpers';

let created: CreatedApp;
const email = `dosfactores-${Date.now()}@abyss.test`;
const password = 'Clave-Muy-Segura-2026!';

beforeAll(async () => {
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  await createBackofficeUser('OPERATOR_ADMIN', op.id, { email, password });
});

afterAll(async () => {
  await created.close?.();
});

const login = (body: Record<string, string>) => request(created.app).post('/api/backoffice/auth/login').send({ email, password, ...body });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('Backoffice: verificación en dos pasos', () => {
  it('activar con QR → login exige código → no se reutiliza → respaldo de un solo uso → desactivar', async () => {
    const first = await login({});
    expect(first.status).toBe(200);
    expect(first.body.user.mfaEnabled).toBe(false);
    const token = first.body.accessToken as string;

    expect((await request(created.app).get('/api/backoffice/auth/2fa')).status).toBe(401);
    expect((await request(created.app).get('/api/backoffice/auth/2fa').set(auth(token))).body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });

    const setup = await request(created.app).post('/api/backoffice/auth/2fa/setup').set(auth(token));
    expect(setup.status).toBe(200);
    expect(setup.body.qrSvg).toMatch(/^<svg/);
    expect(setup.body.otpauthUrl).toContain(encodeURIComponent(email));
    const secret = setup.body.secret as string;

    // Pendiente: todavía no afecta el login. Un código equivocado no activa nada.
    expect((await login({})).status).toBe(200);
    const now = totpStep(Date.now());
    const wrong = await request(created.app).post('/api/backoffice/auth/2fa/enable').set(auth(token)).send({ code: totpAt(secret, now + 5) });
    expect(wrong.status).toBe(422);

    const on = await request(created.app).post('/api/backoffice/auth/2fa/enable').set(auth(token)).send({ code: totpAt(secret, now) });
    expect(on.status).toBe(200);
    const recovery = on.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    expect(on.body.status).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    const row = await prisma.backofficeUser.findUniqueOrThrow({ where: { email } });
    expect(row.totpSecretEnc).not.toContain(secret);
    expect(row.totpRecovery.join()).not.toContain(recovery[0]);

    // La contraseña sola ya no alcanza; el código usado para activar no sirve de nuevo.
    const need = await login({});
    expect(need.status).toBe(401);
    expect(need.body.error?.code ?? need.body.code).toBe('MFA_REQUIRED');
    expect((await login({ code: totpAt(secret, now) })).status).toBe(401);
    const ok = await login({ code: totpAt(secret, now + 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mfaEnabled).toBe(true);
    expect((await login({ code: totpAt(secret, now + 1) })).status).toBe(401);

    // Código de respaldo: entra una vez, la segunda no.
    expect((await login({ code: recovery[0].toLowerCase() })).status).toBe(200);
    expect((await login({ code: recovery[0] })).status).toBe(401);
    expect((await request(created.app).get('/api/backoffice/auth/2fa').set(auth(ok.body.accessToken))).body.recoveryCodesLeft).toBe(9);

    // Contraseña incorrecta con código válido: sigue siendo "correo o contraseña incorrectos".
    expect((await request(created.app).post('/api/backoffice/auth/login').send({ email, password: 'otra', code: recovery[1] })).status).toBe(401);

    // Desactivar exige contraseña y código.
    expect((await request(created.app).post('/api/backoffice/auth/2fa/disable').set(auth(token)).send({ password: 'mala', code: recovery[1] })).status).toBe(401);
    const off = await request(created.app).post('/api/backoffice/auth/2fa/disable').set(auth(token)).send({ password, code: recovery[1] });
    expect(off.body).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
    expect((await login({})).status).toBe(200);
  });
});
