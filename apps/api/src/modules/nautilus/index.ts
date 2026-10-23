import { Router, type Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getPrincipal, requireAuth, requireRole, scopeOperator } from '../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../shared/http/errors';
import { parse } from '../shared/http/validate';
import type { NymfoModule } from '../shared/module';
import type { IntegrationsPort } from '../shared/ports/IntegrationsPort';
import { NautilusService } from './application/NautilusService';
import { defaultBrainFactory, type BrainFactory } from './infrastructure/brain';

export const NAUTILUS_PREFIX = '/nautilus/v1';

/**
 * Nautilus, el operador IA: vigilantes cada 5 min, alertas graves por Telegram, resumen diario con Claude y
 * «Pregúntale a Nautilus» con herramientas de solo lectura. La llave de Claude sale de Integraciones.
 */
export function createNautilusModule(opts: { brainFactory?: BrainFactory; tickMs?: number; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {}): NymfoModule {
  return {
    name: 'nautilus',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[nautilus] sin base de datos: Nautilus no se monta');
        return {};
      }
      const svc = new NautilusService(deps.prisma as PrismaClient, {
        logger: deps.logger,
        integrations: () => deps.services['integrations.service'] as IntegrationsPort | undefined,
        brainFactory: opts.brainFactory ?? defaultBrainFactory,
        envKey: deps.env.NAUTILUS_ANTHROPIC_API_KEY || deps.env.ANTHROPIC_API_KEY || undefined,
        reportHour: Number(deps.env.NAUTILUS_REPORT_HOUR) || 8,
        fetch: opts.fetch,
      });

      const r = Router();
      const viewers = [requireAuth(deps.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];
      const admins = [requireAuth(deps.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
      const op = (req: Request) => scopeOperator(req, parse(z.object({ operatorId: z.string().min(1).max(100).optional() }), req.query).operatorId);
      const idParam = (req: Request) => parse(z.object({ id: z.string().uuid() }), req.params).id;

      r.get('/admin/findings', ...viewers, asyncHandler(async (req, res) => {
        const q = parse(z.object({ status: z.enum(['open', 'acknowledged', 'resolved']).optional() }).passthrough(), req.query);
        sendJson(res, { items: await svc.findings(op(req), q.status) });
      }));
      r.post('/admin/findings/:id/ack', ...viewers, asyncHandler(async (req, res) => {
        await svc.setStatus(op(req), idParam(req), 'acknowledged', getPrincipal(req).userId);
        res.status(204).end();
      }));
      r.post('/admin/findings/:id/resolve', ...viewers, asyncHandler(async (req, res) => {
        await svc.setStatus(op(req), idParam(req), 'resolved', getPrincipal(req).userId);
        res.status(204).end();
      }));
      r.post('/admin/scan', ...viewers, asyncHandler(async (req, res) => sendJson(res, await svc.scan(op(req)))));
      r.get('/admin/reports', ...admins, asyncHandler(async (req, res) => sendJson(res, { items: await svc.reports(op(req)) })));
      r.post('/admin/reports/generate', ...admins, asyncHandler(async (req, res) => sendJson(res, await svc.report(op(req), true))));
      r.post('/admin/ask', ...admins, asyncHandler(async (req, res) => {
        const b = parse(z.object({ question: z.string().trim().min(3).max(1000) }), req.body);
        sendJson(res, { answer: await svc.ask(op(req), b.question) });
      }));
      r.use(moduleErrorHandler(deps.logger));
      app.use(NAUTILUS_PREFIX, r);

      const tickMs = opts.tickMs ?? Number(deps.env.NAUTILUS_TICK_MS ?? 5 * 60_000);
      if (tickMs > 0 && deps.env.NODE_ENV !== 'test') {
        let running = false;
        const run = () => {
          if (running) return;
          running = true;
          void svc.tick().finally(() => { running = false; });
        };
        setTimeout(run, 30_000).unref();
        setInterval(run, tickMs).unref();
      }
      return { 'nautilus.service': svc };
    },
  };
}

export const nautilusModule = createNautilusModule();
