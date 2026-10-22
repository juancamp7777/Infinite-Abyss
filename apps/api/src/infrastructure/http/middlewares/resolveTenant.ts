import type { RequestHandler } from 'express';
import type { TenantResolver } from '../../../application/tenancy/TenantResolver';

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Resuelve req.tenant (X-Operator-Slug → X-Operator-Host → Host → slug por defecto en dev). */
export function createResolveTenant(resolver: TenantResolver): RequestHandler {
  return async (req, _res, next) => {
    try {
      req.tenant = await resolver.resolve({
        slugHeader: first(req.headers['x-operator-slug']),
        operatorHostHeader: first(req.headers['x-operator-host']),
        requestHost: first(req.headers.host),
      });
      next();
    } catch (e) {
      next(e);
    }
  };
}
