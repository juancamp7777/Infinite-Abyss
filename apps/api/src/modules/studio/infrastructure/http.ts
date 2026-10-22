import { randomUUID } from 'crypto';
import express, { Request, Router } from 'express';
import { z } from 'zod';
import { optionalAuth, requireAuth, requireRole, scopeOperator } from '../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse, zAmount, zAmountOrZero, zPagination } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { listGames, rtpMode } from '../application/catalog';
import type { StudioConfigService } from '../application/StudioConfigService';
import type { StudioFairnessService } from '../application/StudioFairnessService';
import type { ActorInput, StudioPlayService } from '../application/StudioPlayService';

export interface StudioRouterDeps {
  auth: AuthPort;
  play: StudioPlayService;
  fairness: StudioFairnessService;
  config: StudioConfigService;
  logger: ModuleLogger;
}

const zMode = z.enum(['real', 'demo']).optional();
const zParams = z.record(z.string(), z.unknown()).optional();
const zCurrency = z.string().regex(/^[A-Z0-9]{3,10}$/).optional();

const playBody = z.object({
  amount: zAmount,
  currency: zCurrency,
  bonusBuy: z.boolean().optional(),
  params: zParams,
  roundId: z.string().uuid().optional(),
  mode: zMode,
  operatorId: z.string().min(1).max(64).optional(),
  session: z.string().min(1).max(512).optional(),
});

const actionBody = z.object({
  roundId: z.string().uuid(),
  action: z.object({ type: z.string().min(1).max(32) }).passthrough(),
  mode: zMode,
  operatorId: z.string().min(1).max(64).optional(),
  session: z.string().min(1).max(512).optional(),
});

const verifyBody = z.object({
  serverSeed: z.string().min(1).max(256),
  clientSeed: z.string().min(1).max(256),
  nonce: z.coerce.number().int().min(0),
  gameId: z.string().min(1).max(64),
  serverSeedHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  params: zParams,
  rtp: z.number().min(0.5).max(1).optional(),
  rtpProfile: z.string().max(32).optional(),
  bonusBuy: z.boolean().optional(),
  roundId: z.string().uuid().optional(),
});

const configBody = z.object({
  operatorId: z.string().min(1).max(64).optional(),
  gameId: z.string().min(1).max(64),
  rtp: z.number().min(0).max(1).nullable().optional(),
  rtpProfile: z.string().max(32).nullable().optional(),
  minBet: zAmountOrZero.nullable().optional(),
  maxBet: zAmount.nullable().optional(),
  enabled: z.boolean().optional(),
});

