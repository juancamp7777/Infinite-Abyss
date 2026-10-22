import { Router } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { optionalAuth, requireAuth, requirePlayer } from '../../shared/http/auth';
import { HttpError, asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { FeedService } from '../application/FeedService';
import { FEED_KINDS } from '../domain/BetFeed';

const zLimit = z.coerce.number().int().min(1).max(50).default(20);
const zList = z.object({
  operatorId: z.string().min(1).max(100).optional(),
  kind: z.enum(FEED_KINDS as unknown as ['all', 'high', 'lucky']).default('all'),
  limit: zLimit,
});

/**
 * GET /bets?operatorId=&kind=all|high|lucky&limit= — público (con token de jugador marca `isMe`).
 * GET /bets/mine?limit= — solo jugador.
 */
export function buildFeedRouter(d: { auth: AuthPort; svc: FeedService; logger: ModuleLogger }): Router {
  const r = Router();

  r.get('/bets/mine', requireAuth(d.auth), asyncHandler((req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const { limit } = parse(z.object({ limit: zLimit }), req.query);
    sendJson(res, { bets: d.svc.feed.listMine(operatorId, playerId, limit) });
  }));

  r.get('/bets', optionalAuth(d.auth), asyncHandler((req, res) => {
    const q = parse(zList, req.query);
    const p = req.principal;
    const me = p?.role === 'PLAYER' && p.operatorId && p.playerId ? { op: p.operatorId, id: p.playerId } : null;
    if (me && q.operatorId && q.operatorId !== me.op) throw new HttpError(403, 'FORBIDDEN', 'Fuera del alcance del operador');
    const operatorId = me?.op ?? q.operatorId;
    if (!operatorId) throw new HttpError(400, 'OPERATOR_REQUIRED', 'Indica operatorId');
    const bets = d.svc.feed.list(operatorId, q.kind, q.limit).map((b) => ({ ...b, isMe: !!me && d.svc.feed.isOwner(b, me.id) }));
    sendJson(res, { kind: q.kind, bets });
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
