import express, { Request, Router } from 'express';
import { z } from 'zod';
import type { ModuleLogger } from '../../../shared/module';
import type { AuthPort } from '../../../shared/ports/AuthPort';
import { requireAuth, requirePlayer, requireRole, scopeOperator, scopeOperatorOptional } from '../../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../../../shared/http/errors';
import { parse, zAmount, zAmountOrZero, zPagination } from '../../../shared/http/validate';
import { BONUS_TYPES, BonusStatus } from '../../domain/bonus';
import { PromoError } from '../../domain/common';
import { JACKPOT_LEVEL_KEYS } from '../../domain/jackpot';
import { BonusService, bonusView } from '../../application/BonusService';
import type { DropsService } from '../../application/DropsService';
import type { JackpotService } from '../../application/JackpotService';

const zId = z.string().min(1).max(100);
const zCode = z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Código alfanumérico');
const zOptAmount = zAmount.nullable().optional();
const zBps = z.number().int().min(0).max(10000);

const templateFields = {
  name: z.string().trim().min(1).max(120),
  currency: z.string().trim().min(3).max(10),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  code: zCode.nullable().optional(),
  maxUsesTotal: z.number().int().positive().nullable().optional(),
  maxUsesPerPlayer: z.number().int().positive().nullable().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validTo: z.coerce.date().nullable().optional(),
  autoOnDeposit: z.boolean().optional(),
  firstDepositOnly: z.boolean().optional(),
  stackable: z.boolean().optional(),
  matchBps: z.number().int().min(1).max(100000).nullable().optional(),
  minDeposit: zOptAmount,
  maxBonusAmount: zOptAmount,
  fixedAmount: zOptAmount,
  freeSpinGameId: zId.nullable().optional(),
  freeSpinCount: z.number().int().min(1).max(1000).nullable().optional(),
  freeSpinValue: zOptAmount,
  cashbackBps: z.number().int().min(1).max(10000).nullable().optional(),
  wageringMultiplier: z.number().int().min(0).max(200).optional(),
  wageringBase: z.enum(['BONUS', 'BONUS_PLUS_DEPOSIT']).optional(),
  contributionBps: z.record(z.string().min(1).max(40), zBps).optional(),
  excludedGameIds: z.array(zId).max(1000).optional(),
  maxBet: zOptAmount,
  maxConversion: zOptAmount,
  validityHours: z.number().int().min(1).max(8760).optional(),
  claimWindowHours: z.number().int().min(1).max(8760).optional(),
};
const templateCreate = z.object({ ...templateFields, operatorId: zId.optional(), type: z.enum(BONUS_TYPES as unknown as [string, ...string[]]) });
const templatePatch = z.object(templateFields).partial();

const grantBody = z.object({
  operatorId: zId.optional(),
  playerId: zId,
  templateId: zId,
  amount: zAmount.optional(),
  depositAmount: zAmount.optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
});
const bonusListQuery = zPagination.extend({
  operatorId: zId.optional(),
  playerId: zId.optional(),
  status: z.string().optional(),
});
const cashbackRun = z.object({ operatorId: zId.optional(), templateId: zId, from: z.coerce.date(), to: z.coerce.date() });
const cancelBody = z.object({ reason: z.string().max(200).optional() });

const levelSchema = z.object({
  key: z.enum(JACKPOT_LEVEL_KEYS as unknown as [string, ...string[]]),
  seedAmount: zAmountOrZero,
  shareBps: zBps,
  triggerChancePpm: z.number().int().min(0).max(1_000_000),
  mustDropBy: zAmount.nullable().optional(),
});
const jackpotFields = {
  name: z.string().trim().min(1).max(120),
  contributionBps: z.number().int().min(1).max(2000),
  minBet: zAmountOrZero.optional(),
  gameIds: z.array(zId).max(2000).optional(),
  categories: z.array(z.string().min(1).max(40)).max(20).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
};
const jackpotCreate = z.object({ ...jackpotFields, operatorId: zId.optional(), currency: z.string().trim().min(3).max(10), levels: z.array(levelSchema).min(1).max(3) });
const jackpotPatch = z.object({ ...jackpotFields, levels: z.array(levelSchema).min(1).max(3) }).partial();

