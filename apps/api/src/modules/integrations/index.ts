import { randomBytes } from 'crypto';
import { Router, type Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getPrincipal, requireAuth, requireRole, scopeOperator } from '../shared/http/auth';
import { asyncHandler, HttpError, moduleErrorHandler, sendJson } from '../shared/http/errors';
import { parse } from '../shared/http/validate';
import type { NymfoModule } from '../shared/module';
import { SecretBox } from '../inbox/domain/secretBox';
import { IntegrationService, type Scope } from './application/IntegrationService';

export const INTEGRATIONS_PREFIX = '/integrations/v1';

/**
 * Integraciones: una sola pantalla para conectar IA, proveedores de juegos, pagos y alertas. Las credenciales se guardan
 * cifradas, nunca vuelven completas al navegador y se prueban contra el servicio real. Va primero en ALL_MODULES para
 * que el Hub arranque con los proveedores ya conectados. Servicio: 'integrations.service' (IntegrationsPort).
 */
export function createIntegrationsModule(opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): NymfoModule {
  return {
    name: 'integrations',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[integrations] sin base de datos: las integraciones se leen solo del entorno');
        return {};
      }
      let key = deps.env.INBOX_SECRETS_KEY;
      if (!key) {
        key = randomBytes(32).toString('hex');
        deps.logger.warn('[integrations] INBOX_SECRETS_KEY no definido: las credenciales guardadas no sobrevivirán un reinicio');
      }
      const svc = new IntegrationService(deps.prisma as PrismaClient, new SecretBox(key), { logger: deps.logger, services: deps.services, fetch: opts.fetch });

      const r = Router();
      r.use(requireAuth(deps.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN'));
      const scopeOf = (req: Request): Scope => {
        const q = parse(z.object({ scope: z.enum(['platform', 'operator']).default('operator'), operatorId: z.string().min(1).max(100).optional() }), req.query);
        if (q.scope === 'platform') {
          if (getPrincipal(req).role !== 'PLATFORM_ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Solo la plataforma conecta integraciones globales');
          return { kind: 'platform' };
        }
        return { kind: 'operator', operatorId: scopeOperator(req, q.operatorId) };
      };
      const keyParam = (req: Request) => parse(z.object({ key: z.string().regex(/^[a-z0-9-]{2,40}$/) }), req.params).key;

      r.get('/admin/catalog', (_req, res) => sendJson(res, { items: svc.catalog() }));
      r.get('/admin/list', asyncHandler(async (req, res) => sendJson(res, { items: await svc.list(scopeOf(req)) })));
      r.put('/admin/:key', asyncHandler(async (req, res) => {
        const body = parse(z.object({ values: z.record(z.string(), z.union([z.string().max(4000), z.null()])) }).passthrough(), req.body);
        sendJson(res, await svc.save(scopeOf(req), keyParam(req), body.values, getPrincipal(req).userId));
      }));
      r.delete('/admin/:key', asyncHandler(async (req, res) => {
        await svc.remove(scopeOf(req), keyParam(req));
        res.status(204).end();
      }));
      r.post('/admin/:key/test', asyncHandler(async (req, res) => sendJson(res, await svc.test(scopeOf(req), keyParam(req)))));
      r.use(moduleErrorHandler(deps.logger));
      app.use(INTEGRATIONS_PREFIX, r);
      return { 'integrations.service': svc };
    },
  };
}

export const integrationsModule = createIntegrationsModule();
