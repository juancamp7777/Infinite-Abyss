import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { createPromotionsModule, PromotionsFacade } from '../index';
import { bet, CUR, OP } from './helpers';

describe('módulo promotions montado (HTTP + bus)', () => {
  let server: HttpServer;
  let base: string;
  let facade: PromotionsFacade;
  let services: Record<string, unknown>;
  const bus = new InMemoryEventBus();
  const wallet = new InMemoryWallet();
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');
  const player = devToken('PLAYER', OP, 'p1');

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  beforeAll(async () => {
    const app = express();
    const deps: ModuleDeps = {
      wallet,
      bus,
      auth: new MockAuth({ NODE_ENV: 'test' }),
      compliance: new InMemoryPlayerCompliance(),
      logger: silentLogger,
      env: { PROMO_DROPS_SECRET: 'test-secret' },
      services: {},
    };
    services = await createPromotionsModule({ tickIntervalMs: 0, rng: { int: (m) => m - 1 } }).register(app, undefined, deps);
    facade = services.promotions as PromotionsFacade;
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/promo/v1`;
  });

  afterAll(async () => {
    facade.stop();
    await new Promise((r) => server.close(r));
  });

  it('publica betGuard, promotions y freeSpins', () => {
    expect(typeof facade.grantCashback).toBe('function');
    expect(typeof (services['promotions.betGuard'] as { checkBet: unknown }).checkBet).toBe('function');
    expect(services['promotions.freeSpins']).toBeDefined();
  });

  it('flujo de admin y jugador con montos como string', async () => {
    expect((await call('POST', '/admin/bonus-templates', player, {})).status).toBe(403);
    expect((await call('GET', '/bonuses')).status).toBe(401);
    const bad = await call('POST', '/admin/bonus-templates', admin, { name: 'x', type: 'promo_code', currency: CUR, code: 'X1', fixedAmount: '1.5' });
    expect(bad.status).toBe(400);
    const created = await call('POST', '/admin/bonus-templates', admin, {
      name: 'Bienvenida', type: 'promo_code', currency: CUR, code: 'HOLA', fixedAmount: '500', wageringMultiplier: 2, maxBet: '100',
    });
    expect(created.status).toBe(201);
    expect(created.body.template.fixedAmount).toBe('500');
    expect((await call('POST', '/admin/bonus-templates', devToken('OPERATOR_ADMIN', 'op-2', 'a'), { operatorId: OP, name: 'x', type: 'promo_code', currency: CUR, code: 'ZZ', fixedAmount: '1' })).status).toBe(403);

    const claim = await call('POST', '/bonuses/claim', player, { code: 'hola' });
    expect(claim.status).toBe(201);
    expect(claim.body.bonus).toMatchObject({ status: 'ACTIVE', amount: '500', wageringRequired: '1000', progressBps: 0 });
    expect((await call('POST', '/bonuses/claim', player, { code: 'HOLA' })).body.error.code).toBe('BONUS_ALREADY_ACTIVE');

    await bus.publish('bet.placed', bet('p1', 600n));
    await bus.drain();
    const list = await call('GET', '/bonuses', player);
    // Apuesta de 600 > maxBet 100 → violación.
    expect(list.body.history[0]).toMatchObject({ status: 'FORFEITED', statusReason: 'MAX_BET_VIOLATION' });

    const t2 = await call('POST', '/admin/bonus-templates', admin, { name: 'B2', type: 'promo_code', currency: CUR, code: 'DOS', fixedAmount: '100', wageringMultiplier: 1 });
    const grant = await call('POST', '/admin/bonuses/grant', admin, { playerId: 'p1', templateId: t2.body.template.id, idempotencyKey: 'g-1' });
    expect(grant.status).toBe(201);
    const again = await call('POST', '/admin/bonuses/grant', admin, { playerId: 'p1', templateId: t2.body.template.id, idempotencyKey: 'g-1' });
    expect(again.body.bonus.id).toBe(grant.body.bonus.id);
    const cancel = await call('POST', `/bonuses/${grant.body.bonus.id}/cancel`, player);
    expect(cancel.body.bonus.status).toBe('CANCELLED');
    const adminList = await call('GET', '/admin/bonuses?status=CANCELLED,FORFEITED', admin);
    expect(adminList.body.bonuses).toHaveLength(2);
  });

  it('jackpots: configuración, endpoint público, contribución por bus y reporte', async () => {
    const created = await call('POST', '/admin/jackpots', admin, {
      name: 'Nymfo Triple', currency: CUR, contributionBps: 100,
      levels: [
        { key: 'mini', seedAmount: '1000', shareBps: 7000, triggerChancePpm: 50 },
        { key: 'mega', seedAmount: '50000', shareBps: 3000, triggerChancePpm: 1 },
      ],
    });
    expect(created.status).toBe(201);
    expect((await call('GET', '/jackpots')).status).toBe(400);
    await bus.publish('bet.placed', bet('p2', 10000n));
    await bus.drain();
    const pub = await call('GET', `/jackpots?operatorId=${OP}`);
    expect(pub.body.jackpots[0].levels).toEqual([
      { key: 'mini', amount: '1070', mustDropBy: null },
      { key: 'mega', amount: '50030', mustDropBy: null },
    ]);
    const rep = await call('GET', `/admin/jackpots/${created.body.jackpot.id}/report`, admin);
    expect(rep.body).toMatchObject({ contributions: '100', seedFunding: '51000', payouts: '0', pools: '51100', balanced: true });
  });

  it('drops: alta y campañas activas', async () => {
    const now = Date.now();
    const created = await call('POST', '/admin/drops', admin, {
      name: 'Drops', currency: CUR, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3_600_000).toISOString(),
      dropChancePpm: 1000, prizes: [{ amount: '250', quantity: 5 }],
    });
    expect(created.status).toBe(201);
    const active = await call('GET', `/drops?operatorId=${OP}`);
    expect(active.body.campaigns[0]).toMatchObject({ name: 'Drops', remaining: 5, prizes: [{ amount: '250', quantity: 5, remaining: 5 }] });
  });

  it('grantCashback del servicio es idempotente', async () => {
    await facade.grantCashback(OP, 'p9', 100n, 'loss-1');
    await facade.grantCashback(OP, 'p9', 100n, 'loss-1');
    expect(wallet.getHistory({ playerId: 'p9', reason: 'CASHBACK' })).toHaveLength(1);
  });
});
