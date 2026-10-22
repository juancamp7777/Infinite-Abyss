import { randomUUID } from 'crypto';
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { requireAuth, requirePlayer, requireRole, scopeOperator } from '../../shared/http/auth';
import { HttpError, asyncHandler, moduleErrorHandler, notFound, sendJson } from '../../shared/http/errors';
import { parse, zAmount, zAmountOrZero } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import { COL, PayoutRecord, loadSettings, saveSettings } from '../application/context';
import type { GamificationService } from '../application/service';
import { defaultLevels, validateWheel, Achievement, Mission, Tournament, VipLevel, WheelConfig } from '../domain/types';
import { isValidTimezone } from '../domain/periods';

const zReward = z.discriminatedUnion('type', [
  z.object({ type: z.literal('points'), points: zAmount }),
  z.object({ type: z.literal('bonus'), amount: zAmount, promotionId: z.string().min(1).optional() }),
]);

const zTime = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(t)) {
    ctx.addIssue({ code: 'custom', message: 'Fecha inválida' });
    return z.NEVER;
  }
  return t;
});

const zLevel = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64),
  order: z.number().int().min(0).default(0),
  pointsRequired: zAmountOrZero,
  rakebackBps: z.number().int().min(0).max(10000),
  benefits: z.any().default(null),
  levelUpBonus: zAmountOrZero.default(0n),
});

const zMission = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  period: z.enum(['daily', 'weekly']),
  type: z.enum(['wager', 'rounds', 'multiplier', 'deposit']),
  target: zAmount,
  category: z.string().optional(),
  gameId: z.string().optional(),
  minMultiplier: z.number().positive().optional(),
  reward: zReward,
  active: z.boolean().default(true),
});

const zAchievement = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  icon: z.string().max(200).optional(),
  criteria: z.object({
    metric: z.enum(['total_wagered', 'total_won', 'deposit_total', 'rounds', 'biggest_multiplier', 'login_streak', 'deposit_count']),
    value: z.union([zAmountOrZero, z.number().nonnegative()]),
  }),
  reward: zReward.optional(),
  active: z.boolean().default(true),
});

const zWheel = z.object({
  enabled: z.boolean().default(true),
  cooldownHours: z.number().positive().max(24 * 30).default(24),
  maxExpectedValue: zAmountOrZero,
  prizes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), weight: z.number().int().positive(), reward: zReward })).min(1),
});

const zSettings = z.object({
  timezone: z.string().refine(isValidTimezone, 'Zona horaria inválida').optional(),
  currency: z.string().min(3).max(10).optional(),
  houseEdgeBps: z.record(z.string(), z.number().int().min(0).max(10000)).optional(),
  unitsPerPoint: z.record(z.string(), zAmount).optional(),
  rakebackPeriod: z.enum(['daily', 'weekly']).optional(),
  streakRewards: z.array(z.object({ day: z.number().int().min(1).max(365), reward: zReward })).optional(),
});

const zTournament = z
  .object({
    name: z.string().min(1).max(120),
    gameIds: z.array(z.string()).default([]),
    categories: z.array(z.string()).default([]),
    minBet: zAmountOrZero.default(0n),
    startsAt: zTime,
    endsAt: zTime,
    metric: z.enum(['highest_multiplier', 'total_points', 'total_wagered']),
    unitsPerPoint: zAmount.default(100n),
    buyIn: zAmountOrZero.default(0n),
    currency: z.string().min(3).max(10).optional(),
    prizes: z.array(z.object({ position: z.number().int().min(1), amount: zAmount })).min(1),
  })
  .refine((t) => t.endsAt > t.startsAt, { message: 'endsAt debe ser posterior a startsAt' })
  .refine((t) => new Set(t.prizes.map((p) => p.position)).size === t.prizes.length, { message: 'Posiciones de premio duplicadas' });

const zOpQuery = z.object({ operatorId: z.string().optional() }).passthrough();

export interface RouterDeps {
  auth: AuthPort;
  svc: GamificationService;
  logger: ModuleLogger;
}

