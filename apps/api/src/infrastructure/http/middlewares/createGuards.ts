import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { BackofficeRoleName, PlayerAuth } from '../../../domain/contracts';
import { AppError } from '../../../domain/errors/AppError';
import type { TenantResolver } from '../../../application/tenancy/TenantResolver';
import { JwtService, extractBearer } from '../../auth/JwtService';
import type { HttpGuards, RequireBackofficeOptions } from '../types';
import { createResolveTenant } from './resolveTenant';
import { createRateLimiters, type RateLimitOptions } from './rateLimit';

export interface BackofficeGuardOptions extends RequireBackofficeOptions {
  /** Nombre extra (param/query/body) que contiene un operatorId a comparar con el del usuario. */
  operatorParam?: string;
}

export interface CreateGuardsDeps {
  jwt: JwtService;
  prisma: PrismaClient;
  tenantResolver: TenantResolver;
  rateLimit?: RateLimitOptions;
}

export interface Guards extends Omit<HttpGuards, 'requireBackoffice'> {
  requireBackoffice: (roles: BackofficeRoleName[], opts?: BackofficeGuardOptions) => RequestHandler;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Implementa HttpGuards (resolveTenant, requirePlayer, requireBackoffice, rateLimit). */
export function createGuards(deps: CreateGuardsDeps): Guards {
  const { jwt, prisma } = deps;

  const requirePlayer: RequestHandler = async (req, _res, next) => {
    try {
      const token = extractBearer(req.headers.authorization);
      if (!token) throw AppError.unauthorized();
      const claims = jwt.verifyAccess(token);
      if (claims.typ !== 'player') throw AppError.unauthorized('Tipo de token inválido');
      if (!req.tenant) throw new Error('requirePlayer needs resolveTenant to run first');
      // Un jugador de A jamás opera en B.
      if (claims.op !== req.tenant.operatorId) throw AppError.forbidden('El token no pertenece a este operador');

      const user = await prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, operatorId: true, status: true, currency: true, isDemo: true },
      });
      if (!user || user.status !== 'ACTIVE') throw AppError.unauthorized();
      if (user.operatorId !== req.tenant.operatorId) throw AppError.forbidden('El token no pertenece a este operador');
      const auth: PlayerAuth = {
        kind: 'player',
        userId: user.id,
        operatorId: user.operatorId,
        currency: user.currency,
        isDemo: user.isDemo,
      };
      req.player = auth;
      next();
    } catch (e) {
      next(e);
    }
  };

  const requireBackoffice: Guards['requireBackoffice'] = (roles, opts = {}) => {
    const enforceTenant = opts.enforceTenant ?? true;
    return async (req, _res, next) => {
      try {
        const token = extractBearer(req.headers.authorization);
        if (!token) throw AppError.unauthorized();
        const claims = jwt.verifyAccess(token);
        if (claims.typ !== 'backoffice' || !claims.role) throw AppError.unauthorized('Tipo de token inválido');

        const user = await prisma.backofficeUser.findUnique({ where: { id: claims.sub } });
        if (!user || user.status !== 'ACTIVE') throw AppError.unauthorized();
        // El rol vigente es el de la BD (un cambio de rol surte efecto de inmediato).
        if (!roles.includes(user.role)) throw AppError.forbidden('Rol insuficiente');
        if (user.role !== 'PLATFORM_ADMIN' && !user.operatorId) throw AppError.forbidden();

        if (user.role !== 'PLATFORM_ADMIN') {
          const own = user.operatorId!;
          if (enforceTenant && req.tenant && req.tenant.operatorId !== own) {
            throw AppError.forbidden('No tienes acceso a este operador');
          }
          const body = (req.body ?? {}) as Record<string, unknown>;
          const named = opts.operatorParam
            ? [req.params?.[opts.operatorParam], req.query?.[opts.operatorParam], body[opts.operatorParam]]
            : [];
          const candidates = [
            req.params?.operatorId,
            req.query?.operatorId,
            body.operatorId,
            ...named,
          ].map(str);
          if (candidates.some((c) => c !== undefined && c !== own)) {
            throw AppError.forbidden('No tienes acceso a este operador');
          }
        }
        req.backoffice = {
          kind: 'backoffice',
          backofficeUserId: user.id,
          operatorId: user.role === 'PLATFORM_ADMIN' ? null : user.operatorId,
          role: user.role,
        };
        next();
      } catch (e) {
        next(e);
      }
    };
  };

  return {
    resolveTenant: createResolveTenant(deps.tenantResolver),
    requirePlayer,
    requireBackoffice,
    rateLimit: createRateLimiters(deps.rateLimit),
  };
}
