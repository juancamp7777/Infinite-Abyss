/**
 * Servidor de desarrollo de los módulos Nymfo SIN la Fase 1 (billetera en memoria, MockAuth, eventos en memoria).
 * Sirve para probar el lobby (apps/web) y el backoffice (apps/backoffice) de punta a punta en local.
 *
 *   npm run dev:modules          # http://localhost:4000 (PORT para cambiarlo)
 *
 * Tokens de desarrollo: Bearer dev:<ROLE>:<operatorId>:<id>, p. ej. dev:PLAYER:op-demo:player-demo.
 * Nunca usar en producción: se niega a arrancar con NODE_ENV=production.
 */
import cors from 'cors';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { DEV_CORS_ORIGINS, resolveCorsOrigins } from '../config/env';
import { registerModules } from './index';
import { InMemoryWallet } from './shared/adapters/InMemoryWallet';
import { MockAuth } from './shared/adapters/MockAuth';
import { InMemoryEventBus } from './shared/events/EventBus';
import { InMemoryPlayerCompliance } from './shared/ports/PlayerCompliancePort';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-server no se usa en producción');
  const port = Number(process.env.PORT) || 4000;
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'development',
    HUB_MOCK_PROVIDER: process.env.HUB_MOCK_PROVIDER ?? '1',
    // Sin proxy delante: el navegador llega directo a este servidor (solo desarrollo).
    HUB_PUBLIC_API_URL: process.env.HUB_PUBLIC_API_URL || process.env.PUBLIC_API_URL || `http://localhost:${port}`,
  };
  const logger = { info: console.log, warn: console.warn, error: console.error, debug: () => undefined };

  const wallet = new InMemoryWallet();
  const seedPlayers = (process.env.DEV_PLAYERS || 'op-demo:player-demo').split(',');
  for (const entry of seedPlayers) {
    const [op, player] = entry.split(':');
    if (op && player) wallet.seed(op, player, 'USD', 1_000_000n, 0n);
  }

  const app = express();
  // Orígenes: DEV_CORS_ORIGINS || CORS_ORIGINS (separados por comas) + PUBLIC_WEB_URL/BACKOFFICE_URL; por defecto los localhost.
  const origins = resolveCorsOrigins({
    CORS_ORIGINS: process.env.DEV_CORS_ORIGINS || process.env.CORS_ORIGINS || DEV_CORS_ORIGINS.join(','),
    PUBLIC_WEB_URL: process.env.PUBLIC_WEB_URL,
    BACKOFFICE_URL: process.env.BACKOFFICE_URL,
  });
  app.use(cors({ origin: origins, credentials: true }));
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: origins } });

  await registerModules(app, io, {
    wallet,
    bus: new InMemoryEventBus(logger),
    auth: new MockAuth(env),
    compliance: new InMemoryPlayerCompliance(),
    logger,
    env,
  });
  app.get('/health', (_req, res) => { res.json({ ok: true }); });

  server.listen(port, () => logger.info(`Nymfo módulos (dev) en http://localhost:${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
