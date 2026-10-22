import type { Application } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { ModuleDeps, NymfoModule } from '../shared/module';
import { CatalogService } from './application/CatalogService';
import { ReportService } from './application/ReportService';
import { SeamlessWalletService } from './application/SeamlessWalletService';
import { SessionService } from './application/SessionService';
import type { HubRepositories } from './domain/repositories';
import { envKey, HubSession, RemoteOperator } from './domain/types';
import { buildAdapters } from './infrastructure/adapters/registry';
import { createHubRouter } from './infrastructure/http/router';
import { createMockProviderServer } from './infrastructure/http/mockProviderServer';
import { createInMemoryRepositories } from './infrastructure/persistence/InMemoryRepositories';
import { createPrismaRepositories, isHubPrismaClient } from './infrastructure/persistence/PrismaRepositories';
import { seedCatalog } from './infrastructure/seed';
import { InMemoryDemoWallet } from './infrastructure/wallet/DemoWallet';
import { RemoteSeamlessWallet } from './infrastructure/wallet/RemoteSeamlessWallet';

export { captureRawBody } from './infrastructure/http/router';
export { RemoteSeamlessWallet } from './infrastructure/wallet/RemoteSeamlessWallet';
export type { ResolvedSession } from './application/SessionService';
export type { CatalogService } from './application/CatalogService';
export type { ReportService } from './application/ReportService';
export { STUDIO_GAMES } from './infrastructure/seed';

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const trimSlash = (v: string) => v.trim().replace(/\/+$/, '');

/**
 * URLs del Hub. Ningún default apunta a localhost salvo la interna (servidor a servidor dentro del mismo proceso/contenedor).
 * - webUrl: base del frontend para los juegos de Studios (WEB_URL || PUBLIC_WEB_URL). Vacía = URL relativa (`/studio/<id>?…`)
 *   que el iframe de la web resuelve contra el origen actual.
 * - publicApiUrl: prefijo con que el NAVEGADOR llega a esta API (HUB_PUBLIC_API_URL || PUBLIC_API_URL || '/api-proxy').
 *   Puede ser absoluta o una ruta (p. ej. '/_svc/api').
 * - internalApiUrl: base para las llamadas del servidor de juego mock a /hub/v1/wallet/* (HUB_INTERNAL_API_URL || 127.0.0.1:PORT).
 */
export function resolveHubUrls(env: NodeJS.ProcessEnv): { webUrl: string; publicApiUrl: string; internalApiUrl: string } {
  return {
    webUrl: trimSlash(env.WEB_URL || env.PUBLIC_WEB_URL || ''),
    publicApiUrl: trimSlash(env.HUB_PUBLIC_API_URL || env.PUBLIC_API_URL || '/api-proxy'),
    internalApiUrl: trimSlash(env.HUB_INTERNAL_API_URL || `http://127.0.0.1:${num(env.PORT, 4000)}`),
  };
}

/** Ensambla el Hub sin montarlo (útil para pruebas). */
export async function createHub(deps: ModuleDeps, repos?: HubRepositories) {
  const env = deps.env;
  const r = repos ?? (isHubPrismaClient(deps.prisma) ? createPrismaRepositories(deps.prisma) : createInMemoryRepositories());
  const adapters = buildAdapters(env);
  const catalog = new CatalogService(r.catalog);
  await seedCatalog(catalog, { mock: Boolean(adapters.mock) });

  const remoteWallets = new Map<string, RemoteSeamlessWallet>();
  const remoteFactory = (remote: RemoteOperator, session: HubSession) => {
    const secret = env[`HUB_REMOTE_${envKey(remote.id)}_SECRET`];
    if (!secret) return null;
    let w = remoteWallets.get(session.id);
    if (!w) {
      if (remoteWallets.size >= 10000) remoteWallets.delete(remoteWallets.keys().next().value as string);
      w = new RemoteSeamlessWallet(remote, secret, {
        sessionToken: session.token,
        retries: num(env.HUB_REMOTE_WALLET_RETRIES, 3),
        timeoutMs: num(env.HUB_REMOTE_WALLET_TIMEOUT_MS, 5000),
      });
      remoteWallets.set(session.id, w);
    }
    return w;
  };

  const { publicApiUrl, internalApiUrl, webUrl } = resolveHubUrls(env);
  const sessions = new SessionService(
    r.sessions,
    r.remoteOperators,
    catalog,
    adapters.registry,
    deps.wallet,
    new InMemoryDemoWallet(BigInt(Math.floor(num(env.HUB_DEMO_BALANCE, 100_000_000)))),
    remoteFactory,
    deps.bus,
    {
      webUrl,
      publicApiUrl,
      ttlMs: num(env.HUB_SESSION_TTL_MIN, 240) * 60_000,
    },
    deps.logger,
  );
  const wallet = new SeamlessWalletService(r.txs, sessions, catalog, deps.bus, deps.logger, deps.betGuard);
  const reports = new ReportService(r.txs, catalog);
  return { repos: r, adapters, catalog, sessions, wallet, reports, publicApiUrl, internalApiUrl };
}

/**
 * Infinite Abyss Hub: catálogo unificado, seamless wallet entrante (/hub/v1/wallet/*), adaptadores de proveedores,
 * lado saliente (/hub/v1/outbound/*) y reportes. Ver apps/api/src/modules/hub/.env.example.
 */
export const hubModule: NymfoModule = {
  name: 'hub',
  async register(app: Application, _io: SocketIOServer | undefined, deps: ModuleDeps) {
    const hub = await createHub(deps);
    app.use(
      '/hub/v1',
      createHubRouter({
        auth: deps.auth,
        catalog: hub.catalog,
        sessions: hub.sessions,
        wallet: hub.wallet,
        reports: hub.reports,
        adapters: hub.adapters.registry,
        remoteOperators: hub.repos.remoteOperators,
        env: deps.env,
        operators: deps.operators,
        logger: deps.logger,
      }),
    );
    const mockSecret = hub.adapters.mock?.signingSecret;
    if (deps.env.HUB_MOCK_PROVIDER === '1' && mockSecret) {
      app.use('/hub/mock-provider', createMockProviderServer({ secret: mockSecret, internalApiUrl: () => hub.internalApiUrl, logger: deps.logger }));
      deps.logger.info('hub: servidor de juego mock montado en /hub/mock-provider');
    }

    const sessionsApi = {
      resolveSession: (token: string) => hub.sessions.resolveSession(token),
      walletForSession: (ref: string | { sessionId: string }) => hub.sessions.walletForSession(ref),
    };
    return {
      catalog: hub.catalog,
      hubReports: hub.reports,
      sessions: sessionsApi,
      resolveSession: sessionsApi.resolveSession,
      walletForSession: sessionsApi.walletForSession,
    };
  },
};

export default hubModule;
