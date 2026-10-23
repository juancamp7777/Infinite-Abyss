import { Router } from 'express';
import { z } from 'zod';
import { emailSchema } from '../../../domain/accounts/passwordPolicy';
import type { AuthService } from '../../../application/auth/AuthService';
import type { BackofficeTwoFactor } from '../../../application/auth/BackofficeTwoFactor';
import type { HttpGuards } from '../types';

export interface BackofficeAuthRoutesDeps extends Pick<HttpGuards, 'rateLimit'>, Partial<Pick<HttpGuards, 'requireBackoffice'>> {
  authService: AuthService;
  twoFactor?: BackofficeTwoFactor;
}

const code = z.string().trim().min(6).max(20);
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200), code: code.optional() });

export function createBackofficeAuthRouter(deps: BackofficeAuthRoutesDeps): Router {
  const r = Router();
  r.post('/api/backoffice/auth/login', deps.rateLimit.login, async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json(await deps.authService.loginBackoffice(body));
  });

  // Verificación en dos pasos de la propia cuenta (cualquier rol del backoffice).
  const tf = deps.twoFactor;
  if (tf && deps.requireBackoffice) {
    const me = deps.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT', 'OPERATOR_FINANCE'], { enforceTenant: false });
    const uid = (req: Parameters<typeof me>[0]) => req.backoffice!.backofficeUserId;
    r.get('/api/backoffice/auth/2fa', me, async (req, res) => {
      res.json(await tf.getStatus(uid(req)));
    });
    r.post('/api/backoffice/auth/2fa/setup', me, deps.rateLimit.login, async (req, res) => {
      res.json(await tf.setup(uid(req)));
    });
    r.post('/api/backoffice/auth/2fa/enable', me, deps.rateLimit.login, async (req, res) => {
      res.json(await tf.enable(uid(req), z.object({ code }).parse(req.body).code));
    });
    r.post('/api/backoffice/auth/2fa/disable', me, deps.rateLimit.login, async (req, res) => {
      const b = z.object({ password: z.string().min(1).max(200), code }).parse(req.body);
      res.json(await tf.disable(uid(req), b.password, b.code));
    });
  }
  return r;
}
