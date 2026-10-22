import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { IWalletService } from '../../../domain/contracts';
import { AppError } from '../../../domain/errors/AppError';
import { emailSchema, passwordSchema } from '../../../domain/accounts/passwordPolicy';
import { AuthService, toPublicUser } from '../../../application/auth/AuthService';
import { toJsonSafe } from '../serialize';
import type { HttpGuards } from '../types';

export interface AuthRoutesDeps extends HttpGuards {
  authService: AuthService;
  prisma: PrismaClient;
  /** IWalletService (solo se usa getBalances). */
  wallet: Pick<IWalletService, 'getBalances'>;
}

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
});
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

export function createAuthRouter(deps: AuthRoutesDeps): Router {
  const r = Router();
  const meta = (req: import('express').Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

  r.post('/api/auth/register', deps.resolveTenant, deps.rateLimit.login, async (req, res) => {
    const body = registerSchema.parse(req.body);
    res.status(201).json(toJsonSafe(await deps.authService.register(req.tenant!, body, meta(req))));
  });

  r.post('/api/auth/login', deps.resolveTenant, deps.rateLimit.login, async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json(toJsonSafe(await deps.authService.login(req.tenant!, body, meta(req))));
  });

  r.post('/api/auth/refresh', deps.resolveTenant, async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    res.json(toJsonSafe(await deps.authService.refresh(req.tenant!, refreshToken, meta(req))));
  });

  r.post('/api/auth/logout', deps.resolveTenant, async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await deps.authService.logout(req.tenant!, refreshToken);
    res.status(204).end();
  });

  r.get('/api/me', deps.resolveTenant, deps.requirePlayer, async (req, res) => {
    const p = req.player!;
    const user = await deps.prisma.user.findUnique({ where: { id: p.userId } });
    if (!user) throw AppError.unauthorized();
    const balances = await deps.wallet.getBalances({ operatorId: p.operatorId, userId: p.userId });
    res.json(toJsonSafe({ user: toPublicUser(user), balances }));
  });

  return r;
}
