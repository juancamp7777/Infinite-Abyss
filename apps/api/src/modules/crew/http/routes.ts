import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { getPrincipal, requireAuth, requireRole, scopeOperator } from '../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { AscendService } from '../application/AscendService';
import type { CrewService } from '../application/CrewService';

const opQuery = z.object({ operatorId: z.string().min(1).max(100).optional() });
const idParams = z.object({ id: z.string().uuid() });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const money = z.union([z.string().regex(/^\d{1,18}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const date = z.coerce.date();

/**
 * Montado en /crew/v1.
 * /me/*: cualquier persona del equipo (su usuario de backoffice vinculado). /admin/*: administradores del operador.
 */
export function buildCrewRouter(d: { auth: AuthPort; crew: CrewService; ascend: AscendService; logger?: ModuleLogger }): Router {
  const r = Router();
  const staff = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];
  const admin = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);
  const me = async (req: Request) => {
    const operatorId = op(req);
    return { operatorId, member: await d.crew.me(operatorId, getPrincipal(req).userId) };
  };

  r.post('/me/join', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.crew.joinSelf(op(req), getPrincipal(req).userId), 201)));

  /* ─── Mi turno (personal) ─── */
  r.get('/me', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    const now = new Date();
    const [open] = (await d.crew.live(operatorId)).filter((s) => s.memberId === member.id);
    const shifts = await d.crew.listShifts(operatorId, new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 7 * 86_400_000), member.id);
    sendJson(res, { member, session: open ?? null, shifts });
  }));
  r.post('/me/clock-in', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    const b = parse(z.object({ extra: z.boolean().default(false) }), req.body ?? {});
    sendJson(res, await d.crew.clockIn(operatorId, member.id, b.extra), 201);
  }));
  r.post('/me/pause', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, await d.crew.pause(operatorId, member.id));
  }));
  r.post('/me/resume', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, await d.crew.resume(operatorId, member.id));
  }));
  r.post('/me/clock-out', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, await d.crew.clockOut(operatorId, member.id));
  }));
  r.get('/me/checklist', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, await d.crew.myChecklist(operatorId, member.id));
  }));
  r.post('/me/checklist/:id', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    const b = parse(z.object({ done: z.boolean() }), req.body);
    sendJson(res, await d.crew.markChecklist(operatorId, member.id, parse(idParams, req.params).id, b.done));
  }));
  r.get('/me/tasks', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, { items: await d.crew.listTasks(operatorId, { assigneeId: member.id }) });
  }));
  r.patch('/me/tasks/:id', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    const b = parse(z.object({ status: z.enum(['todo', 'doing', 'done']) }), req.body);
    sendJson(res, await d.crew.updateTask(operatorId, parse(idParams, req.params).id, b, member.id));
  }));
  r.get('/me/announcements', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, { items: await d.crew.myAnnouncements(operatorId, member.id) });
  }));
  r.post('/me/announcements/:id/ack', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    await d.crew.ackAnnouncement(operatorId, member.id, parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));

  /* ─── Ascend (gamificación del equipo) ─── */
  r.get('/me/ascend', ...staff, asyncHandler(async (req, res) => {
    const { operatorId, member } = await me(req);
    sendJson(res, await d.ascend.profile(operatorId, member.id));
  }));
  r.get('/leaderboard', ...staff, asyncHandler(async (req, res) => {
    const q = parse(z.object({ period: z.enum(['week', 'month', 'all']).default('week') }), req.query);
    sendJson(res, { items: await d.ascend.leaderboard(op(req), q.period) });
  }));

  /* ─── Gestión (administradores) ─── */
  const memberBody = z.object({
    name: z.string().trim().min(2).max(80), role: z.string().trim().min(2).max(40), team: z.string().trim().max(40).nullable().optional(),
    backofficeUserId: z.string().uuid().nullable().optional(), timezone: z.string().max(60).optional(), payType: z.enum(['monthly', 'hourly']).optional(),
    baseAmount: money.optional(), currency: z.string().regex(/^[A-Z]{3,5}$/), dayOff: z.number().int().min(0).max(6).nullable().optional(), active: z.boolean().optional(),
  });
  r.get('/admin/members', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.listMembers(op(req)) })));
  r.post('/admin/members', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.crew.saveMember(op(req), parse(memberBody, req.body)), 201)));
  r.put('/admin/members/:id', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.crew.saveMember(op(req), { ...parse(memberBody, req.body), id: parse(idParams, req.params).id }))));

  r.get('/admin/shifts', ...admin, asyncHandler(async (req, res) => {
    const q = parse(z.object({ from: date, to: date, memberId: z.string().uuid().optional() }), req.query);
    sendJson(res, { items: await d.crew.listShifts(op(req), q.from, q.to, q.memberId) });
  }));
  r.post('/admin/shifts', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ memberId: z.string().uuid(), label: z.string().trim().min(1).max(30), startsAt: date, endsAt: date }), req.body);
    sendJson(res, await d.crew.createShift(op(req), b), 201);
  }));
  r.delete('/admin/shifts/:id', ...admin, asyncHandler(async (req, res) => {
    await d.crew.deleteShift(op(req), parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));

  r.get('/admin/live', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.live(op(req)) })));
  r.post('/admin/members/:id/clock-out', ...admin, asyncHandler(async (req, res) => sendJson(res, await d.crew.clockOut(op(req), parse(idParams, req.params).id, 'manager'))));
  r.get('/admin/sessions', ...admin, asyncHandler(async (req, res) => {
    const q = parse(z.object({ month, memberId: z.string().uuid().optional() }), req.query);
    sendJson(res, { items: await d.crew.listSessions(op(req), q.month, q.memberId) });
  }));

  r.get('/admin/tasks', ...admin, asyncHandler(async (req, res) => {
    const q = parse(z.object({ assigneeId: z.string().uuid().optional(), status: z.enum(['todo', 'doing', 'done']).optional() }), req.query);
    sendJson(res, { items: await d.crew.listTasks(op(req), q) });
  }));
  r.post('/admin/tasks', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(2).max(120), description: z.string().max(2000).optional(), assigneeId: z.string().uuid().nullable().optional(), dueAt: date.nullable().optional() }), req.body);
    sendJson(res, await d.crew.createTask(op(req), b, getPrincipal(req).userId), 201);
  }));
  r.patch('/admin/tasks/:id', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(2).max(120).optional(), description: z.string().max(2000).optional(), assigneeId: z.string().uuid().nullable().optional(), status: z.enum(['todo', 'doing', 'done']).optional(), dueAt: date.nullable().optional() }), req.body);
    sendJson(res, await d.crew.updateTask(op(req), parse(idParams, req.params).id, b));
  }));
  r.delete('/admin/tasks/:id', ...admin, asyncHandler(async (req, res) => {
    await d.crew.deleteTask(op(req), parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));

  r.get('/admin/checklist', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.listChecklist(op(req)) })));
  r.post('/admin/checklist', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(2).max(120), shiftLabel: z.string().trim().max(30).default('') }), req.body);
    sendJson(res, await d.crew.createChecklistItem(op(req), b.title, b.shiftLabel), 201);
  }));
  r.patch('/admin/checklist/:id', ...admin, asyncHandler(async (req, res) => {
    await d.crew.toggleChecklistItem(op(req), parse(idParams, req.params).id, parse(z.object({ active: z.boolean() }), req.body).active);
    sendJson(res, { ok: true });
  }));

  r.get('/admin/announcements', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.listAnnouncements(op(req)) })));
  r.post('/admin/announcements', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(4000), severity: z.enum(['info', 'warning', 'critical']).default('info'), mandatory: z.boolean().default(false) }), req.body);
    sendJson(res, await d.crew.createAnnouncement(op(req), b, getPrincipal(req).userId), 201);
  }));

  /* ─── Caja: la opera el personal; reabrir es de administradores ─── */
  r.get('/cash', ...staff, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.listCash(op(req)) })));
  r.get('/cash/:id', ...staff, asyncHandler(async (req, res) => sendJson(res, await d.crew.cashDetail(op(req), parse(idParams, req.params).id))));
  r.post('/cash', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ box: z.string().trim().min(1).max(40), currency: z.string().regex(/^[A-Z]{3,5}$/), openingBalance: money }), req.body);
    sendJson(res, await d.crew.openCash(op(req), b.box, b.currency, b.openingBalance, getPrincipal(req).userId), 201);
  }));
  r.post('/cash/:id/movements', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ type: z.enum(['in', 'out']), amount: money, concept: z.string().trim().min(2).max(200) }), req.body);
    sendJson(res, await d.crew.cashMovement(op(req), parse(idParams, req.params).id, b, getPrincipal(req).userId), 201);
  }));
  r.post('/cash/:id/close', ...staff, asyncHandler(async (req, res) => {
    const b = parse(z.object({ declaredBalance: money }), req.body);
    sendJson(res, await d.crew.closeCash(op(req), parse(idParams, req.params).id, b.declaredBalance, getPrincipal(req).userId));
  }));
  r.post('/admin/cash/:id/reopen', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    sendJson(res, await d.crew.reopenCash(op(req), parse(idParams, req.params).id, getPrincipal(req).userId, b.reason));
  }));

  /* ─── Nómina ─── */
  r.get('/admin/payroll', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.crew.payroll(op(req), parse(z.object({ month }), req.query).month) })));
  r.post('/admin/payroll/adjustments', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({ memberId: z.string().uuid(), month, type: z.enum(['bonus', 'discount']), amount: money, note: z.string().max(200).default('') }), req.body);
    sendJson(res, await d.crew.addAdjustment(op(req), b, getPrincipal(req).userId), 201);
  }));
  r.delete('/admin/payroll/adjustments/:id', ...admin, asyncHandler(async (req, res) => {
    await d.crew.deleteAdjustment(op(req), parse(idParams, req.params).id);
    sendJson(res, { ok: true });
  }));
  r.post('/admin/payroll/:month/close', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, await d.crew.closeMonth(op(req), parse(z.object({ month }), req.params).month, getPrincipal(req).userId));
  }));
  r.post('/admin/payroll/:month/:memberId/paid', ...admin, asyncHandler(async (req, res) => {
    const p = parse(z.object({ month, memberId: z.string().uuid() }), req.params);
    await d.crew.markPaid(op(req), p.month, p.memberId, getPrincipal(req).userId);
    sendJson(res, { ok: true });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
