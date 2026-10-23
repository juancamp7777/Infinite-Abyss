import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { requireAuth, requirePlayer, requireRole, scopeOperator, getPrincipal } from '../../shared/http/auth';
import { asyncHandler, moduleErrorHandler, sendJson } from '../../shared/http/errors';
import { parse } from '../../shared/http/validate';
import type { ModuleLogger } from '../../shared/module';
import type { LeviathanService } from '../application/LeviathanService';
import { isRoomCode } from '../domain/rules';

const idParams = z.object({ id: z.string().uuid() });
const minor = z.string().regex(/^\d{1,15}$/, 'Monto inválido').transform((v) => BigInt(v));
const opQuery = z.object({ operatorId: z.string().max(100).optional() });

/** HTTP de Leviathan: jugador (lobby, inscripción, apuestas, salas de amigos) y administración del casino. */
export function buildLeviathanRouter(d: { auth: AuthPort; lev: LeviathanService; logger?: ModuleLogger }): Router {
  const r = Router();
  const auth = requireAuth(d.auth);
  const admin = [auth, requireRole('PLATFORM_ADMIN', 'OPERATOR_ADMIN')];
  const op = (req: Request) => scopeOperator(req, parse(opQuery, req.query).operatorId);

  /* ─── Jugador ─── */
  r.get('/games', auth, asyncHandler(async (req, res) => {
    const p = getPrincipal(req);
    sendJson(res, { items: await d.lev.lobby(p.operatorId ?? '') });
  }));
  r.get('/me/games', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    sendJson(res, { items: await d.lev.myGames(operatorId, playerId) });
  }));
  r.get('/games/:id', auth, asyncHandler(async (req, res) => {
    const p = getPrincipal(req);
    sendJson(res, await d.lev.detail(p.operatorId ?? '', parse(idParams, req.params).id, p.playerId));
  }));
  r.post('/games/:id/join', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    sendJson(res, await d.lev.join(operatorId, playerId, parse(idParams, req.params).id), 201);
  }));
  r.post('/games/:id/bets', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const b = parse(z.object({ selectionId: z.string().uuid(), stake: minor, oddsE2: z.number().int().min(101).max(100_000) }), req.body);
    sendJson(res, await d.lev.placeBet(operatorId, playerId, parse(idParams, req.params).id, b), 201);
  }));
  /** Sala de amigos: el jugador la crea y comparte el código. */
  r.post('/friends', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const b = parse(z.object({ title: z.string().trim().min(2).max(80), entry: minor, maxPlayers: z.number().int().min(2).max(20).default(20) }), req.body);
    const g = await d.lev.createGame({ operatorId, mode: 'FRIENDS', title: b.title, entry: b.entry, maxPlayers: b.maxPlayers, createdBy: playerId });
    await d.lev.join(operatorId, playerId, g.id);
    sendJson(res, g, 201);
  }));
  r.post('/rooms/:code/join', auth, asyncHandler(async (req, res) => {
    const { operatorId, playerId } = requirePlayer(req);
    const code = String(req.params.code ?? '').toUpperCase();
    if (!isRoomCode(code)) return sendJson(res, { error: { code: 'BAD_REQUEST', message: 'Código de sala inválido' } }, 400);
    sendJson(res, await d.lev.joinByCode(operatorId, playerId, code), 201);
  }));

  /* ─── Administración ─── */
  r.get('/admin/games', ...admin, asyncHandler(async (req, res) => sendJson(res, { items: await d.lev.adminList(op(req)) })));
  r.post('/admin/games', ...admin, asyncHandler(async (req, res) => {
    const b = parse(z.object({
      title: z.string().trim().min(2).max(80), entry: minor, startsInMin: z.number().int().min(1).max(10_080).default(10), durationMin: z.number().int().min(30).max(1_440).default(120),
      maxPlayers: z.number().int().min(2).max(100).default(100), sport: z.enum(['football', 'basketball', 'baseball']).optional(),
    }), req.body);
    sendJson(res, await d.lev.createGame({ operatorId: op(req), mode: 'QUICK', ...b, createdBy: getPrincipal(req).userId }), 201);
  }));
  r.post('/admin/games/:id/cancel', ...admin, asyncHandler(async (req, res) => {
    const { id } = parse(idParams, req.params);
    await d.lev.detail(op(req), id); // valida que el concurso sea del casino
    sendJson(res, await d.lev.cancel(id, 'OPS_CANCEL'));
  }));

  r.use(moduleErrorHandler(d.logger));
  return r;
}
