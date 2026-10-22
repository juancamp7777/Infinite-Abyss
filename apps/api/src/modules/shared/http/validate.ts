import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { parseAmount } from '../money';

/**
 * Validación zod para body/query/params. El resultado parseado queda en req.valid.{body,query,params}
 * (Express 5 hace req.query de solo lectura, por eso no se sobrescribe).
 */
declare module 'express-serve-static-core' {
  interface Request {
    valid?: { body?: unknown; query?: unknown; params?: unknown };
  }
}

type Part = 'body' | 'query' | 'params';

export function validate<S extends z.ZodType>(part: Part, schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const r = schema.safeParse(req[part] ?? {});
    if (!r.success) return next(r.error);
    req.valid = { ...(req.valid ?? {}), [part]: r.data };
    next();
  };
}

export const validateBody = <S extends z.ZodType>(schema: S) => validate('body', schema);
export const validateQuery = <S extends z.ZodType>(schema: S) => validate('query', schema);

/** Lee el dato validado con su tipo. */
export function valid<S extends z.ZodType>(req: Request, part: Part, _schema?: S): z.infer<S> {
  return req.valid?.[part] as z.infer<S>;
}

/** Parsea directamente (lanza ZodError → 400 VALIDATION_ERROR vía moduleErrorHandler). */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data);
}

/** Esquema zod de monto: acepta string/number entero ≥ 1 y devuelve bigint. */
export const zAmount = z.union([z.string(), z.number(), z.bigint()]).transform((v, ctx) => {
  try {
    return parseAmount(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'Monto inválido' });
    return z.NEVER;
  }
});

/** Igual que zAmount pero permite 0. */
export const zAmountOrZero = z.union([z.string(), z.number(), z.bigint()]).transform((v, ctx) => {
  try {
    return parseAmount(v, { allowZero: true });
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'Monto inválido' });
    return z.NEVER;
  }
});

/** Paginación estándar: ?limit=&offset= */
export const zPagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
