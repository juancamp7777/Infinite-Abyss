import express from 'express';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createLedgerAdminRouter } from '../../src/infrastructure/http/routes/ledgerAdminRoutes';
import type { BackofficeAuth } from '../../src/domain/contracts';
import type { HttpGuards } from '../../src/infrastructure/http/types';
import { createTestPlayer } from '../setup/factories';
import { fund, reconciliation, setup, wallet } from '../ledger/helpers';

/** App mínima con guards falsos: el rol y operador salen de cabeceras de prueba. */
function buildApp() {
  const pass: RequestHandler = (_req, _res, next) => next();
  const guards: HttpGuards = {
    resolveTenant: pass,
    requirePlayer: pass,
    rateLimit: { login: pass, cashier: pass },
    requireBackoffice: (roles) => (req, res, next) => {
      const role = req.header('x-test-role') as BackofficeAuth['role'] | undefined;
      if (!role) return void res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'no' } });
      if (!roles.includes(role)) return void res.status(403).json({ error: { code: 'FORBIDDEN', message: 'no' } });
      req.backoffice = {
        kind: 'backoffice',
        backofficeUserId: req.header('x-test-user') ?? randomUUID(),
        operatorId: req.header('x-test-operator') ?? null,
        role,
      };
      next();
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createLedgerAdminRouter({ walletService: wallet, reconciliationService: reconciliation, prisma, ...guards }));
  return app;
}

describe('ledgerAdminRoutes', () => {
  const app = buildApp();

  it('OPERATOR_ADMIN de A no ve la reconciliación de B (se fuerza su operatorId)', async () => {
    const a = await setup();
    const b = await setup();
    await fund(b.operator.id, b.player.id, 1_000n);
    const res = await request(app)
      .get('/api/backoffice/reconciliation')
      .query({ operatorId: b.operator.id })
      .set('x-test-role', 'OPERATOR_ADMIN')
      .set('x-test-operator', a.operator.id);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe(a.operator.id);

    const platform = await request(app)
      .get('/api/backoffice/reconciliation')
      .query({ operatorId: b.operator.id })
      .set('x-test-role', 'PLATFORM_ADMIN');
    expect(platform.body.scope).toBe(b.operator.id);
    expect(platform.body.totalDiscrepancies).toBe(0);
  });

  it('SUPPORT no puede reconciliar ni ajustar', async () => {
    const a = await setup();
    const r1 = await request(app).get('/api/backoffice/reconciliation').set('x-test-role', 'OPERATOR_SUPPORT').set('x-test-operator', a.operator.id);
    expect(r1.status).toBe(403);
    const r2 = await request(app)
      .post(`/api/backoffice/players/${a.player.id}/adjustments`)
      .set('x-test-role', 'OPERATOR_SUPPORT').set('x-test-operator', a.operator.id)
      .send({ amount: '100', reason: 'x' });
    expect(r2.status).toBe(403);
  });

  it('el ajuste exige reason, crea AuditLog y es idempotente por Idempotency-Key', async () => {
    const a = await setup();
    const actor = (await prisma.backofficeUser.create({
      data: { email: `bo-${randomUUID()}@t.local`, passwordHash: 'x', role: 'OPERATOR_FINANCE', operatorId: a.operator.id },
    })).id;
    const post = (body: object, key?: string) => {
      const r = request(app)
        .post(`/api/backoffice/players/${a.player.id}/adjustments`)
        .set('x-test-role', 'OPERATOR_FINANCE').set('x-test-operator', a.operator.id).set('x-test-user', actor);
      if (key) r.set('Idempotency-Key', key);
      return r.send(body);
    };

    expect((await post({ amount: '100' })).status).toBe(422);
    expect((await post({ amount: '100', reason: '  ' })).status).toBe(422);
    expect((await post({ amount: '1.5', reason: 'x' })).status).toBe(422);
    expect((await post({ amount: '-100', reason: 'sin saldo' })).status).toBe(400);

    const key = `key-${randomUUID()}`;
    const ok = await post({ amount: '2500', reason: 'bono de bienvenida' }, key);
    expect(ok.status).toBe(201);
    expect(ok.body.balance).toBe('2500');
    const replay = await post({ amount: '2500', reason: 'bono de bienvenida' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect((await post({ amount: '999', reason: 'otro' }, key)).status).toBe(409);

    const logs = await prisma.auditLog.findMany({ where: { operatorId: a.operator.id, action: 'LEDGER_MANUAL_ADJUSTMENT' } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(actor);
    expect(logs[0].reason).toBe('bono de bienvenida');
    expect((await reconciliation.run({ operatorId: a.operator.id })).totalDiscrepancies).toBe(0);
  });

  it('no se puede ajustar a un jugador de otro operador (404)', async () => {
    const a = await setup();
    const b = await setup();
    const res = await request(app)
      .post(`/api/backoffice/players/${b.player.id}/adjustments`)
      .set('x-test-role', 'OPERATOR_ADMIN').set('x-test-operator', a.operator.id)
      .send({ amount: '100', reason: 'cross-tenant' });
    expect(res.status).toBe(404);
    expect((await wallet.getBalances({ operatorId: b.operator.id, userId: b.player.id })).cash).toBe(0n);
  });

  it('stats: acotado al operador, montos como string', async () => {
    const a = await setup();
    const b = await setup();
    await createTestPlayer(a.operator.id);
    await fund(a.operator.id, a.player.id, 1_000n);
    await wallet.betAndSettle({ operatorId: a.operator.id, userId: a.player.id, currency: 'USD', betAmount: 300n, winAmount: 100n, gameType: 'SLOTS', idempotencyKey: 'bet:1' });
    await fund(b.operator.id, b.player.id, 9_000n);
    await prisma.playerSession.create({ data: { userId: a.player.id, operatorId: a.operator.id } });

    const res = await request(app).get('/api/backoffice/stats').set('x-test-role', 'OPERATOR_ADMIN').set('x-test-operator', a.operator.id);
    expect(res.status).toBe(200);
    expect(res.body.players).toBe(2);
    expect(res.body.liability.USD).toBe('800');
    expect(res.body.ggr.USD).toBe('200');
    expect(res.body.recentSessions).toHaveLength(1);
  });
});