const dropFields = {
  name: z.string().trim().min(1).max(120),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  minBet: zAmountOrZero.optional(),
  dropChancePpm: z.number().int().min(1).max(1_000_000),
  gameIds: z.array(zId).max(2000).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
};
const dropCreate = z.object({
  ...dropFields,
  operatorId: zId.optional(),
  currency: z.string().trim().min(3).max(10),
  prizes: z.array(z.object({ amount: zAmount, quantity: z.number().int().min(1).max(1_000_000) })).min(1).max(50),
});
const dropPatch = z.object(dropFields).partial();
const operatorQuery = z.object({ operatorId: zId });
const scopedQuery = z.object({ operatorId: zId.optional() });

const STATUSES: BonusStatus[] = ['PENDING', 'ACTIVE', 'COMPLETED', 'FORFEITED', 'CANCELLED'];

function parseStatuses(raw?: string): BonusStatus[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(',').map((s) => s.trim().toUpperCase());
  if (list.some((s) => !STATUSES.includes(s as BonusStatus))) throw new PromoError(400, 'BAD_REQUEST', 'status inválido');
  return list as BonusStatus[];
}

const param = (req: Request, name: string): string => parse(zId, req.params[name]);

/** Router del módulo, montado en /promo/v1. */
export function buildPromotionsRouter(d: { auth: AuthPort; bonuses: BonusService; jackpots: JackpotService; drops: DropsService; logger: ModuleLogger }): Router {
  const r = Router();
  r.use(express.json({ limit: '100kb' }));
  const auth = requireAuth(d.auth);
  const admin = [auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const staff = [auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT')];

  // ───────── Públicos ─────────
  r.get('/jackpots', asyncHandler(async (req, res) => {
    const q = parse(operatorQuery, req.query);
    sendJson(res, { jackpots: await d.jackpots.publicList(q.operatorId) });
  }));
  r.get('/drops', asyncHandler(async (req, res) => {
    const q = parse(operatorQuery, req.query);
    sendJson(res, { campaigns: await d.drops.activeCampaigns(q.operatorId) });
  }));

  // ───────── Jugador ─────────
  r.get('/bonuses', auth, asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, await d.bonuses.listPlayerBonuses(p.operatorId, p.playerId));
  }));
  r.post('/bonuses/claim', auth, asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    const body = parse(z.object({ code: zCode }), req.body);
    sendJson(res, { bonus: bonusView(await d.bonuses.claim(p.operatorId, p.playerId, body.code)) }, 201);
  }));
  r.post('/bonuses/:id/cancel', auth, asyncHandler(async (req, res) => {
    const p = requirePlayer(req);
    sendJson(res, { bonus: bonusView(await d.bonuses.cancelByPlayer(p.operatorId, p.playerId, param(req, 'id'))) });
  }));

  // ───────── Admin: plantillas de bono ─────────
  r.get('/admin/bonus-templates', ...staff, asyncHandler(async (req, res) => {
    const q = parse(scopedQuery, req.query);
    sendJson(res, { templates: await d.bonuses.listTemplates(scopeOperatorOptional(req, q.operatorId)) });
  }));
  r.post('/admin/bonus-templates', ...admin, asyncHandler(async (req, res) => {
    const body = parse(templateCreate, req.body);
    const operatorId = scopeOperator(req, body.operatorId);
    sendJson(res, { template: await d.bonuses.createTemplate({ ...body, operatorId, type: body.type as (typeof BONUS_TYPES)[number] }) }, 201);
  }));
  r.get('/admin/bonus-templates/:id', ...staff, asyncHandler(async (req, res) => {
    sendJson(res, { template: await d.bonuses.getTemplateScoped(scopeOperatorOptional(req), param(req, 'id')) });
  }));
  r.patch('/admin/bonus-templates/:id', ...admin, asyncHandler(async (req, res) => {
    const body = parse(templatePatch, req.body);
    sendJson(res, { template: await d.bonuses.updateTemplate(scopeOperatorOptional(req), param(req, 'id'), body) });
  }));
  r.delete('/admin/bonus-templates/:id', ...admin, asyncHandler(async (req, res) => {
    sendJson(res, await d.bonuses.deleteTemplate(scopeOperatorOptional(req), param(req, 'id')));
  }));

  // ───────── Admin: bonos de jugadores ─────────
  r.get('/admin/bonuses', ...staff, asyncHandler(async (req, res) => {
    const q = parse(bonusListQuery, req.query);
    const list = await d.bonuses.listBonuses({
      operatorId: scopeOperatorOptional(req, q.operatorId),
      playerId: q.playerId,
      status: parseStatuses(q.status),
      limit: q.limit,
      offset: q.offset,
    });
    sendJson(res, { bonuses: list.map((b) => ({ ...bonusView(b), operatorId: b.operatorId, playerId: b.playerId })) });
  }));
  r.post('/admin/bonuses/grant', ...admin, asyncHandler(async (req, res) => {
    const body = parse(grantBody, req.body);
    const operatorId = scopeOperator(req, body.operatorId);
    const b = await d.bonuses.grantManual(operatorId, body.templateId, body.playerId, body);
    sendJson(res, { bonus: { ...bonusView(b), playerId: b.playerId } }, 201);
  }));
  r.post('/admin/bonuses/:id/cancel', ...admin, asyncHandler(async (req, res) => {
    const body = parse(cancelBody, req.body ?? {});
    sendJson(res, { bonus: bonusView(await d.bonuses.cancelByAdmin(scopeOperatorOptional(req), param(req, 'id'), body.reason)) });
  }));
  r.post('/admin/cashback/run', ...admin, asyncHandler(async (req, res) => {
    const body = parse(cashbackRun, req.body);
    sendJson(res, await d.bonuses.runCashback(scopeOperatorOptional(req, body.operatorId), body.templateId, body.from, body.to));
  }));

  // ───────── Admin: jackpots ─────────
  r.get('/admin/jackpots', ...staff, asyncHandler(async (req, res) => {
    const q = parse(scopedQuery, req.query);
    sendJson(res, { jackpots: await d.jackpots.list(scopeOperatorOptional(req, q.operatorId)) });
  }));
  r.post('/admin/jackpots', ...admin, asyncHandler(async (req, res) => {
    const body = parse(jackpotCreate, req.body);
    const operatorId = scopeOperator(req, body.operatorId);
    const j = await d.jackpots.create({
      ...body,
      operatorId,
      levels: body.levels.map((l) => ({ ...l, key: l.key as (typeof JACKPOT_LEVEL_KEYS)[number], mustDropBy: l.mustDropBy ?? null })),
    });
    sendJson(res, { jackpot: j }, 201);
  }));
  r.patch('/admin/jackpots/:id', ...admin, asyncHandler(async (req, res) => {
    const body = parse(jackpotPatch, req.body);
    const j = await d.jackpots.update(scopeOperatorOptional(req), param(req, 'id'), {
      ...body,
      levels: body.levels?.map((l) => ({ ...l, key: l.key as (typeof JACKPOT_LEVEL_KEYS)[number], mustDropBy: l.mustDropBy ?? null })),
    });
    sendJson(res, { jackpot: j });
  }));
  r.get('/admin/jackpots/:id/report', ...staff, asyncHandler(async (req, res) => {
    sendJson(res, await d.jackpots.report(scopeOperatorOptional(req), param(req, 'id')));
  }));

  // ───────── Admin: drops & wins ─────────
  r.get('/admin/drops', ...staff, asyncHandler(async (req, res) => {
    const q = parse(scopedQuery, req.query);
    sendJson(res, { campaigns: await d.drops.list(scopeOperatorOptional(req, q.operatorId)) });
  }));
  r.post('/admin/drops', ...admin, asyncHandler(async (req, res) => {
    const body = parse(dropCreate, req.body);
    const operatorId = scopeOperator(req, body.operatorId);
    sendJson(res, { campaign: await d.drops.create({ ...body, operatorId, minBet: body.minBet ?? 0n, gameIds: body.gameIds ?? [], status: body.status ?? 'ACTIVE' }) }, 201);
  }));
  r.patch('/admin/drops/:id', ...admin, asyncHandler(async (req, res) => {
    const body = parse(dropPatch, req.body);
    sendJson(res, { campaign: await d.drops.update(scopeOperatorOptional(req), param(req, 'id'), body) });
  }));
  r.get('/admin/drops/:id/awards', ...staff, asyncHandler(async (req, res) => {
    const c = await d.drops.getScoped(scopeOperatorOptional(req), param(req, 'id'));
    sendJson(res, { awards: await d.drops.listAwards(c.id, 200) });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
