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

/** Límites del casino en unidades mínimas de su moneda ("" = sin límite). */
const LIMIT_KEYS = ['minBet', 'maxBet', 'minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal', 'maxDailyWithdrawal'] as const;
const limitValue = z.union([z.string().regex(/^\d{1,15}$/, 'Monto inválido'), z.literal('')]);
const limitsBody = z
  .object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitValue.optional()])) as Record<(typeof LIMIT_KEYS)[number], z.ZodOptional<typeof limitValue>>)
  .strict()
  .superRefine((b, ctx) => {
    for (const [min, max] of [['minBet', 'maxBet'], ['minDeposit', 'maxDeposit'], ['minWithdrawal', 'maxWithdrawal']] as const) {
      const lo = b[min];
      const hi = b[max];
      if (lo && hi && BigInt(lo) > BigInt(hi)) ctx.addIssue({ code: 'custom', path: [min], message: 'El mínimo no puede superar al máximo' });
    }
  });
type OperatorDb = {
  operator: {
    findUnique(a: { where: { id: string }; select: { limits: true; defaultCurrency: true } }): Promise<{ limits: unknown; defaultCurrency: string } | null>;
    update(a: { where: { id: string }; data: { limits: object } }): Promise<unknown>;
  };
};
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

  // --- Límites del casino: apuesta, depósito y retiro mínimos y máximos (Operator.limits) ---
  const db = () => d.deps.prisma as OperatorDb | undefined;
  const pickLimits = (raw: unknown) => {
    const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return Object.fromEntries(LIMIT_KEYS.map((k) => [k, typeof l[k] === 'string' || typeof l[k] === 'number' ? String(l[k]) : ''])) as Record<string, string>;
  };
  router.get(
    '/admin/limits/:operatorId',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, parse(opId, req.params.operatorId));
      const row = await db()?.operator.findUnique({ where: { id: op }, select: { limits: true, defaultCurrency: true } });
      if (!row) throw notFound('Operador no encontrado');
      sendJson(res, { currency: row.defaultCurrency, limits: pickLimits(row.limits) });
    }),
  );
  router.put(
    '/admin/limits/:operatorId',
    auth,
    admins,
    asyncHandler(async (req, res) => {
      const op = scopeOperator(req, parse(opId, req.params.operatorId));
      const b = parse(limitsBody, req.body ?? {});
      const row = await db()?.operator.findUnique({ where: { id: op }, select: { limits: true, defaultCurrency: true } });
      if (!row) throw notFound('Operador no encontrado');
      // Se conservan las demás claves (p. ej. betPresets); "" borra el límite.
      const next: Record<string, unknown> = { ...((row.limits && typeof row.limits === 'object' ? row.limits : {}) as Record<string, unknown>) };
      for (const k of LIMIT_KEYS) {
        if (b[k] === undefined) continue;
        if (b[k] === '') delete next[k];
        else next[k] = b[k];
      }
      await db()!.operator.update({ where: { id: op }, data: { limits: next } });
      // Pearl (recargas por comprobante) usa el mismo depósito mínimo.
      const pearl = d.deps.services['pearl.service'] as { updateSettings(op: string, p: { minAmount: bigint }): Promise<unknown> } | undefined;
      if (b.minDeposit && pearl) await pearl.updateSettings(op, { minAmount: BigInt(b.minDeposit) }).catch(() => undefined);
      sendJson(res, { currency: row.defaultCurrency, limits: pickLimits(next) });
    }),
  );

  // --- Operadores por nombre para el selector de la plataforma (solo PLATFORM_ADMIN) ---
  router.get(
    '/admin/operators',
    auth,
    requireRole('PLATFORM_ADMIN'),
    asyncHandler(async (_req, res) => {
      sendJson(res, { items: (await d.deps.operators?.list?.()) ?? [] });
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
