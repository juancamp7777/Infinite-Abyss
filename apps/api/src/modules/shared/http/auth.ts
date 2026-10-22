import { HttpError } from './errors';
import type { NextFunction, Request, Response } from 'express';
import { AuthPort, Principal, Role } from '../ports/AuthPort';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

function extractToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  return null;
}

/** Exige `Authorization: Bearer <token>` válido y deja el Principal en req.principal. */
export function requireAuth(auth: AuthPort) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractToken(req);
      const principal = token ? await auth.verify(token) : null;
      if (!principal) throw new HttpError(401, 'UNAUTHORIZED', 'Token ausente o inválido');
      req.principal = principal;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Igual que requireAuth pero no falla si no hay token (req.principal queda undefined). */
export function optionalAuth(auth: AuthPort) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractToken(req);
      if (token) req.principal = (await auth.verify(token)) ?? undefined;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Debe ir después de requireAuth. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) return next(new HttpError(401, 'UNAUTHORIZED', 'No autenticado'));
    if (!roles.includes(p.role)) return next(new HttpError(403, 'FORBIDDEN', 'Rol sin permiso'));
    next();
  };
}

/** Principal de req (lanza 401 si no hay). */
export function getPrincipal(req: Request): Principal {
  if (!req.principal) throw new HttpError(401, 'UNAUTHORIZED', 'No autenticado');
  return req.principal;
}

/**
 * Resuelve el operatorId efectivo:
 * - PLATFORM_ADMIN: el solicitado (o su operatorId si no pide ninguno); si ninguno, lanza 400.
 * - Resto de roles: siempre el de su token; si piden otro distinto → 403.
 */
export function scopeOperator(req: Request, requestedOperatorId?: string): string {
  const p = getPrincipal(req);
  if (p.role === 'PLATFORM_ADMIN') {
    const op = requestedOperatorId || p.operatorId;
    if (!op) throw new HttpError(400, 'OPERATOR_REQUIRED', 'Indica operatorId');
    return op;
  }
  if (!p.operatorId) throw new HttpError(403, 'FORBIDDEN', 'Principal sin operador');
  if (requestedOperatorId && requestedOperatorId !== p.operatorId) {
    throw new HttpError(403, 'FORBIDDEN', 'Fuera del alcance del operador');
  }
  return p.operatorId;
}

/**
 * Para PLATFORM_ADMIN sin operatorId solicitado devuelve undefined (= todos los operadores);
 * para los demás roles equivale a scopeOperator.
 */
export function scopeOperatorOptional(req: Request, requestedOperatorId?: string): string | undefined {
  const p = getPrincipal(req);
  if (p.role === 'PLATFORM_ADMIN') return requestedOperatorId || p.operatorId || undefined;
  return scopeOperator(req, requestedOperatorId);
}

/** Identidad del jugador tomada SIEMPRE del token (nunca del body). */
export function requirePlayer(req: Request): { operatorId: string; playerId: string } {
  const p = getPrincipal(req);
  if (p.role !== 'PLAYER' || !p.playerId || !p.operatorId) {
    throw new HttpError(403, 'FORBIDDEN', 'Solo jugadores');
  }
  return { operatorId: p.operatorId, playerId: p.playerId };
}
