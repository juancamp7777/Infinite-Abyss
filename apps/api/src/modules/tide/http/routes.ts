import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { getPrincipal, requireAuth, requireRole, scopeOperator } from '../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { FlowService } from '../application/FlowService';
import { NODE_CATALOG } from '../domain/nodes';

const opQuery = z.object({ operatorId: z.string().min(1).max(100).optional() });
const idParams = z.object({ id: z.string().uuid() });

/** Montado en /tide/v1. Solo administradores del operador. */
export function buildTideRouter(d: { auth: AuthPort; flows: FlowService; logger?: ModuleLogger }): Router {
  const r = Router();
  const admin = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);

  r.get('/admin/node-types', ...admin, (_req, res) => sendJson(res, { items: NODE_CATALOG }));

  r.get('/admin/flows', ...admin, asyncHandler(async (req, res) => {
    const items = (await d.flows.list(op(req))).map(({ draft, ...f }) => ({ ...f, nodes: draft.nodes.length }));
    sendJson(res, { items });
  }));
  r.post('/admin/flows', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ name: z.string().max(80).default(''), template: z.enum(['blank', 'welcome']).default('welcome') }), req.body);
    sendJson(res, await d.flows.create(op(req), b.name, b.template), 201);
  }));
  r.get('/admin/flows/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.flows.get(op(req), id));
  }));
  r.put('/admin/flows/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ name: z.string().max(80).optional(), draft: z.unknown().optional() }), req.body);
    sendJson(res, await d.flows.saveDraft(op(req), id, b));
  }));
  r.post('/admin/flows/:id/validate', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, { errors: await d.flows.validate(op(req), id) });
  }));
  r.post('/admin/flows/:id/publish', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.flows.publish(op(req), id, getPrincipal(req).userId));
  }));
  r.patch('/admin/flows/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ enabled: z.boolean() }), req.body);
    sendJson(res, await d.flows.setEnabled(op(req), id, b.enabled));
  }));
  r.delete('/admin/flows/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await d.flows.remove(op(req), id);
    sendJson(res, { ok: true });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
