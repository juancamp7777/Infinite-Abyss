import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreatedApp } from '../../src/app';
import { prisma } from '../../src/infrastructure/database/prisma';
import type { MarketingRuntime } from '../../src/modules/marketing/application/MarketingRuntime';
import type { CrmSegmentService } from '../../src/modules/crm/application/services';
import { createTestOperator, TEST_PASSWORD } from '../setup/factories';
import { buildIntegrationApp, waitFor } from './helpers';

// (f) Una campaña de marketing NO envía a un jugador autoexcluido de verdad con el endpoint de juego
// responsable de la Fase 1 (POST /api/me/self-exclusion); el compliance port lee la BD real.

let created: CreatedApp;

beforeAll(async () => {
  created = await buildIntegrationApp();
});

afterAll(async () => {
  await created.close();
});

async function registerAndLogin(slug: string, email: string) {
  const T = { 'X-Operator-Slug': slug };
  const reg = await request(created.app).post('/api/auth/register').set(T).send({ email, password: TEST_PASSWORD });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const login = await request(created.app).post('/api/auth/login').set(T).send({ email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return { userId: login.body.user.id as string, token: login.body.accessToken as string, T };
}

describe('(f) Campaña de marketing con autoexclusión real', () => {
  it('el autoexcluido queda excluido (SELF_EXCLUDED) y el resto recibe el envío', async () => {
    const op = await createTestOperator();
    const rt = created.services.modules['marketing'] as MarketingRuntime;
    const segments = created.services.modules['crmSegments'] as CrmSegmentService;
    expect(rt).toBeTruthy();
    expect(segments).toBeTruthy();

    const tag = randomUUID().slice(0, 8);
    const ok = await registerAndLogin(op.slug, `mkt-ok-${tag}@nymfo.test`);
    const excluded = await registerAndLogin(op.slug, `mkt-excl-${tag}@nymfo.test`);
    // La edad verificada (KYC aprobado) es requisito de marketing: la aprobamos para aislar la autoexclusión.
    await prisma.user.updateMany({ where: { id: { in: [ok.userId, excluded.userId] } }, data: { kycStatus: 'VERIFIED' } });

    // Autoexclusión real por el endpoint de la Fase 1.
    const se = await request(created.app)
      .post('/api/me/self-exclusion')
      .set({ ...excluded.T, Authorization: `Bearer ${excluded.token}` })
      .send({ days: 30 });
    expect(se.status, JSON.stringify(se.body)).toBe(200);

    // El CRM conoce a ambos por player.registered.
    await created.services.bus.drain();
    const seg = await segments.create(op.id, { name: 'Todos s6', rule: { all: [{ field: 'playerId', op: 'exists' }] } });
    const members = await waitFor(() => segments.listPlayers(op.id, seg.id), (m) => m.length >= 2);
    expect([...members].sort()).toEqual([ok.userId, excluded.userId].sort());

    for (const p of [ok.userId, excluded.userId]) await rt.consent.set(op.id, p, 'email', true, 'test');
    const now = new Date();
    const tpl = await rt.repos.templates.put({
      id: randomUUID(), operatorId: op.id, name: 'Promo s6', channel: 'email', kind: 'marketing',
      subject: 'Hola {{firstName|amigo}}', body: '<p>Promo de {{operator.name}}</p>', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    const campaign = await rt.repos.campaigns.put({
      id: randomUUID(), operatorId: op.id, name: 'Campaña s6', status: 'scheduled', segmentId: seg.id,
      scheduledAt: new Date(now.getTime() - 60_000).toISOString(),
      variants: [{ key: 'A', templateId: tpl.id, weight: 1 }], conversionWindowDays: 7,
      stats: { audience: 0, processed: 0 }, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });

    await rt.tick(new Date());
    const metrics = await waitFor(() => rt.campaigns.metrics(op.id, campaign.id), (m) => m.total.sent + Object.values(m.total.excludedByReason).reduce((a, b) => a + b, 0) >= 2);
    expect(metrics.total.excludedByReason).toEqual({ SELF_EXCLUDED: 1 });
    expect(metrics.total.sent).toBe(1);

    const excludedSends = await rt.repos.sends.list({ operatorId: op.id, playerId: excluded.userId });
    expect(excludedSends.length).toBeGreaterThan(0);
    expect(excludedSends.every((s) => s.status === 'excluded' && s.reason === 'SELF_EXCLUDED')).toBe(true);
    const okSends = await rt.repos.sends.list({ operatorId: op.id, playerId: ok.userId, status: 'sent' });
    expect(okSends).toHaveLength(1);
  });

  it('el compliance port marca selfExcluded tras la autoexclusión y no antes', async () => {
    const op = await createTestOperator();
    const rt = created.services.modules['marketing'] as MarketingRuntime;
    const p = await registerAndLogin(op.slug, `mkt-c-${randomUUID().slice(0, 8)}@nymfo.test`);
    await prisma.user.update({ where: { id: p.userId }, data: { kycStatus: 'VERIFIED' } });

    expect(await rt.messaging.checkCompliance(op.id, p.userId)).toMatchObject({ ok: true });
    const se = await request(created.app).post('/api/me/self-exclusion').set({ ...p.T, Authorization: `Bearer ${p.token}` }).send({ permanent: true });
    expect(se.status).toBe(200);
    expect(await rt.messaging.checkCompliance(op.id, p.userId)).toEqual({ ok: false, reason: 'SELF_EXCLUDED' });
  });
});
