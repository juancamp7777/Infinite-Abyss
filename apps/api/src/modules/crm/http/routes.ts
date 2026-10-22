import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { getPrincipal, requireAuth, requirePlayer, requireRole, scopeOperator } from '../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, notFound, sendJson } from '../../shared/http/errors';
import { parse, zPagination } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import { ruleSchema } from '../domain/segments';
import type { CrmProfileService, CrmSegmentService, CrmTicketService, CrmTimelineService } from '../application/services';

export interface CrmRouterDeps {
  auth: AuthPort;
  profiles: CrmProfileService;
  segments: CrmSegmentService;
  timeline: CrmTimelineService;
  tickets: CrmTicketService;
  logger?: ModuleLogger;
}

const opQuery = z.object({ operatorId: z.string().min(1).optional() });
const playerParams = z.object({ playerId: z.string().min(1).max(100) });
const idParams = z.object({ id: z.string().min(1).max(100) });
const priority = z.enum(['low', 'normal', 'high', 'urgent']);

const listQuery = zPagination.extend({
  operatorId: z.string().min(1).optional(),
  q: z.string().max(100).optional(),
  country: z.string().max(8).optional(),
  churnRisk: z.enum(['low', 'medium', 'high']).optional(),
  tag: z.string().max(50).optional(),
  segmentId: z.string().max(100).optional(),
  sort: z.enum(['ltv', 'ggr', 'lastActivityAt', 'registeredAt', 'vipScore']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const tag = z.string().trim().min(1).max(50);

/** Rutas del CRM, a montar en /crm/v1. */
export function createCrmRouter(d: CrmRouterDeps): Router {
  const r = Router();
  const auth = requireAuth(d.auth);
  const admin = [auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);
  const actor = (req: Request) => getPrincipal(req).userId;

  /* ─── Jugador ─── */
  r.post('/tickets', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const body = parse(z.object({ subject: z.string().trim().min(3).max(200), message: z.string().trim().min(1).max(5000), priority: priority.optional() }), req.body);
    sendJson(res, await d.tickets.create(operatorId, playerId, body), 201);
  }));

  r.get('/tickets/mine', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    sendJson(res, { items: await d.tickets.list(operatorId, { playerId }) });
  }));

  /* ─── Admin: jugadores ─── */
  r.get('/admin/players', ...admin, asyncHandler(async (req, res) => {
    const q = parse(listQuery, req.query);
    const operatorId = scopeOperator(req, q.operatorId);
    const { items, total } = await d.profiles.list(operatorId, q, d.segments);
    sendJson(res, { items, total, limit: q.limit, offset: q.offset });
  }));

  r.get('/admin/players/:playerId', ...admin, asyncHandler(async (req, res) => {
    const operatorId = op(req);
    const { playerId } = parse(playerParams, req.params);
    const profile = await d.profiles.getProfile(operatorId, playerId, { compliance: true });
    if (!profile) throw notFound('Jugador no encontrado');
    const [timeline, notes, tickets] = await Promise.all([
      d.timeline.list(operatorId, playerId, 100),
      d.profiles.listNotes(operatorId, playerId),
      d.tickets.list(operatorId, { playerId }),
    ]);
    sendJson(res, { profile, timeline, notes, tickets });
  }));

  r.get('/admin/players/:playerId/timeline', ...admin, asyncHandler(async (req, res) => {
    const { playerId } = parse(playerParams, req.params);
    sendJson(res, { items: await d.timeline.list(op(req), playerId, 200) });
  }));

  r.get('/admin/players/:playerId/notes', ...admin, asyncHandler(async (req, res) => {
    const { playerId } = parse(playerParams, req.params);
    sendJson(res, { items: await d.profiles.listNotes(op(req), playerId) });
  }));

  r.post('/admin/players/:playerId/notes', ...admin, asyncHandler(async (req, res) => {
    const { playerId } = parse(playerParams, req.params);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(5000) }), req.body);
    sendJson(res, await d.profiles.addNote(op(req), playerId, actor(req), text), 201);
  }));

  r.post('/admin/players/:playerId/tags', ...admin, asyncHandler(async (req, res) => {
    const { playerId } = parse(playerParams, req.params);
    const body = parse(z.object({ tag }), req.body);
    sendJson(res, { tags: await d.profiles.addTag(op(req), playerId, body.tag, actor(req)) }, 201);
  }));

  r.delete('/admin/players/:playerId/tags/:tag', ...admin, asyncHandler(async (req, res) => {
    const { playerId } = parse(playerParams, req.params);
    const t = parse(z.object({ tag }), { tag: req.params.tag });
    sendJson(res, { tags: await d.profiles.removeTag(op(req), playerId, t.tag, actor(req)) });
  }));

  /* ─── Admin: segmentos ─── */
  const segBody = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional(), rule: ruleSchema });

  r.get('/admin/segments', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, { items: await d.segments.list(op(req)) });
  }));

  r.post('/admin/segments', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, await d.segments.create(op(req), parse(segBody, req.body), actor(req)), 201);
  }));

  // /preview debe ir antes de /:id
  r.post('/admin/segments/preview', ...admin, asyncHandler(async (req, res) => {
    const { rule } = parse(z.object({ rule: ruleSchema }), req.body);
    sendJson(res, await d.segments.preview(op(req), rule));
  }));

  r.get('/admin/segments/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const operatorId = op(req);
    const seg = await d.segments.get(operatorId, id);
    sendJson(res, { ...seg, ...(await d.segments.preview(operatorId, seg.rule)) });
  }));

  r.put('/admin/segments/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(segBody.partial(), req.body);
    sendJson(res, await d.segments.update(op(req), id, patch));
  }));

  r.delete('/admin/segments/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await d.segments.remove(op(req), id);
    res.status(204).end();
  }));

  r.get('/admin/segments/:id/members', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { limit, offset } = parse(zPagination, req.query);
    const operatorId = op(req);
    const seg = await d.segments.get(operatorId, id);
    const members = await d.segments.match(operatorId, seg.rule);
    sendJson(res, { total: members.length, limit, offset, items: members.slice(offset, offset + limit) });
  }));

  /* ─── Admin: tickets ─── */
  r.get('/admin/tickets', ...admin, asyncHandler(async (req, res) => {
    const f = parse(z.object({ status: z.enum(['open', 'pending', 'closed']).optional(), playerId: z.string().optional(), assignedTo: z.string().optional() }), req.query);
    sendJson(res, { items: await d.tickets.list(op(req), f) });
  }));

  r.get('/admin/tickets/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.tickets.get(op(req), id));
  }));

  r.post('/admin/tickets/:id/messages', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(5000) }), req.body);
    sendJson(res, await d.tickets.addMessage(op(req), id, { type: 'agent', id: actor(req) }, text), 201);
  }));

  r.patch('/admin/tickets/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(z.object({ status: z.enum(['open', 'pending', 'closed']).optional(), priority: priority.optional(), assignedTo: z.string().min(1).max(100).nullable().optional() }), req.body);
    sendJson(res, await d.tickets.update(op(req), id, patch));
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