const header = (req: Request, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** Identidad desde el request: JWT del jugador, X-Studio-Session (Hub) o X-Demo-Session (demo anónimo). */
function actorInput(req: Request, src: { mode?: 'real' | 'demo'; operatorId?: string; session?: string } = {}): ActorInput {
  const q = req.query as Record<string, unknown>;
  const mode = src.mode ?? (q.mode === 'demo' || q.mode === 'real' ? q.mode : undefined);
  return {
    principal: req.principal,
    sessionToken: header(req, 'x-studio-session') ?? src.session ?? (typeof q.session === 'string' ? q.session : undefined),
    mode,
    demoSession: header(req, 'x-demo-session'),
    operatorId: src.operatorId ?? (typeof q.operatorId === 'string' ? q.operatorId : undefined),
  };
}

export function createStudioRouter(d: StudioRouterDeps): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  const auth = optionalAuth(d.auth);

  // ── catálogo ──
  r.get('/games', (_req, res) => {
    sendJson(res, {
      games: listGames().map((g) => ({
        id: g.id,
        name: g.name,
        kind: g.kind,
        rtp: g.rtpTarget,
        rtpRange: g.rtpRange ?? null,
        rtpProfiles: g.rtpProfiles ?? null,
        rtpMode: rtpMode(g),
        volatility: (g.math ?? g.interactive)!.volatility,
        maxWin: (g.math ?? g.interactive)!.maxWinMultiplier,
        bonusBuy: g.math?.bonusBuy ?? null,
        playable: { single: !!g.math, interactive: !!g.interactive },
        config: g.kind === 'original' ? (g.math ?? g.interactive)!.config : undefined,
      })),
    });
  });

  // ── demo ──
  r.post('/demo/session', auth, asyncHandler(async (req, res) => {
    const demoSession = randomUUID();
    const operatorId = typeof req.body?.operatorId === 'string' ? req.body.operatorId : undefined;
    const currency = typeof req.body?.currency === 'string' ? req.body.currency : undefined;
    const b = await d.play.balance({ mode: 'demo', demoSession, operatorId }, currency);
    sendJson(res, { demoSession, ...b }, 201);
  }));

  r.get('/balance', auth, asyncHandler(async (req, res) => {
    const currency = typeof req.query.currency === 'string' ? req.query.currency : undefined;
    sendJson(res, await d.play.balance(actorInput(req), currency));
  }));

  // ── provably fair ──
  r.get('/fairness', auth, asyncHandler(async (req, res) => {
    const a = await d.play.resolveActor(actorInput(req));
    sendJson(res, await d.fairness.view(a.operatorId, a.playerId));
  }));

  r.post('/fairness/client-seed', auth, asyncHandler(async (req, res) => {
    const body = parse(z.object({ clientSeed: z.string(), mode: zMode }), req.body);
    const a = await d.play.resolveActor(actorInput(req, body));
    sendJson(res, await d.fairness.setClientSeed(a.operatorId, a.playerId, body.clientSeed));
  }));

  r.post('/fairness/rotate', auth, asyncHandler(async (req, res) => {
    const body = parse(z.object({ clientSeed: z.string().optional(), mode: zMode }), req.body ?? {});
    const a = await d.play.resolveActor(actorInput(req, body));
    const { previous, current } = await d.fairness.rotate(a.operatorId, a.playerId, body.clientSeed);
    sendJson(res, {
      previous: { serverSeed: previous.serverSeed, serverSeedHash: previous.serverSeedHash, clientSeed: previous.clientSeed, lastNonce: previous.nonce - 1, noncesUsed: previous.nonce },
      current,
    });
  }));

  // Público: no requiere autenticación.
  r.post('/fairness/verify', asyncHandler(async (req, res) => {
    sendJson(res, await d.fairness.verify(parse(verifyBody, req.body)));
  }));

  // ── juego ──
  r.post('/play/:gameId', auth, asyncHandler(async (req, res) => {
    const b = parse(playBody, req.body);
    const out = await d.play.play(String(req.params.gameId), { ...actorInput(req, b), amount: b.amount, currency: b.currency, bonusBuy: b.bonusBuy, params: b.params, roundId: b.roundId });
    sendJson(res, out);
  }));

  r.post('/games/:gameId/start', auth, asyncHandler(async (req, res) => {
    const b = parse(playBody, req.body);
    const out = await d.play.start(String(req.params.gameId), { ...actorInput(req, b), amount: b.amount, currency: b.currency, params: b.params, roundId: b.roundId });
    sendJson(res, out, 201);
  }));

  r.post('/games/:gameId/action', auth, asyncHandler(async (req, res) => {
    const b = parse(actionBody, req.body);
    sendJson(res, await d.play.action(String(req.params.gameId), { ...actorInput(req, b), roundId: b.roundId, action: b.action }));
  }));

  r.post('/games/:gameId/settle', auth, asyncHandler(async (req, res) => {
    const b = parse(actionBody.pick({ roundId: true, mode: true, operatorId: true, session: true }), req.body);
    sendJson(res, await d.play.settleOpenRound(b.roundId, actorInput(req, b)));
  }));

  r.get('/games/:gameId/active', auth, asyncHandler(async (req, res) => {
    sendJson(res, { round: await d.play.activeRound(String(req.params.gameId), actorInput(req)) });
  }));

  // ── historial ──
  r.get('/rounds', auth, asyncHandler(async (req, res) => {
    const q = parse(zPagination.extend({ gameId: z.string().max(64).optional() }), req.query);
    sendJson(res, { rounds: await d.play.listRounds(actorInput(req), q), limit: q.limit, offset: q.offset });
  }));

  r.get('/rounds/:id', auth, asyncHandler(async (req, res) => {
    sendJson(res, { round: await d.play.getRound(String(req.params.id), actorInput(req)) });
  }));

  // ── administración (RTP y límites por operador) ──
  const admin = [requireAuth(d.auth), requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  r.get('/admin/configs', ...admin, asyncHandler(async (req, res) => {
    const operatorId = scopeOperator(req, typeof req.query.operatorId === 'string' ? req.query.operatorId : undefined);
    sendJson(res, { operatorId, configs: await d.config.list(operatorId) });
  }));

  r.put('/admin/configs', ...admin, asyncHandler(async (req, res) => {
    const b = parse(configBody, req.body);
    const operatorId = scopeOperator(req, b.operatorId);
    const { operatorId: _o, ...update } = b;
    sendJson(res, { config: await d.config.update(operatorId, update) });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
