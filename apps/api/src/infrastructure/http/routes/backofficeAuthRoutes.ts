import { Router } from 'express';
import { z } from 'zod';
import { emailSchema } from '../../../domain/accounts/passwordPolicy';
import type { AuthService } from '../../../application/auth/AuthService';
import type { HttpGuards } from '../types';

export interface BackofficeAuthRoutesDeps extends Pick<HttpGuards, 'rateLimit'> {
  authService: AuthService;
}

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

export function createBackofficeAuthRouter(deps: BackofficeAuthRoutesDeps): Router {
  const r = Router();
  r.post('/api/backoffice/auth/login', deps.rateLimit.login, async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json(await deps.authService.loginBackoffice(body));
  });
  return r;
}
