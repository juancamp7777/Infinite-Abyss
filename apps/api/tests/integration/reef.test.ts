import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createBackofficeUser, createTestOperator } from '../setup/factories';
import { bearer, buildIntegrationApp, jwt } from './helpers';

let created: CreatedApp;
let opId: string;
let host: string;
let admin: string;
let agent: string;
let otherAdmin: string;

beforeAll(async () => {
  created = await buildIntegrationApp();
  const op = await createTestOperator();
  opId = op.id;
  host = `${op.slug}.test.local`;
  const other = await createTestOperator();
  const a = await createBackofficeUser('OPERATOR_ADMIN', opId);
  admin = jwt.signAccess({ sub: a.id, op: opId, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
  const g = await createBackofficeUser('OPERATOR_SUPPORT', opId);
  agent = jwt.signAccess({ sub: g.id, op: opId, typ: 'backoffice', role: 'OPERATOR_SUPPORT' });
  const o = await createBackofficeUser('OPERATOR_ADMIN', other.id);
  otherAdmin = jwt.signAccess({ sub: o.id, op: other.id, typ: 'backoffice', role: 'OPERATOR_ADMIN' });
});

afterAll(async () => {
  await created.close?.();
});

describe('Reef con Postgres', () => {
  it('borrador → vista previa firmada → publicar → versión 2 → volver a la 1; resuelto por dominio', async () => {
    expect((await request(created.app).get('/reef/v1/admin/site').set(bearer(agent))).status).toBe(403);
    expect((await request(created.app).get(`/reef/v1/site?host=${host}`)).body).toEqual({ site: null });

    const ed = await request(created.app).get('/reef/v1/admin/site').set(bearer(admin));
    expect(ed.body).toMatchObject({ hasDraft: false, publishedVersion: null, config: { template: 'abyss' } });

    // Plantilla Golden en borrador: cambia el diseño, conserva la marca.
    const g = await request(created.app).post('/reef/v1/admin/site/template').set(bearer(admin)).send({ template: 'golden' });
    expect(g.body).toMatchObject({ template: 'golden', layout: { nav: 'topbar' }, brand: { siteName: ed.body.config.brand.siteName } });

    // Validación: XSS y contraste se rechazan con todos los motivos.
    const xss = await request(created.app).put('/reef/v1/admin/site/draft').set(bearer(admin)).send({ ...g.body, brand: { siteName: '<b>x</b>' } });
    expect(xss.status).toBe(422);
    const dark = await request(created.app).put('/reef/v1/admin/site/draft').set(bearer(admin)).send({ ...g.body, colors: { ...g.body.colors, text: '#111111' } });
    expect(dark.body.error).toMatchObject({ code: 'LOW_CONTRAST' });

    // El público todavía no ve nada; con token de vista previa ve el borrador.
    expect((await request(created.app).get(`/reef/v1/site?host=${host}`)).body.site).toBeNull();
    const tok = (await request(created.app).post('/reef/v1/admin/site/preview').set(bearer(admin))).body.token as string;
    const preview = await request(created.app).get(`/reef/v1/site?host=${host}&preview=${encodeURIComponent(tok)}`);
    expect(preview.body.site).toMatchObject({ preview: true, config: { template: 'golden' } });
    expect(preview.headers['cache-control']).toBe('no-store');
    const forged = tok.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await request(created.app).get(`/reef/v1/site?host=${host}&preview=${encodeURIComponent(forged)}`)).body.site).toBeNull();

    // Publicar v1; editar y publicar v2; volver a v1 crea v3 con la config de v1.
    expect((await request(created.app).post('/reef/v1/admin/site/publish').set(bearer(admin))).body).toEqual({ version: 1 });
    expect((await request(created.app).post('/reef/v1/admin/site/publish').set(bearer(admin))).status).toBe(409);
    const pub1 = await request(created.app).get(`/reef/v1/site?host=${host.toUpperCase()}:3000`);
    expect(pub1.body.site).toMatchObject({ version: 1, preview: false, config: { template: 'golden' } });
    await request(created.app).put('/reef/v1/admin/site/draft').set(bearer(admin)).send({ ...g.body, seo: { title: 'Golden Club Pro', description: 'Casino premium' } }).expect(200);
    expect((await request(created.app).post('/reef/v1/admin/site/publish').set(bearer(admin))).body).toEqual({ version: 2 });
    expect((await request(created.app).get(`/reef/v1/site?operatorId=${opId}`)).body.site.config.seo.title).toBe('Golden Club Pro');
    expect((await request(created.app).post('/reef/v1/admin/site/rollback/1').set(bearer(admin))).body).toEqual({ version: 3 });
    const now = await request(created.app).get(`/reef/v1/site?operatorId=${opId}`);
    expect(now.body.site).toMatchObject({ version: 3 });
    expect(now.body.site.config.seo.title).not.toBe('Golden Club Pro');
    const versions = (await request(created.app).get('/reef/v1/admin/site').set(bearer(admin))).body.versions;
    expect(versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(['3:published', '2:archived', '1:archived']);

    // Aislamiento: otro operador no ve ni toca este sitio.
    expect((await request(created.app).get('/reef/v1/admin/site').set(bearer(otherAdmin))).body.publishedVersion).toBeNull();
  });

  it('imágenes: solo formatos reales, servidas con caché inmutable y sin ejecutar nada', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const up = await request(created.app).post('/reef/v1/admin/assets').set(bearer(admin)).set('content-type', 'application/octet-stream').send(png);
    expect(up.status).toBe(201);
    expect(up.body.url).toBe(`/reef/v1/assets/${up.body.id}`);
    const svg = await request(created.app).post('/reef/v1/admin/assets').set(bearer(admin)).set('content-type', 'image/svg+xml').send(Buffer.from('<svg onload="alert(1)"></svg>'));
    expect(svg.status).toBe(415);
    const got = await request(created.app).get(up.body.url);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'");
    expect(await prisma.reefAsset.count({ where: { operatorId: opId } })).toBe(1);
  });
});
