import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreatedApp } from '../../src/app';
import { loadConfig, resolveCorsOrigins } from '../../src/config/env';
import { buildIntegrationApp } from '../integration/helpers';

// Cabeceras de seguridad de la API (middleware securityHeaders) y orígenes CORS desde el entorno.

const PROD_ENV = {
  ...process.env,
  NODE_ENV: 'production',
  // Valores de PRUEBA (no reales): la config de producción exige secretos de ≥ 32 caracteres.
  MKT_UNSUBSCRIBE_SECRET: 'test-only-mkt-unsubscribe-0123456789abcdef',
  PROMO_DROPS_SECRET: 'test-only-promo-drops-0123456789abcdef-xx',
  FEED_PSEUDONYM_SECRET: 'test-only-feed-pseudonym-0123456789abcdef',
  INBOX_SECRETS_KEY: 'test-only-inbox-secrets-key-0123456789abcdef',
  CORS_ORIGINS: 'https://casino.example.com, https://otra.example.com/ruta',
  PUBLIC_WEB_URL: 'https://web.example.com/lobby',
  BACKOFFICE_URL: 'https://bo.example.com/_svc/backoffice',
} as NodeJS.ProcessEnv;

let dev: CreatedApp;
let prod: CreatedApp;

beforeAll(async () => {
  dev = await buildIntegrationApp({ moduleEnv: { HUB_MOCK_PROVIDER: '1' } });
  prod = createApp(loadConfig(PROD_ENV), { modules: false, bcryptCost: 4, rateLimit: { disabled: true } });
  await prod.ready;
});

afterAll(async () => {
  await dev.close();
  await prod.close();
});

describe('cabeceras de seguridad', () => {
  it('/health trae nosniff, Referrer-Policy, X-Frame-Options DENY y frame-ancestors none, sin x-powered-by', async () => {
    const r = await request(dev.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('HSTS solo en producción', async () => {
    expect((await request(dev.app).get('/health')).headers['strict-transport-security']).toBeUndefined();
    const p = await request(prod.app).get('/health');
    expect(p.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(p.headers['x-powered-by']).toBeUndefined();
    expect(p.headers['x-frame-options']).toBe('DENY');
  });

  it('también en errores (404) y respuestas de error JSON', async () => {
    const r = await request(dev.app).get('/no-existe');
    expect(r.status).toBe(404);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('el juego del MockProvider se puede encuadrar desde la web y su CSP permite sus scripts', async () => {
    const r = await request(dev.app).get('/hub/mock-provider/game/mp-golden-oasis?mode=demo&currency=COP');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['x-frame-options']).toBeUndefined();
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('en producción frame-ancestors del mock incluye PUBLIC_WEB_URL y CORS_ORIGINS (solo el origen)', async () => {
    const r = await request(prod.app).get('/hub/mock-provider/game/x');
    const csp = r.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain('https://web.example.com');
    expect(csp).toContain('https://casino.example.com');
    expect(csp).not.toContain('/lobby');
    expect(csp).not.toContain('localhost');
    expect(r.headers['x-frame-options']).toBeUndefined();
  });
});

describe('CORS desde el entorno', () => {
  it('resolveCorsOrigins: CORS_ORIGINS + PUBLIC_WEB_URL + BACKOFFICE_URL, solo origen y sin duplicados', () => {
    expect(
      resolveCorsOrigins({
        CORS_ORIGINS: 'https://a.example, https://a.example/x,,no-es-url, http://b.example:8080/',
        PUBLIC_WEB_URL: 'https://a.example/lobby',
        BACKOFFICE_URL: 'https://bo.example/_svc/backoffice',
      }),
    ).toEqual(['https://a.example', 'http://b.example:8080', 'https://bo.example']);
    expect(resolveCorsOrigins({})).toEqual([]);
  });

  it('producción: permite los orígenes configurados y rechaza los demás (sin localhost por defecto)', async () => {
    for (const origin of ['https://casino.example.com', 'https://otra.example.com', 'https://web.example.com', 'https://bo.example.com']) {
      const r = await request(prod.app).get('/health').set('Origin', origin);
      expect(r.headers['access-control-allow-origin'], origin).toBe(origin);
    }
    for (const origin of ['https://malo.example', 'http://localhost:3000']) {
      const r = await request(prod.app).get('/health').set('Origin', origin);
      expect(r.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('fuera de producción conserva los localhost de desarrollo', async () => {
    const r = await request(dev.app).get('/health').set('Origin', 'http://localhost:3001');
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });
});
