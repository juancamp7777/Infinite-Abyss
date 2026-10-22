import { HttpError } from '../../shared/http/errors';

/** Códigos de error estables de la API seamless wallet y del lado saliente de Nymfo Hub. */
export type HubErrorCode =
  | 'INVALID_SIGNATURE'
  | 'UNKNOWN_PROVIDER'
  | 'PROVIDER_DISABLED'
  | 'UNKNOWN_OPERATOR'
  | 'UNKNOWN_SESSION'
  | 'SESSION_EXPIRED'
  | 'SESSION_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'DUPLICATE'
  | 'BET_ROLLED_BACK'
  | 'ROUND_NOT_FOUND'
  | 'ROUND_CLOSED'
  | 'BET_REJECTED'
  | 'GAME_NOT_FOUND'
  | 'GAME_UNAVAILABLE'
  | 'CURRENCY_MISMATCH'
  | 'REMOTE_WALLET_ERROR';

const STATUS: Record<HubErrorCode, number> = {
  INVALID_SIGNATURE: 401,
  UNKNOWN_PROVIDER: 401,
  PROVIDER_DISABLED: 403,
  UNKNOWN_OPERATOR: 401,
  UNKNOWN_SESSION: 404,
  SESSION_EXPIRED: 401,
  SESSION_MISMATCH: 403,
  INSUFFICIENT_FUNDS: 402,
  DUPLICATE: 409,
  BET_ROLLED_BACK: 409,
  ROUND_NOT_FOUND: 404,
  ROUND_CLOSED: 409,
  BET_REJECTED: 403,
  GAME_NOT_FOUND: 404,
  GAME_UNAVAILABLE: 403,
  CURRENCY_MISMATCH: 400,
  REMOTE_WALLET_ERROR: 502,
};

export function hubError(code: HubErrorCode, message?: string, details?: unknown): HttpError {
  return new HttpError(STATUS[code], code, message ?? code, details);
}
