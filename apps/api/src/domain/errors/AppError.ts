export type AppErrorCode =
  | 'APP_ERROR'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_BET'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_ERROR'
  | 'LIMIT_EXCEEDED'
  | 'SELF_EXCLUDED'
  | 'KYC_REQUIRED';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: AppErrorCode | string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number = 400,
    isOperational: boolean = true,
    code: AppErrorCode | string = 'APP_ERROR',
    details?: unknown,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    this.details = details;

    // Mantener la traza del stack correcta en V8
    Error.captureStackTrace(this, this.constructor);
  }

  public static insufficientFunds(): AppError {
    return new AppError('Saldo insuficiente para realizar la apuesta', 400, true, 'INSUFFICIENT_FUNDS');
  }

  public static invalidBet(): AppError {
    return new AppError('Configuración de apuesta inválida', 400, true, 'INVALID_BET');
  }

  public static unauthorized(message = 'Debes iniciar sesión'): AppError {
    return new AppError(message, 401, true, 'UNAUTHORIZED');
  }

  public static forbidden(message = 'No tienes permiso para esta acción'): AppError {
    return new AppError(message, 403, true, 'FORBIDDEN');
  }

  public static notFound(message = 'No encontrado'): AppError {
    return new AppError(message, 404, true, 'NOT_FOUND');
  }

  public static conflict(message = 'Conflicto con el estado actual'): AppError {
    return new AppError(message, 409, true, 'CONFLICT');
  }

  public static validation(message = 'Datos inválidos', details?: unknown): AppError {
    return new AppError(message, 422, true, 'VALIDATION_ERROR', details);
  }

  public static limitExceeded(message = 'Límite excedido'): AppError {
    return new AppError(message, 403, true, 'LIMIT_EXCEEDED');
  }

  public static selfExcluded(message = 'El jugador está autoexcluido'): AppError {
    return new AppError(message, 403, true, 'SELF_EXCLUDED');
  }

  public static kycRequired(message = 'Se requiere verificación de identidad (KYC)'): AppError {
    return new AppError(message, 403, true, 'KYC_REQUIRED');
  }
}
