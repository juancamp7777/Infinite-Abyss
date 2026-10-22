import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerModules } from '../index';
import { InMemoryWallet } from '../shared/adapters/InMemoryWallet';
import { MockAuth, devToken } from '../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../shared/events/EventBus';
import { InMemoryPlayerCompliance } from '../shared/ports/PlayerCompliancePort';
import { silentLogger } from '../shared/module';

const OP = 'op-int';
const P = 'player-int';

describe('registerModules (integración de los 7 módulos)', () => {
  let base = '';
  let server: ReturnType<express.Application['listen']>;
  let services: Record<string, unknown>;
  const wallet = new InMemoryWallet();
  const bus = new InMemoryEventBus();

  beforeAll(async () => {
    const env = { NODE_ENV: 'test', MKT_SCHEDULER: 'off', PROMO_TICK_INTERVAL_MS: '0', STUDIO_CRASH_LIVE: 'false' };
    wallet.seed(OP, P, 'USD', 1_000_000n);
    const app = express();
    services = await registerModules(app, undefined, {
      wallet, bus, auth: new MockAuth(env), compliance: new InMemoryPlayerCompliance(), logger: silentLogger, env,
    });
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    (services['promotions'] as { stop?: () => void } | undefined)?.stop?.();
    (services['gamification.service'] as { stop?: () => void } | undefined)?.stop?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('publica los servicios con y sin prefijo de módulo', () => {
    for (const k of ['hub.catalog', 'hub.sessions', 'studio.studioPlay', 'promotions', 'promotions.betGuard', 'crm.crmSegments', 'crmProfiles', 'marketing', 'gamification.service', 'backoffice.dashboard']) {
      expect(services[k], k).toBeDefined();
    }
  });

  it('monta las rutas de cada módulo y juega una slot propia de punta a punta', async () => {
    const token = devToken('PLAYER', OP, P);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const games = await fetch(`${base}/hub/v1/games?pageSize=50`).then((r) => r.json());
    const ids = (games.items ?? games.games ?? []).map((g: { id: string }) => g.id);
    expect(ids).toContain('nymfo-starfall');

    const studioGames = await fetch(`${base}/studio/v1/games`).then((r) => r.json());
    expect(JSON.stringify(studioGames)).toContain('nymfo-verdant-grid');

    for (const gameId of ['nymfo-starfall', 'nymfo-verdant-grid', 'nymfo-ember-lines']) {
      const res = await fetch(`${base}/studio/v1/play/${gameId}`, { method: 'POST', headers: auth, body: JSON.stringify({ amount: '100', currency: 'USD' }) });
      expect(res.status, gameId).toBe(200);
    }
    await bus.drain();

    const crm = await fetch(`${base}/crm/v1/admin/players/${P}`, { headers: { authorization: `Bearer ${devToken('OPERATOR_ADMIN', OP, 'admin-1')}` } });
    expect(crm.status).toBe(200);

    for (const path of ['/promo/v1/jackpots?operatorId=' + OP, '/gamification/v1/vip', '/marketing/v1/inbox']) {
      const r = await fetch(base + path, { headers: auth });
      expect(r.status, path).toBe(200);
    }
    const dash = await fetch(`${base}/backoffice/v1/dashboard`, { headers: { authorization: `Bearer ${devToken('OPERATOR_ADMIN', OP, 'admin-1')}` } });
    expect(dash.status).toBe(200);
  });
});
