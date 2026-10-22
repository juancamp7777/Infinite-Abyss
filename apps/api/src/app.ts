import http from 'http';
import express, { type Application, type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import type { Server as IOServer } from 'socket.io';

import { DEV_CORS_ORIGINS, type AppConfig } from './config/env';
import { securityHeaders } from './infrastructure/http/middlewares/securityHeaders';
import { prisma as defaultPrisma } from './infrastructure/database/prisma';
import { logger } from './infrastructure/logging/logger';

// Servicios base
import { CryptoRNGService } from './infrastructure/services/CryptoRNGService';
import { PrismaWalletService } from './infrastructure/ledger/PrismaWalletService';
import { ReconciliationService } from './application/reconciliation/ReconciliationService';
import { PrismaGameSessionRepository } from './infrastructure/repositories/PrismaGameSessionRepository';

// Cuentas, tenants, juego responsable
import { JwtService } from './infrastructure/auth/JwtService';
import { PrismaAuditLogger } from './infrastructure/auth/PrismaAuditLogger';
import { AuthService } from './application/auth/AuthService';
import { TenantResolver } from './application/tenancy/TenantResolver';
import { PrismaTenantRepository } from './infrastructure/tenancy/PrismaTenantRepository';
import { ResponsibleGamingPolicy } from './application/responsible-gaming/ResponsibleGamingPolicy';
import { ResponsibleGamingService } from './application/responsible-gaming/ResponsibleGamingService';
import { createGuards, type Guards } from './infrastructure/http/middlewares/createGuards';
import type { RateLimitOptions } from './infrastructure/http/middlewares/rateLimit';
import { errorHandler, notFoundHandler } from './infrastructure/http/middlewares/errorHandler';
import { createSocketAuthMiddleware } from './infrastructure/sockets/socketAuth';

// Pagos
import { PaymentProviderRegistry } from './infrastructure/payments/PaymentProviderRegistry';
import type { FetchLike } from './infrastructure/payments/types';
import { CreateDepositUseCase } from './application/cashier/CreateDepositUseCase';
import { RequestWithdrawalUseCase } from './application/cashier/RequestWithdrawalUseCase';
import { ReviewWithdrawalUseCase } from './application/cashier/ReviewWithdrawalUseCase';
import { HandleWebhookUseCase } from './application/cashier/HandleWebhookUseCase';

// Rutas
import { createAuthRouter } from './infrastructure/http/routes/authRoutes';
import { createBackofficeAuthRouter } from './infrastructure/http/routes/backofficeAuthRoutes';
import { createOperatorRouter } from './infrastructure/http/routes/operatorRoutes';
import { createPlayerAccountRouter } from './infrastructure/http/routes/playerAccountRoutes';
import { createLedgerAdminRouter } from './infrastructure/http/routes/ledgerAdminRoutes';
import { createCashierRouter } from './infrastructure/http/routes/cashierRoutes';
import { createWebhookRouter } from './infrastructure/http/routes/webhookRoutes';
import { createBackofficeWithdrawalRouter } from './infrastructure/http/routes/backofficeWithdrawalRoutes';

// Juegos
import { ProcessBetUseCase } from './application/use-cases/ProcessBetUseCase';
import { PlaySlotsUseCase } from './application/use-cases/PlaySlotsUseCase';
import { StartBlackjackHandUseCase } from './application/use-cases/blackjack/StartBlackjackHandUseCase';
import { HitBlackjackUseCase } from './application/use-cases/blackjack/HitBlackjackUseCase';
import { StandBlackjackUseCase } from './application/use-cases/blackjack/StandBlackjackUseCase';
import { StartMinesUseCase } from './application/use-cases/mines/StartMinesUseCase';
import { RevealMinesUseCase } from './application/use-cases/mines/RevealMinesUseCase';
import { CashoutMinesUseCase } from './application/use-cases/mines/CashoutMinesUseCase';
import { PlaceCrashBetUseCase } from './application/use-cases/crash/PlaceCrashBetUseCase';
import { CashoutCrashUseCase } from './application/use-cases/crash/CashoutCrashUseCase';
import { PlayPlinkoUseCase } from './application/use-cases/plinko/PlayPlinkoUseCase';
import { CrashGameEngine } from './domain/entities/CrashGame';
import { SocketServer } from './infrastructure/sockets/SocketServer';

// Módulos Nymfo (Hub, Studios, promociones, CRM, marketing, gamificación, backoffice-api)
import { registerModules, captureRawBody } from './modules';
import { InMemoryEventBus } from './modules/shared/events/EventBus';
import { buildModuleDeps, Phase1GameEvents } from './infrastructure/modules';

export interface AppOverrides {
  prisma?: PrismaClient;
  /** fetch inyectable para los adaptadores de PSP (tests). */
  fetch?: FetchLike;
  /** Registro de PSP completo (proveedores falsos). Tiene prioridad sobre `fetch`. */
  registry?: PaymentProviderRegistry;
  /** Coste de bcrypt (bajo solo en tests). */
  bcryptCost?: number;
  rateLimit?: RateLimitOptions;
  /** Variables extra para los módulos (p. ej. MKT_SCHEDULER=off, STUDIO_CRASH_LIVE=false en tests). */
  moduleEnv?: Record<string, string>;
  /** Desactiva el montaje de los módulos (por defecto según config.modules.enabled). */
  modules?: boolean;
}

export interface AppServices {
  prisma: PrismaClient;
  walletService: PrismaWalletService;
  reconciliationService: ReconciliationService;
  registry: PaymentProviderRegistry;
  jwt: JwtService;
  authService: AuthService;
  guards: Guards;
  tenantResolver: TenantResolver;
  /** Bus de eventos de dominio único (Fase 1 + módulos). drain() espera las entregas pendientes. */
  bus: InMemoryEventBus;
  /** Servicios publicados por los módulos (clave original y '<módulo>.<clave>'). Se llena cuando `ready` resuelve. */
  modules: Record<string, unknown>;
}

export interface CreatedApp {
  app: Express;
  httpServer: http.Server;
  io: IOServer;
  services: AppServices;
  /** Resuelve cuando los módulos quedaron montados (las peticiones a sus rutas esperan esta promesa). */
  ready: Promise<void>;
  /** Cierra socket.io, el servidor HTTP, los temporizadores de los módulos y el motor de crash (no desconecta Prisma). */
  close(): Promise<void>;
}

/** Composition root: construye y cablea todas las dependencias. No escucha en ningún puerto. */
export function createApp(config: AppConfig, overrides: AppOverrides = {}): CreatedApp {
  const prisma = overrides.prisma ?? defaultPrisma;

  // ── Núcleo ──
  const audit = new PrismaAuditLogger(prisma);
  const rgPolicy = new ResponsibleGamingPolicy(prisma);
  const rgService = new ResponsibleGamingService(prisma, audit);
  const walletService = new PrismaWalletService(prisma, rgPolicy);
  // Bus de eventos único: lo comparten los casos de uso de la Fase 1 y los módulos.
  const bus = new InMemoryEventBus(logger);
  const gameEvents = new Phase1GameEvents(bus, prisma, logger);
  // Los juegos de la Fase 1 usan la billetera decorada (emite bet.placed/bet.settled tras el commit).
  const gameWallet = gameEvents.wrapWallet(walletService);
  const reconciliationService = new ReconciliationService(prisma);
  const registry = overrides.registry ?? PaymentProviderRegistry.fromConfig(config, overrides.fetch);

  const jwt = new JwtService({ secret: config.jwt.accessSecret, accessTtl: config.jwt.accessTtl });
  const authService = new AuthService(prisma, jwt, {
    bcryptCost: overrides.bcryptCost,
    refreshTtlDays: config.jwt.refreshTtlDays,
    events: bus,
    logger,
  });
  const tenantResolver = new TenantResolver(new PrismaTenantRepository(prisma), {
    defaultSlug: config.defaultOperatorSlug,
    isProduction: config.isProduction,
    // loadConfig solo conserva DEFAULT_OPERATOR_SLUG en producción si ALLOW_DEFAULT_OPERATOR=true.
    allowDefaultInProduction: Boolean(config.defaultOperatorSlug),
  });
  const guards = createGuards({ jwt, prisma, tenantResolver, rateLimit: overrides.rateLimit });

  // ── Cajero ──
  const review = new ReviewWithdrawalUseCase({ prisma, registry, wallet: walletService, audit, events: bus, logger });
  const handleWebhook = new HandleWebhookUseCase({
    prisma,
    registry,
    wallet: walletService,
    withdrawals: review,
    events: bus,
    logger,
  });
  const createDeposit = new CreateDepositUseCase({ prisma, registry, responsibleGaming: rgPolicy });
  const requestWithdrawal = new RequestWithdrawalUseCase({
    prisma,
    wallet: walletService,
    responsibleGaming: rgPolicy,
    audit,
  });

  // ── HTTP ──
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);
  // Orígenes CORS: CORS_ORIGINS + PUBLIC_WEB_URL + BACKOFFICE_URL; fuera de producción se suman los localhost de desarrollo.
  const corsOrigins = [...new Set([...config.corsOrigins, ...(config.isProduction ? [] : DEV_CORS_ORIGINS)])];
  app.use(securityHeaders({ isProduction: config.isProduction, frameAncestors: corsOrigins }));
  app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));

  // Webhooks: el router lee el cuerpo crudo, por eso va ANTES de express.json.
  app.use('/api/webhooks', createWebhookRouter({ handleWebhook }));
  // captureRawBody guarda el cuerpo crudo en req.rawBody: el Hub verifica el HMAC de /hub/v1/wallet sobre él.
  app.use(express.json({ limit: '100kb', verify: captureRawBody }));

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'up' });
    } catch (err) {
      logger.error('Health check failed', { event: 'HEALTH_DB_ERROR', error: (err as Error).message });
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use(createOperatorRouter({ resolveTenant: guards.resolveTenant, prisma }));
  app.use(createAuthRouter({ ...guards, authService, prisma, wallet: walletService }));
  app.use(createBackofficeAuthRouter({ rateLimit: guards.rateLimit, authService }));
  app.use(
    createPlayerAccountRouter({
      resolveTenant: guards.resolveTenant,
      requirePlayer: guards.requirePlayer,
      requireBackoffice: guards.requireBackoffice,
      rgService,
    }),
  );
  app.use(
    createLedgerAdminRouter({ ...guards, walletService, reconciliationService, prisma }),
  );
  app.use('/api/cashier', createCashierRouter({ ...guards, prisma, registry, createDeposit, requestWithdrawal }));
  app.use('/api/backoffice/withdrawals', createBackofficeWithdrawalRouter({ ...guards, review }));

  // Módulos: se montan en un router propio (registerModules es async) que queda ANTES del 404.
  // Mientras no terminen de montarse, sus peticiones esperan a `ready`.
  const modulesEnabled = overrides.modules ?? config.modules.enabled;
  const modulesRouter = express.Router();
  let modulesReady = !modulesEnabled;
  let readyPromise: Promise<void> = Promise.resolve();
  app.use(async (_req: Request, _res: Response, next: NextFunction) => {
    if (modulesReady) return next();
    try {
      await readyPromise;
      next();
    } catch (e) {
      next(e);
    }
  });
  app.use(modulesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  // ── Juegos + sockets ──
  const httpServer = http.createServer(app);
  const sessions = gameEvents.wrapSessions(new PrismaGameSessionRepository());
  const rng = new CryptoRNGService();
  const socketServer = new SocketServer({
    server: httpServer,
    authMiddleware: createSocketAuthMiddleware({ jwt, prisma }),
    corsOrigins,
    processBetUseCase: new ProcessBetUseCase(gameWallet, rng),
    playSlotsUseCase: new PlaySlotsUseCase(gameWallet, rng),
    startBlackjackHandUseCase: new StartBlackjackHandUseCase(gameWallet, sessions),
    hitBlackjackUseCase: new HitBlackjackUseCase(gameWallet, sessions),
    standBlackjackUseCase: new StandBlackjackUseCase(gameWallet, sessions),
    startMinesUseCase: new StartMinesUseCase(gameWallet, sessions),
    revealMinesUseCase: new RevealMinesUseCase(gameWallet, sessions),
    cashoutMinesUseCase: new CashoutMinesUseCase(gameWallet, sessions),
    placeCrashBetUseCase: new PlaceCrashBetUseCase(gameWallet, sessions),
    cashoutCrashUseCase: new CashoutCrashUseCase(gameWallet, sessions),
    playPlinkoUseCase: new PlayPlinkoUseCase(gameWallet, sessions),
  });
  const io = socketServer.getIO();
  CrashGameEngine.getInstance().initialize(io);

  const moduleServices: Record<string, unknown> = {};
  if (modulesEnabled) {
    const deps = buildModuleDeps({
      prisma,
      walletService,
      jwt,
      rgPolicy,
      bus,
      logger,
      env: { ...config.modules.env, ...(overrides.moduleEnv ?? {}) },
    });
    readyPromise = registerModules(modulesRouter as unknown as Application, io, deps).then((published) => {
      Object.assign(moduleServices, published);
      modulesReady = true;
    });
    // Evita un unhandledRejection: el error se propaga a las peticiones (next(e)) y a quien espere `ready`.
    readyPromise.catch((e: unknown) =>
      logger.error('Nymfo modules failed to mount', { event: 'MODULES_MOUNT_ERROR', error: String(e) }),
    );
  }

  return {
    app,
    httpServer,
    io,
    ready: readyPromise,
    services: {
      prisma,
      walletService,
      reconciliationService,
      registry,
      jwt,
      authService,
      guards,
      tenantResolver,
      bus,
      modules: moduleServices,
    },
    async close() {
      await readyPromise.catch(() => undefined);
      stopModules(moduleServices);
      await bus.drain().catch(() => undefined);
      CrashGameEngine.getInstance().stop();
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Detiene los temporizadores de los módulos (scheduler de marketing, ticks de promociones/gamificación, crash de Studios). */
function stopModules(services: Record<string, unknown>): void {
  const seen = new Set<unknown>();
  for (const svc of Object.values(services)) {
    if (!svc || typeof svc !== 'object' || seen.has(svc)) continue;
    seen.add(svc);
    const stop = (svc as { stop?: unknown }).stop;
    if (typeof stop !== 'function') continue;
    try {
      (stop as () => void).call(svc);
    } catch (e) {
      logger.warn('Module stop failed', { error: String(e) });
    }
  }
}
