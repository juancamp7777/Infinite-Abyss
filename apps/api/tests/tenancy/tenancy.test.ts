import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestOperator } from '../setup/factories';
import { buildApp } from '../auth/helpers';

const { app, resolver } = buildApp();
const brand = (h: Record<string, string>) => {
  let r = request(app).get('/api/operator/brand');
  for (const [k, v] of Object.entries(h)) r = r.set(k, v);
  return r;
};

describe('resolución de tenant', () => {
  it('por cabecera X-Operator-Slug', async () => {
    const op = await createTestOperator({ defaultCurrency: 'USDT', currencies: ['USDT'] });
    const r = await brand({ 'X-Operator-Slug': op.slug });
    expect(r.status).toBe(200);
    expect(r.body.operator.slug).toBe(op.slug);
    expect(r.body.operator.currencyDecimals).toEqual({ USDT: 6 });
    expect(r.body.brand.colors.primary).toBeDefined();
  });

  it('por X-Operator-Host y por Host', async () => {
    const op = await createTestOperator();
    expect((await brand({ 'X-Operator-Host': op.host })).body.operator.slug).toBe(op.slug);
    expect((await brand({ Host: op.host })).body.operator.slug).toBe(op.slug);
  });

  it('slug tiene prioridad sobre hosts', async () => {
    const a = await createTestOperator();
    const b = await createTestOperator();
    const r = await brand({ 'X-Operator-Slug': a.slug, 'X-Operator-Host': b.host });
    expect(r.body.operator.slug).toBe(a.slug);
  });

  it('operador inexistente → 404', async () => {
    expect((await brand({ 'X-Operator-Slug': 'no-existe-xyz' })).status).toBe(404);
    expect((await brand({ 'X-Operator-Host': 'nada.example.org' })).status).toBe(404);
  });

  it('operador SUSPENDED → 403', async () => {
    const op = await createTestOperator({ status: 'SUSPENDED' });
    const r = await brand({ 'X-Operator-Slug': op.slug });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('slug por defecto solo fuera de producción', async () => {
    const op = await createTestOperator();
    const dev = buildApp({ defaultSlug: op.slug }).app;
    expect((await request(dev).get('/api/operator/brand').set('Host', 'sin-dominio.local')).body.operator.slug).toBe(op.slug);

    const { TenantResolver } = await import('../../src/application/tenancy/TenantResolver');
    const { PrismaTenantRepository } = await import('../../src/infrastructure/tenancy/PrismaTenantRepository');
    const { prisma } = await import('../../src/infrastructure/database/prisma');
    const prod = new TenantResolver(new PrismaTenantRepository(prisma), { defaultSlug: op.slug, isProduction: true });
    await expect(prod.resolve({ requestHost: 'sin-dominio.local' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('la caché evita consultas repetidas y invalidate la limpia', async () => {
    const op = await createTestOperator();
    let calls = 0;
    const { TenantResolver } = await import('../../src/application/tenancy/TenantResolver');
    const { PrismaTenantRepository } = await import('../../src/infrastructure/tenancy/PrismaTenantRepository');
    const { prisma } = await import('../../src/infrastructure/database/prisma');
    const inner = new PrismaTenantRepository(prisma);
    const res = new TenantResolver(
      { findBySlug: (s) => (calls++, inner.findBySlug(s)), findByHost: (h) => inner.findByHost(h) },
      { cacheTtlMs: 60_000 },
    );
    await res.resolve({ slugHeader: op.slug });
    await res.resolve({ slugHeader: op.slug });
    expect(calls).toBe(1);
    res.invalidate();
    await res.resolve({ slugHeader: op.slug });
    expect(calls).toBe(2);
  });
});

void resolver;
