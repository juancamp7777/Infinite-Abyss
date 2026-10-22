import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { TenantResolver } from '../../src/application/tenancy/TenantResolver';
import { loadConfig } from '../../src/config/env';
import { prisma } from '../../src/infrastructure/database/prisma';
import { PrismaTenantRepository } from '../../src/infrastructure/tenancy/PrismaTenantRepository';
import { buildApp } from '../auth/helpers';
import { createTestOperator } from '../setup/factories';

// Host desconocido (vista previa, dominio sin registrar) → DEFAULT_OPERATOR_SLUG.
// La web SIEMPRE manda X-Operator-Host, así que el fallback debe aplicar también a esa cabecera.

const repo = new PrismaTenantRepository(prisma);
const brand = (app: Parameters<typeof request>[0], h: Record<string, string>) => {
  let r = request(app).get('/api/operator/brand');
  for (const [k, v] of Object.entries(h)) r = r.set(k, v);
  return r;
};

describe('operador por defecto para hosts desconocidos', () => {
  it('X-Operator-Host desconocido → DEFAULT_OPERATOR_SLUG', async () => {
    const op = await createTestOperator();
    const { app } = buildApp({ defaultSlug: op.slug });
    const r = await brand(app, { 'X-Operator-Host': 'preview-abc123.aleph.example:443' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.operator.slug).toBe(op.slug);
  });

  it('Host desconocido sin cabeceras → DEFAULT_OPERATOR_SLUG', async () => {
    const op = await createTestOperator();
    const { app } = buildApp({ defaultSlug: op.slug });
    expect((await brand(app, { Host: 'otro-host.example' })).body.operator.slug).toBe(op.slug);
  });

  it('un host registrado sigue ganando al operador por defecto', async () => {
    const def = await createTestOperator();
    const other = await createTestOperator();
    const { app } = buildApp({ defaultSlug: def.slug });
    expect((await brand(app, { 'X-Operator-Host': other.host })).body.operator.slug).toBe(other.slug);
  });

  it('X-Operator-Slug explícito e inválido sigue dando 404 (no cae en el defecto)', async () => {
    const op = await createTestOperator();
    const { app } = buildApp({ defaultSlug: op.slug });
    expect((await brand(app, { 'X-Operator-Slug': 'no-existe-xyz' })).status).toBe(404);
    expect((await brand(app, { 'X-Operator-Slug': 'NO VALIDO!' })).status).toBe(404);
  });

  it('sin DEFAULT_OPERATOR_SLUG un host desconocido da 404', async () => {
    const { app } = buildApp();
    expect((await brand(app, { 'X-Operator-Host': 'desconocido.example' })).status).toBe(404);
  });

  it('producción: solo con allowDefaultInProduction (ALLOW_DEFAULT_OPERATOR=true)', async () => {
    const op = await createTestOperator();
    const denied = new TenantResolver(repo, { defaultSlug: op.slug, isProduction: true, cacheTtlMs: 0 });
    await expect(denied.resolve({ operatorHostHeader: 'desconocido.example' })).rejects.toMatchObject({ statusCode: 404 });
    const allowed = new TenantResolver(repo, { defaultSlug: op.slug, isProduction: true, allowDefaultInProduction: true, cacheTtlMs: 0 });
    expect((await allowed.resolve({ operatorHostHeader: 'desconocido.example' })).slug).toBe(op.slug);
  });

  it('loadConfig: en producción DEFAULT_OPERATOR_SLUG solo se conserva con ALLOW_DEFAULT_OPERATOR=true', () => {
    const base = {
      DATABASE_URL: 'postgresql://x',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      NODE_ENV: 'production',
      MODULES_ENABLED: 'false',
      DEFAULT_OPERATOR_SLUG: 'nymfo',
    } as NodeJS.ProcessEnv;
    expect(loadConfig(base).defaultOperatorSlug).toBeUndefined();
    expect(loadConfig({ ...base, ALLOW_DEFAULT_OPERATOR: 'true' }).defaultOperatorSlug).toBe('nymfo');
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).defaultOperatorSlug).toBe('nymfo');
  });
});
