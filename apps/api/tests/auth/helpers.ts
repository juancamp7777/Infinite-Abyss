import express, { type Express } from 'express';
import { prisma } from '../../src/infrastructure/database/prisma';
import { JwtService } from '../../src/infrastructure/auth/JwtService';
import { AuthService } from '../../src/application/auth/AuthService';
import { TenantResolver } from '../../src/application/tenancy/TenantResolver';
import { PrismaTenantRepository } from '../../src/infrastructure/tenancy/PrismaTenantRepository';
import { createGuards } from '../../src/infrastructure/http/middlewares';
import { errorHandler } from '../../src/infrastructure/http/middlewares';
import { createAuthRouter } from '../../src/infrastructure/http/routes/authRoutes';
import { createBackofficeAuthRouter } from '../../src/infrastructure/http/routes/backofficeAuthRoutes';
import { createOperatorRouter } from '../../src/infrastructure/http/routes/operatorRoutes';
import { createPlayerAccountRouter } from '../../src/infrastructure/http/routes/playerAccountRoutes';
import { ResponsibleGamingService } from '../../src/application/responsible-gaming/ResponsibleGamingService';
import { PrismaAuditLogger } from '../../src/infrastructure/auth/PrismaAuditLogger';
import type { RateLimitOptions } from '../../src/infrastructure/http/middlewares';

export function buildJwt(): JwtService {
  return new JwtService({ secret: process.env.JWT_ACCESS_SECRET!, accessTtl: '15m' });
}

export interface TestHarness {
  app: Express;
  jwt: JwtService;
  authService: AuthService;
  resolver: TenantResolver;
}

/** Express mínimo con los routers de s3 y rate limit desactivado salvo que se pase otra cosa. */
export function buildApp(opts: { rateLimit?: RateLimitOptions; defaultSlug?: string } = {}): TestHarness {
  const jwt = buildJwt();
  const resolver = new TenantResolver(new PrismaTenantRepository(prisma), {
    defaultSlug: opts.defaultSlug,
    cacheTtlMs: 0,
  });
  const guards = createGuards({ jwt, prisma, tenantResolver: resolver, rateLimit: opts.rateLimit ?? { disabled: true } });
  const authService = new AuthService(prisma, jwt, { bcryptCost: 4, refreshTtlDays: 30 });
  const rgService = new ResponsibleGamingService(prisma, new PrismaAuditLogger(prisma));
  const wallet = { getBalances: async () => ({ currency: 'USD', cash: 0n, bonus: 0n }) };

  const app = express();
  app.use(express.json());
  app.use(createOperatorRouter({ prisma, resolveTenant: guards.resolveTenant }));
  app.use(createAuthRouter({ ...guards, authService, prisma, wallet }));
  app.use(createBackofficeAuthRouter({ rateLimit: guards.rateLimit, authService }));
  app.use(createPlayerAccountRouter({ ...guards, rgService }));
  // Ruta de prueba protegida por operador (para aislamiento backoffice).
  app.get('/test/operators/:operatorId/ping', guards.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN']), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/test/player-ping', guards.resolveTenant, guards.requirePlayer, (req, res) => {
    res.json({ userId: req.player!.userId });
  });
  app.use(errorHandler);
  return { app, jwt, authService, resolver };
}
