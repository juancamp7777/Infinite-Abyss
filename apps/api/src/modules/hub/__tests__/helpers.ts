import express from 'express';
import type { AddressInfo } from 'net';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { signHmacSha256 } from '../../shared/crypto/hmac';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import type { ModuleDeps } from '../../shared/module';
import { silentLogger } from '../../shared/module';
import type { BetGuardPort } from '../../shared/ports/BetGuardPort';
import type { OperatorCurrencyPort } from '../../shared/ports/OperatorCurrencyPort';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { hubModule } from '../index';

export const MOCK_SECRET = 'test-mock-secret';
export const OP = 'op-1';
export const PLAYER = 'p-1';

export interface HubHarness {
  base: string;
  wallet: InMemoryWallet;
  bus: InMemoryEventBus;
  env: NodeJS.ProcessEnv;
  services: Record<string, any>;
  close(): Promise<void>;
}

/** Levanta express en un puerto efímero con el Hub montado sobre billetera/bus en memoria. */
export async function startHub(opts: { env?: NodeJS.ProcessEnv; betGuard?: BetGuardPort; operators?: OperatorCurrencyPort } = {}): Promise<HubHarness> {
  const app = express();
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    HUB_PROVIDER_MOCK_PROVIDER_SECRET: MOCK_SECRET,
    HUB_PUBLIC_API_URL: base,
    HUB_INTERNAL_API_URL: base,
    WEB_URL: 'http://web.test',
    ...opts.env,
  };
  const wallet = new InMemoryWallet();
  const bus = new InMemoryEventBus();
  const deps: ModuleDeps = {
    wallet,
    bus,
    auth: new MockAuth(env),
    compliance: new InMemoryPlayerCompliance(),
    betGuard: opts.betGuard,
    operators: opts.operators,
    logger: silentLogger,
    env,
    services: {},
  };
  const services = await hubModule.register(app, undefined, deps);
  return {
    base,
    wallet,
    bus,
    env,
    services,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function api(base: string, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** Llamada firmada al seamless wallet como lo haría el proveedor. */
export async function walletCall(base: string, action: string, body: unknown, opts: { secret?: string; provider?: string; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/hub/v1/wallet/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Provider-Id': opts.provider ?? 'mock-provider',
      'X-Signature': opts.signature ?? signHmacSha256(opts.secret ?? MOCK_SECRET, raw),
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Lanza un juego del MockProvider en modo real y devuelve el token de sesión. */
export async function launchMock(base: string, gameId = 'mock-provider-mp-golden-oasis', player = PLAYER, currency = 'USD') {
  const r = await api(base, 'POST', `/hub/v1/games/${gameId}/launch`, { mode: 'real', currency }, devToken('PLAYER', OP, player));
  if (r.status !== 201) throw new Error(`launch falló: ${r.status} ${JSON.stringify(r.body)}`);
  const token = new URL(r.body.url).searchParams.get('session');
  if (!token) throw new Error('sin token');
  return { token, sessionId: r.body.sessionId as string, url: r.body.url as string };
}
