import type { RequestHandler } from 'express';
import type { BackofficeAuth, BackofficeRoleName, PlayerAuth, TenantContext } from '../../domain/contracts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
      player?: PlayerAuth;
      backoffice?: BackofficeAuth;
      /**
       * Cuerpo crudo para verificar firmas: lo fijan las rutas de webhook (express.raw) y el Hub
       * (express.json con verify: captureRawBody). Buffer, igual que la declaración del módulo hub.
       */
      rawBody?: Buffer;
    }
  }
}

export interface RequireBackofficeOptions {
  /** Si true (por defecto), un rol de operador solo opera sobre su propio tenant resuelto. */
  enforceTenant?: boolean;
}

/**
 * Middlewares inyectados a los routers: `createXRouter(deps & HttpGuards)`.
 * Los construye s3 (auth/tenancy) y los cablea s8 (app.ts).
 */
export interface HttpGuards {
  /** Resuelve req.tenant (cabecera/host); 404 si no existe, 403 si no está ACTIVE. */
  resolveTenant: RequestHandler;
  /** Exige Bearer válido de jugador y que pertenezca a req.tenant; fija req.player. */
  requirePlayer: RequestHandler;
  /** Exige Bearer de backoffice con alguno de los roles; fija req.backoffice. */
  requireBackoffice: (roles: BackofficeRoleName[], opts?: RequireBackofficeOptions) => RequestHandler;
  rateLimit: { login: RequestHandler; cashier: RequestHandler };
}

export type { BackofficeRoleName };
