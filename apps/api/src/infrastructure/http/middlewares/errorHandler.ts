import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../../domain/errors/AppError';
import { logger } from '../../logging/logger';

/** Mapea AppError y ZodError a {error:{code,message}} sin filtrar stack traces. */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Datos inválidos',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  // Errores de body-parser (JSON mal formado, cuerpo demasiado grande).
  const e = err as { type?: string; status?: number };
  if (e && typeof e.type === 'string' && e.type.startsWith('entity.') && typeof e.status === 'number') {
    res.status(e.status).json({ error: { code: 'BAD_REQUEST', message: 'El cuerpo de la solicitud no es válido' } });
    return;
  }
  logger.error(`Unhandled error on ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno del servidor' } });
};

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
};
