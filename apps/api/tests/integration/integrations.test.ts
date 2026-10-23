import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import type { IntegrationsPort } from '../../src/modules/shared/ports/IntegrationsPort';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let root: string;
let admin: string;
let otherAdmin: string;
let support: string;

beforeAll(async () => {
  // Estado limpio: sin credenciales globales ni el agregador de la prueba en el catálogo.
  await prisma.integrationCredential.deleteMany({ where: { scope: 'platform' } });
  await prisma.hubGame.deleteMany({ where: { providerId: 'api-slots' } });
  await prisma.hubProvider.deleteMany({ where: { id: 'api-slots' } });
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  opId = op.id;
  const other = await createTestOperator();
  const r = await createBackofficeUser('PLATFORM_ADMIN', null);
  root = jwt.signAccess({ sub: r.id, op: '', typ: 'backoffice', role: 'PLATFORM_ADMIN' });
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const o = await createBackofficeUser('OPERATOR_ADMIN', other.id);
  otherAdmin = jwt.signAccess({ sub: o.id, op: other.id, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const s = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  support = jwt.signAccess({ sub: s.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
});

afterAll(async () => {
  await prisma.integrationCredential.deleteMany({ where: { scope: { in: ['platform', opId] } } });
  await created.close?.();
});

const P = '/integrations/v1/admin';

describe('Integraciones con Postgres', () => {
  it('solo administradores; la plataforma conecta lo global; cada casino lo suyo', async () => {
    expect((await request(created.app).get(`${P}/list`).set(bearer(support))).status).toBe(403);
    expect((await request(created.app).get(`${P}/list?scope=platform`).set(bearer(admin))).status).toBe(403);
    expect((await request(created.app).put(`${P}/api-matic?scope=operator`).set(bearer(admin)).send({ values: { apiKey: 'k', secretKey: 'aa' } })).body.error).toMatchObject({ code: 'WRONG_SCOPE' });
    const cat = await request(created.app).get(`${P}/catalog`).set(bearer(admin));
    expect(cat.body.items.map((d: { key: string }) => d.key)).toEqual(expect.arrayContaining(['anthropic', 'api-matic', 'pragmatic-play', 'binance-pay', 'telegram-alerts']));
  });

  it('las llaves se guardan cifradas, vuelven enmascaradas y el casino hereda la de la plataforma', async () => {
    const key = 'sk-ant-api03-SECRETO-plataforma-0001';
    const saved = await request(created.app).put(`${P}/anthropic?scope=platform`).set(bearer(root)).send({ values: { apiKey: key } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ connected: true, status: 'saved', fields: { apiKey: '••••0001' } });
    expect(JSON.stringify(saved.body)).not.toContain('SECRETO');

    const row = await prisma.integrationCredential.findUniqueOrThrow({ where: { scope_key: { scope: 'platform', key: 'anthropic' } } });
    expect(row.secretsEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('SECRETO');

    const mine = await request(created.app).get(`${P}/list`).set(bearer(admin));
    expect(mine.body.items.find((i: { key: string }) => i.key === 'anthropic')).toMatchObject({ connected: true, inherited: true, fields: {} });
    const port = created.services.modules['integrations.service'] as IntegrationsPort;
    expect(await port.value(opId, 'anthropic', 'apiKey')).toBe(key);

    // El casino conecta su propia llave: manda sobre la de la plataforma y el otro casino no la ve.
    await request(created.app).put(`${P}/anthropic`).set(bearer(admin)).send({ values: { apiKey: 'sk-ant-propia-del-casino-9999' } }).expect(200);
    expect(await port.value(opId, 'anthropic', 'apiKey')).toBe('sk-ant-propia-del-casino-9999');
    const other = await request(created.app).get(`${P}/list`).set(bearer(otherAdmin));
    expect(other.body.items.find((i: { key: string }) => i.key === 'anthropic')).toMatchObject({ inherited: true });

    // Guardar sin reenviar el secreto lo conserva; validación con todos los motivos.
    await request(created.app).put(`${P}/telegram-alerts`).set(bearer(admin)).send({ values: { botToken: '123456789:AAFabcdefghijklmnopqrstuvwxyz012345', chatId: '-100' } }).expect(200);
    const keep = await request(created.app).put(`${P}/telegram-alerts`).set(bearer(admin)).send({ values: { botToken: '', chatId: '-200' } });
    expect(keep.body.fields).toEqual({ botToken: '••••2345', chatId: '-200' });
    const bad = await request(created.app).put(`${P}/usdt-wallet`).set(bearer(admin)).send({ values: { network: 'TRC20' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/Dirección: obligatorio/);

    // Pagos aún sin conector: se guardan y la prueba lo dice con claridad.
    await request(created.app).put(`${P}/usdt-wallet`).set(bearer(admin)).send({ values: { network: 'TRC20', address: 'TXYZ123' } }).expect(200);
    const t = await request(created.app).post(`${P}/usdt-wallet/test`).set(bearer(admin));
    expect(t.body).toMatchObject({ ok: false, view: { status: 'saved' } });
    expect(t.body.message).toMatch(/llega con el conector/);

    await request(created.app).delete(`${P}/anthropic`).set(bearer(admin)).expect(204);
    expect(await port.value(opId, 'anthropic', 'apiKey')).toBe(key);
  });

  it('un proveedor de juegos conectado desde la pantalla se enciende en el Hub sin reiniciar', async () => {
    const port = created.services.modules['integrations.service'] as IntegrationsPort;
    const before = await request(created.app).get('/hub/v1/providers');
    expect((before.body.items ?? before.body).map?.((p: { id: string }) => p.id) ?? []).not.toContain('api-slots');

    const r = await request(created.app).put(`${P}/api-slots?scope=platform`).set(bearer(root)).send({ values: { partnerId: 'P-77', apiKey: 'slots-key-secreta', apiUrl: 'https://api.slots.example' } });
    expect(r.status).toBe(200);
    expect(await port.envOverlay()).toMatchObject({ HUB_APISLOTS_PARTNER_ID: 'P-77', HUB_APISLOTS_API_KEY: 'slots-key-secreta', HUB_APISLOTS_API_URL: 'https://api.slots.example' });
    const after = await request(created.app).get('/hub/v1/providers');
    expect(JSON.stringify(after.body)).toContain('api-slots');

    // Prueba de conexión: el proveedor falso no responde → rojo con el motivo, sin filtrar la llave.
    const t = await request(created.app).post(`${P}/api-slots/test?scope=platform`).set(bearer(root));
    expect(t.body).toMatchObject({ ok: false, view: { status: 'error' } });
    expect(t.body.message).not.toContain('slots-key-secreta');

    await request(created.app).delete(`${P}/api-slots?scope=platform`).set(bearer(root)).expect(204);
    expect(await port.envOverlay()).toEqual({});
  });
});
