import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import type { OperatorCurrencyPort } from '../../shared/ports/OperatorCurrencyPort';
import { getPrincipal, optionalAuth, requireAuth, requireRole, scopeOperator } from '../../shared/http/auth';
import { HttpError, asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { ChannelService } from '../application/ChannelService';
import type { ContactIdentity, InboxService } from '../application/InboxService';
import type { LeadService } from '../application/LeadService';
import { STAGES, type Message } from '../domain/types';

export interface InboxRouterDeps {
  auth: AuthPort;
  svc: InboxService;
  channels: ChannelService;
  leads?: LeadService;
  operators?: OperatorCurrencyPort;
  logger?: ModuleLogger;
  /** Sesiones de visitante por IP y minuto (antiabuso del endpoint público). */
  sessionsPerMinute?: number;
}

const opQuery = z.object({ operatorId: z.string().min(1).max(100).optional() });
const idParams = z.object({ id: z.string().uuid() });
const body = z.string().max(8000);
const listQuery = opQuery.extend({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  stage: z.enum(STAGES).optional(),
  assignee: z.string().min(1).max(100).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Vista del contacto: sin notas (ya filtradas) ni ids internos de agentes. */
export const publicMessage = (m: Message) => ({ id: m.id, direction: m.direction, authorType: m.authorType, body: m.body, clientMsgId: m.clientMsgId, hasAttachment: !!m.attachmentId, createdAt: m.createdAt });

/** Identidad del contacto del webchat: jugador (token) o visitante (cabecera X-Visitor-Token). */
export async function resolveContact(svc: InboxService, p: Request['principal'] | null | undefined, visitorToken: unknown): Promise<ContactIdentity | null> {
  if (p?.role === 'PLAYER' && p.operatorId && p.playerId) {
    return { operatorId: p.operatorId, channel: 'webchat', externalId: `player:${p.playerId}`, playerId: p.playerId, name: `Jugador ${p.playerId.slice(0, 8)}` };
  }
  if (typeof visitorToken === 'string' && visitorToken.length >= 20 && visitorToken.length <= 200) {
    const v = await svc.visitorByToken(visitorToken);
    if (v) return { operatorId: v.operatorId, channel: 'webchat', externalId: `visitor:${v.id}`, name: v.name };
  }
  return null;
}

/**
 * Montado en /inbox/v1.
 * Agentes (backoffice): /admin/conversations…, /admin/quick-replies…
 * Webchat público: POST /webchat/session, GET /webchat/conversation, POST /webchat/messages.
 */
export function buildInboxRouter(d: InboxRouterDeps): Router {
  const r = Router();
  const admin = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);

  /* ─── Webchat (contacto) ─── */
  const hits = new Map<string, number[]>();
  r.post('/webchat/session', asyncHandler(async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= (d.sessionsPerMinute ?? 10)) throw new HttpError(429, 'RATE_LIMITED', 'Demasiadas sesiones; espera un momento');
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 50_000) hits.delete(hits.keys().next().value as string);
    const b = parse(z.object({ operatorId: z.string().min(1).max(100), name: z.string().max(60).optional() }), req.body);
    if (d.operators && !(await d.operators.getCurrencyInfo(b.operatorId))) throw new HttpError(404, 'NOT_FOUND', 'Operador no encontrado');
    sendJson(res, await d.svc.createVisitor(b.operatorId, b.name), 201);
  }));

  const contact = async (req: Request): Promise<ContactIdentity> => {
    const c = await resolveContact(d.svc, req.principal, req.get('x-visitor-token'));
    if (!c) throw new HttpError(401, 'UNAUTHORIZED', 'Inicia sesión o abre una sesión de chat');
    return c;
  };

  r.get('/webchat/conversation', optionalAuth(d.auth), asyncHandler(async (req, res) => {
    const q = parse(z.object({ after: z.coerce.date().optional() }), req.query);
    const conv = await d.svc.findFor(await contact(req));
    const messages = conv ? await d.svc.contactMessages(conv, q.after) : [];
    sendJson(res, { conversation: conv ? { id: conv.id, status: conv.status } : null, messages: messages.map(publicMessage) });
  }));

  r.post('/webchat/messages', optionalAuth(d.auth), asyncHandler(async (req, res) => {
    const b = parse(z.object({ body, clientMsgId: z.string().min(1).max(64).optional() }), req.body);
    const conv = await d.svc.conversationFor(await contact(req));
    sendJson(res, publicMessage(await d.svc.contactMessage(conv, b.body, b.clientMsgId)), 201);
  }));

  /** Imagen del contacto (cuerpo binario; el tipo real se valida por firma). */
  r.post('/webchat/attachments', optionalAuth(d.auth), express.raw({ type: () => true, limit: '6mb' }), asyncHandler(async (req, res) => {
    const q = parse(z.object({ clientMsgId: z.string().min(1).max(64).optional(), caption: z.string().max(500).optional() }), req.query);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'BAD_REQUEST', 'Falta la imagen');
    const conv = await d.svc.conversationFor(await contact(req));
    sendJson(res, publicMessage(await d.svc.contactAttachment(conv, req.body, q.caption, q.clientMsgId)), 201);
  }));

  /* ─── Webhooks de canales (WhatsApp Cloud, Telegram) ─── */
  const webhook = asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const out = await d.channels.webhook(id, { method: req.method, headers: req.headers, query: req.query as Record<string, unknown>, rawBody: Buffer.isBuffer(raw) ? raw : Buffer.alloc(0), body: req.body });
    if (typeof out === 'string') res.type('text/plain').send(out);
    else sendJson(res, out);
  });
  r.get('/channels/:id/webhook', webhook);
  r.post('/channels/:id/webhook', webhook);

  /* ─── Agentes ─── */
  r.get('/admin/conversations', ...admin, asyncHandler(async (req, res) => {
    const q = parse(listQuery, req.query);
    const operatorId = op(req);
    const assigneeId = q.assignee === 'me' ? getPrincipal(req).userId : q.assignee === 'unassigned' ? null : q.assignee;
    sendJson(res, { items: await d.svc.list(operatorId, { status: q.status, stage: q.stage, assigneeId, q: q.q || undefined, limit: q.limit }), me: getPrincipal(req).userId });
  }));

  r.get('/admin/conversations/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.svc.get(op(req), id));
  }));

  r.post('/admin/conversations/:id/messages', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ body, kind: z.enum(['reply', 'note']).default('reply') }), req.body);
    sendJson(res, await d.svc.agentMessage(op(req), id, getPrincipal(req).userId, b.body, b.kind), 201);
  }));

  r.patch('/admin/conversations/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ status: z.enum(['open', 'pending', 'closed']).optional(), stage: z.enum(STAGES).optional(), assigneeId: z.string().min(1).max(100).nullable().optional() }), req.body);
    // "me" = el agente autenticado.
    const assigneeId = b.assigneeId === 'me' ? getPrincipal(req).userId : b.assigneeId;
    sendJson(res, await d.svc.update(op(req), id, { status: b.status, stage: b.stage, assigneeId }));
  }));

  r.post('/admin/conversations/:id/read', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    sendJson(res, await d.svc.markRead(op(req), id));
  }));

  /** Jugador de la conversación: crear la cuenta del lead o vincular una existente (identidad verificada por el agente). */
  r.post('/admin/conversations/:id/player', ...admin, asyncHandler(async (req, res) => {
    if (!d.leads) throw new HttpError(503, 'UNAVAILABLE', 'Alta de cuentas no disponible');
    const { id } = parse(idParams, req.params);
    const b = parse(z.union([z.object({ create: z.literal(true) }), z.object({ playerId: z.string().min(1).max(100) })]), req.body);
    sendJson(res, 'create' in b ? await d.leads.createFor(op(req), id) : await d.leads.linkExisting(op(req), id, b.playerId), 201);
  }));

  r.get('/admin/attachments/:id', ...admin, asyncHandler(async (req, res) => {
    const a = await d.svc.attachment(op(req), parse(idParams, req.params).id);
    res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' }).send(a.data);
  }));

  r.post('/admin/conversations/:id/messages/:messageId/retry', ...admin, asyncHandler(async (req, res) => {
    const { id, messageId } = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), req.params);
    sendJson(res, await d.svc.retryDelivery(op(req), id, messageId));
  }));

  /* ─── Canales (solo administradores) ─── */
  const owners = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const channelBody = z.object({ type: z.enum(['whatsapp', 'telegram']), name: z.string().max(80).default(''), config: z.record(z.string(), z.unknown()) });
  r.get('/admin/channels', ...owners, asyncHandler(async (req, res) => {
    sendJson(res, { items: await d.channels.list(op(req)) });
  }));
  r.post('/admin/channels', ...owners, asyncHandler(async (req, res) => {
    const b = parse(channelBody, req.body);
    sendJson(res, await d.channels.create(op(req), b.type, b.name, b.config), 201);
  }));
  r.patch('/admin/channels/:id', ...owners, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ name: z.string().max(80).optional(), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
    sendJson(res, await d.channels.update(op(req), id, b));
  }));
  r.delete('/admin/channels/:id', ...owners, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await d.channels.remove(op(req), id);
    sendJson(res, { ok: true });
  }));

  const qr = z.object({ shortcut: z.string().trim().toLowerCase(), body });
  r.get('/admin/quick-replies', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, { items: await d.svc.quickReplies(op(req)) });
  }));
  r.post('/admin/quick-replies', ...admin, asyncHandler(async (req, res) => {
    const b = parse(qr, req.body);
    sendJson(res, await d.svc.saveQuickReply(op(req), b.shortcut, b.body), 201);
  }));
  r.put('/admin/quick-replies/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(qr, req.body);
    sendJson(res, await d.svc.saveQuickReply(op(req), b.shortcut, b.body, id));
  }));
  r.delete('/admin/quick-replies/:id', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    if (!(await d.svc.deleteQuickReply(op(req), id))) throw new HttpError(404, 'NOT_FOUND', 'Respuesta rápida no encontrada');
    sendJson(res, { ok: true });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
