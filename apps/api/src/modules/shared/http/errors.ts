import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { MoneyError, toJSONSafe } from '../money';
import { WalletError } from '../ports/WalletPort';

/** Formato de error HTTP de todos los módulos: { error: { code, message, details? } }. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);
export const notFound = (message = 'No encontrado') => new HttpError(404, 'NOT_FOUND', message);
export const forbidden = (message = 'Prohibido') => new HttpError(403, 'FORBIDDEN', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

const WALLET_STATUS: Record<WalletError['code'], number> = {
  INSUFFICIENT_FUNDS: 402,
  UNKNOWN_TRANSACTION: 404,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_AMOUNT: 400,
  ALREADY_ROLLED_BACK: 409,
};

/** Traduce cualquier error a status + cuerpo estándar. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: toJSONSafe(err.details) } : {}) } } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Datos inválidos', details: err.issues } } };
  }
  if (err instanceof WalletError) {
    return { status: WALLET_STATUS[err.code] ?? 400, body: { error: { code: err.code, message: err.message } } };
  }
  if (err instanceof MoneyError) {
    return { status: 400, body: { error: { code: 'INVALID_AMOUNT', message: err.message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Error interno' } } };
}

/** Envuelve handlers async (Express 5 ya propaga rechazos, pero esto unifica estilos y tipos). */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req as Req, res, next))
      .catch(next);
  };
}

/** Envía JSON convirtiendo bigint→string (y Date→ISO). */
export function sendJson(res: Response, data: unknown, status = 200): void {
  res.status(status).type('application/json').send(JSON.stringify(toJSONSafe(data)));
}

/** Manejador de errores para montar al final del router de cada módulo. */
export function moduleErrorHandler(logger?: { error(msg: string, meta?: Record<string, unknown>): unknown }): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) {
      logger?.error(`Error no controlado en ${req.method} ${req.originalUrl}`, {
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  };
}
