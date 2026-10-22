import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Desactiva ambos limitadores (tests). */
  disabled?: boolean;
  loginMax?: number;
  loginWindowMs?: number;
  cashierMax?: number;
  cashierWindowMs?: number;
}

const handler: RequestHandler = (_req, res) => {
  res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes, intenta de nuevo más tarde' } });
};

const ip = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

/**
 * login: por IP + email (10 intentos fallidos cada 15 min por defecto; los exitosos no cuentan).
 * cashier: por jugador autenticado o IP (30/min por defecto).
 */
export function createRateLimiters(opts: RateLimitOptions = {}): { login: RequestHandler; cashier: RequestHandler } {
  const common = { standardHeaders: true, legacyHeaders: false, handler, skip: () => !!opts.disabled };
  const login = rateLimit({
    ...common,
    windowMs: opts.loginWindowMs ?? 15 * 60_000,
    limit: opts.loginMax ?? 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
      return `${ip(req)}|${email}`;
    },
  });
  const cashier = rateLimit({
    ...common,
    windowMs: opts.cashierWindowMs ?? 60_000,
    limit: opts.cashierMax ?? 30,
    keyGenerator: (req) => (req.player ? `u:${req.player.userId}` : `ip:${ip(req)}`),
  });
  return { login, cashier };
}
