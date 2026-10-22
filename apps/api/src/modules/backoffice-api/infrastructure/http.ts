import express, { type Router } from 'express';
import { z } from 'zod';
import { devToken } from '../../shared/adapters/MockAuth';
import { asyncHandler, badRequest, moduleErrorHandler, notFound, sendJson } from '../../shared/http/errors';
import { requireAuth, requireRole, scopeOperator, scopeOperatorOptional } from '../../shared/http/auth';
import { parse } from '../../shared/http/validate';
import type { ModuleDeps } from '../../shared/module';
import { DashboardService, normalizeRange } from '../application/DashboardService';
import { isReportType, ReportService, REPORT_TYPES } from '../application/ReportService';
import { DEFAULT_SKIN, skinInputSchema, toSkin } from '../application/skins';
import type { SkinPort } from '../domain/types';

export interface BackofficeRouterDeps {
  deps: ModuleDeps;
  dashboard: DashboardService;
  reports: ReportService;
  skins: SkinPort;
  clock: () => Date;
}

const OP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const opId = z.string().regex(OP_ID, 'operatorId inválido');
const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional(), operatorId: opId.optional() });
const loginBody = z.object({
  role: z.enum(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT']),
  operatorId: opId.optional(),
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
});

export function createBackofficeRouter(d: BackofficeRouterDeps): Router {
  const router = express.Router();
  router.use(express.json({ limit: '200kb' }));
  const auth = requireAuth(d.deps.auth);
  const admins = requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN');

  // --- Login mock de desarrollo (nunca en producción) ---
  router.post(
    '/dev/login',
    asyncHandler((req, res) => {
      if (d.deps.env.NODE_ENV === 'production') throw notFound();
      const b = parse(loginBody, req.body ?? {});
      let operatorId = b.operatorId;
      if (b.role === 'PLATFORM_ADMIN') operatorId = operatorId ?? '*';
      else if (!operatorId) throw badRequest('operatorId es obligatorio para este rol');
      const token = devToken(b.role, operatorId!, b.id ?? `bo-${b.role.toLowerCase()}`);
      sendJson(res, { token, role: b.role, operatorId: operatorId === '*' ? null : operatorId });
    }),
  );

  // --- Dashboard ---
  router.get(
    '/dashboard',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const q = parse(rangeQuery, req.query);
      const operatorId = scopeOperatorOptional(req, q.operatorId);
      try {
        sendJson(res, await d.dashboard.dashboard(operatorId, q.from, q.to));
      } catch (e) {
        if (e instanceof RangeError) throw badRequest(e.message);
        throw e;
      }
    }),
  );

  // --- Skins ---
  router.get(
    '/public/skin',
    asyncHandler(async (req, res) => {
      const q = parse(z.object({ operatorId: opId }), req.query);
      const skin = (await d.skins.get(q.operatorId)) ?? DEFAULT_SKIN;
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      sendJson(res, skin);
    }),
  );

  router.get(
    '/admin/skins/:operatorId',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, parse(opId, req.params.operatorId));
      sendJson(res, (await d.skins.get(op)) ?? DEFAULT_SKIN);
    }),
  );

  router.put(
    '/admin/skins/:operatorId',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, parse(opId, req.params.operatorId));
      const input = parse(skinInputSchema, req.body ?? {});
      let skin;
      try {
        skin = toSkin(input);
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : 'Skin inválida');
      }
      sendJson(res, await d.skins.update(op, skin));
    }),
  );

  // --- Moneda del operador (el backoffice la usa para formatear montos; cualquier rol, siempre en su alcance) ---
  router.get(
    '/admin/operators/:operatorId/currency',
    auth,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, parse(opId, req.params.operatorId));
      const info = await d.deps.operators?.getCurrencyInfo(op);
      if (!info) throw notFound('Operador desconocido');
      sendJson(res, { operatorId: op, defaultCurrency: info.defaultCurrency, currencies: info.currencies });
    }),
  );

  // --- Reportes CSV ---
  router.get(
    '/admin/reports/:type.csv',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const type = String(req.params.type);
      if (!isReportType(type)) throw badRequest(`Reporte desconocido. Tipos: ${REPORT_TYPES.join(', ')}`);
      const q = parse(rangeQuery, req.query);
      const operatorId = scopeOperatorOptional(req, q.operatorId);
      let range;
      try {
        range = normalizeRange(q.from, q.to, d.clock());
      } catch (e) {
        throw badRequest(e instanceof Error ? e.message : 'Rango inválido');
      }
      const csv = await d.reports.csv(type, { ...(operatorId ? { operatorId } : {}), ...range });
      res
        .status(200)
        .set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${type}-${range.from}_${range.to}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        .send(csv);
    }),
  );

  router.use(moduleErrorHandler(d.deps.logger));
  return router;
}