export function buildRouter({ auth, svc, logger }: RouterDeps): Router {
  const r = Router();
  const store = svc.ctx.store;
  r.use(requireAuth(auth));

  const op = (req: Request): string => scopeOperator(req, parse(zOpQuery, req.query).operatorId);
  const admin = requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN');
  const idOf = (req: Request): string => String(req.params.id);

  // ---------- Jugador ----------
  r.get('/vip', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.vip.state(p.operatorId, p.playerId));
  }));
  r.post('/vip/rakeback/claim', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.vip.claimRakeback(p.operatorId, p.playerId));
  }));
  r.get('/missions', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, { missions: await svc.progress.listMissions(p.operatorId, p.playerId) });
  }));
  r.post('/missions/:id/claim', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.progress.claimMission(p.operatorId, p.playerId, idOf(req)));
  }));
  r.get('/achievements', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, { achievements: await svc.progress.listAchievements(p.operatorId, p.playerId) });
  }));
  r.get('/streak', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.progress.streak(p.operatorId, p.playerId));
  }));
  r.get('/wheel', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.wheel.status(p.operatorId, p.playerId));
  }));
  r.post('/wheel/spin', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.wheel.spin(p.operatorId, p.playerId));
  }));
  r.get('/tournaments', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, { tournaments: await svc.tournaments.list(p.operatorId, p.playerId) });
  }));
  r.get('/tournaments/:id/leaderboard', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.tournaments.leaderboard(p.operatorId, idOf(req), p.playerId));
  }));
  r.post('/tournaments/:id/join', asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await svc.tournaments.join(p.operatorId, p.playerId, idOf(req)));
  }));

  // ---------- Admin ----------
  const a = Router();
  a.use(admin);

  a.get('/settings', asyncHandler(async (req, res) => sendJson(res, await loadSettings(svc.ctx, op(req)))));
  a.put('/settings', asyncHandler(async (req, res) => {
    const patch = parse(zSettings, req.body);
    const o = op(req);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    sendJson(res, await saveSettings(svc.ctx, o, clean));
  }));

  // CRUD genérico de documentos con id.
  function crud<S extends z.ZodType>(path: string, col: string, schema: S, list?: (o: string) => Promise<unknown[]>): void {
    a.get(path, asyncHandler(async (req, res) => {
      const o = op(req);
      sendJson(res, { items: list ? await list(o) : await store.list(col, o) });
    }));
    a.post(path, asyncHandler(async (req, res) => {
      const o = op(req);
      const body = parse(schema, req.body) as { id?: string };
      const id = body.id ?? randomUUID();
      if (!(await store.putIfAbsent(col, o, id, { ...body, id, operatorId: o }))) throw new HttpError(409, 'ALREADY_EXISTS', 'El id ya existe');
      sendJson(res, await store.get(col, o, id), 201);
    }));
    a.put(`${path}/:id`, asyncHandler(async (req, res) => {
      const o = op(req);
      const id = idOf(req);
      if (!(await store.get(col, o, id))) throw notFound();
      const body = parse(schema, req.body) as object;
      await store.put(col, o, id, { ...body, id, operatorId: o });
      sendJson(res, await store.get(col, o, id));
    }));
    a.delete(`${path}/:id`, asyncHandler(async (req, res) => {
      const o = op(req);
      if (!(await store.get(col, o, idOf(req)))) throw notFound();
      await store.delete(col, o, idOf(req));
      res.status(204).end();
    }));
  }

  crud('/vip/levels', COL.level, zLevel, (o) => svc.vip.levels(o));
  a.post('/vip/levels-reset-defaults', asyncHandler(async (req, res) => {
    const o = op(req);
    for (const l of await store.list<VipLevel>(COL.level, o)) await store.delete(COL.level, o, l.id);
    for (const l of defaultLevels(o, (await loadSettings(svc.ctx, o)).currency)) await store.put(COL.level, o, l.id, l);
    sendJson(res, { items: await svc.vip.levels(o) });
  }));
  crud('/missions', COL.mission, zMission);
  crud('/achievements', COL.achievement, zAchievement);

  a.get('/wheel', asyncHandler(async (req, res) => sendJson(res, (await loadSettings(svc.ctx, op(req))).wheel)));
  a.put('/wheel', asyncHandler(async (req, res) => {
    const wheel = parse(zWheel, req.body) as WheelConfig;
    const err = validateWheel(wheel);
    if (err) throw new HttpError(400, 'INVALID_WHEEL', err);
    sendJson(res, (await saveSettings(svc.ctx, op(req), { wheel })).wheel);
  }));

  a.get('/tournaments', asyncHandler(async (req, res) => {
    const o = op(req);
    const items = await store.list<Tournament>(COL.tournament, o);
    sendJson(res, { items: items.map((t) => ({ ...t, derivedStatus: svc.tournaments.derivedStatus(t) })) });
  }));
  a.post('/tournaments', asyncHandler(async (req, res) => {
    const o = op(req);
    const body = parse(zTournament, req.body);
    const t: Tournament = {
      ...body,
      id: randomUUID(),
      operatorId: o,
      currency: body.currency ?? (await loadSettings(svc.ctx, o)).currency,
      status: 'open',
    };
    await store.put(COL.tournament, o, t.id, t);
    sendJson(res, t, 201);
  }));
  a.put('/tournaments/:id', asyncHandler(async (req, res) => {
    const o = op(req);
    const cur = await svc.tournaments.get(o, idOf(req));
    if (svc.tournaments.derivedStatus(cur) !== 'scheduled') throw new HttpError(409, 'TOURNAMENT_STARTED', 'Solo se editan torneos programados');
    const body = parse(zTournament, req.body);
    const t: Tournament = { ...cur, ...body, currency: body.currency ?? cur.currency, id: cur.id, operatorId: o, status: 'open' };
    await store.put(COL.tournament, o, t.id, t);
    sendJson(res, t);
  }));
  a.delete('/tournaments/:id', asyncHandler(async (req, res) => {
    await svc.tournaments.cancel(op(req), idOf(req));
    res.status(204).end();
  }));

  a.get('/reports/payouts', asyncHandler(async (req, res) => {
    const q = parse(z.object({ type: z.string().optional(), from: zTime.optional(), to: zTime.optional(), limit: z.coerce.number().int().min(1).max(1000).default(100) }).passthrough(), req.query);
    const rows = (await store.list<PayoutRecord>(COL.payout, op(req))).filter(
      (p) => (!q.type || p.type === q.type) && (q.from === undefined || p.at >= q.from) && (q.to === undefined || p.at < q.to),
    );
    const summary: Record<string, { count: number; total: bigint }> = {};
    for (const p of rows) {
      const k = `${p.type}|${p.currency}`;
      const s = (summary[k] ??= { count: 0, total: 0n });
      s.count += 1;
      s.total += p.amount;
    }
    sendJson(res, { summary, count: rows.length, items: rows.sort((x, y) => y.at - x.at).slice(0, q.limit) });
  }));

  r.use('/admin', a);
  r.use(moduleErrorHandler(logger));
  return r;
}

export type { Achievement, Mission };
