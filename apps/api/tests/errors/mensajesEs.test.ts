import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors/AppError';
import { errorHandler, notFoundHandler } from '../../src/infrastructure/http/middlewares/errorHandler';

/** Respuesta simulada de Express para capturar status y cuerpo del manejador. */
function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('mensajes de error visibles en español', () => {
  it('AppError de fábrica usa textos en español y conserva code y status', () => {
    expect(AppError.unauthorized()).toMatchObject({ message: 'Debes iniciar sesión', code: 'UNAUTHORIZED', statusCode: 401 });
    expect(AppError.forbidden()).toMatchObject({ message: 'No tienes permiso para esta acción', code: 'FORBIDDEN', statusCode: 403 });
    expect(AppError.notFound()).toMatchObject({ message: 'No encontrado', code: 'NOT_FOUND', statusCode: 404 });
    expect(AppError.insufficientFunds()).toMatchObject({ message: 'Saldo insuficiente para realizar la apuesta', code: 'INSUFFICIENT_FUNDS' });
    expect(AppError.kycRequired()).toMatchObject({ message: 'Se requiere verificación de identidad (KYC)', code: 'KYC_REQUIRED' });
  });

  it('errorHandler responde en español sin cambiar el código', () => {
    const res = fakeRes();
    errorHandler(AppError.limitExceeded('El monto supera el retiro máximo'), { method: 'POST', path: '/x' } as never, res as never, (() => {}) as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: 'LIMIT_EXCEEDED', message: 'El monto supera el retiro máximo' } });
  });

  it('ruta inexistente responde en español', () => {
    const res = fakeRes();
    notFoundHandler({} as never, res as never, (() => {}) as never);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
  });
});
