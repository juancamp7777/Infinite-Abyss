import { Router } from 'express';
import { z } from 'zod';
import type { ResponsibleGamingService, LimitInput } from '../../../application/responsible-gaming/ResponsibleGamingService';
import type { Guards } from '../middlewares/createGuards';

export interface PlayerAccountRoutesDeps extends Pick<Guards, 'resolveTenant' | 'requirePlayer' | 'requireBackoffice'> {
  rgService: ResponsibleGamingService;
}

const money = z.string().regex(/^[1-9][0-9]{0,17}$/, 'Must be a positive integer in minor units');
const limitsSchema = z
  .object({
    depositLimitDaily: money.nullable(),
    depositLimitWeekly: money.nullable(),
    depositLimitMonthly: money.nullable(),
    lossLimitDaily: money.nullable(),
    lossLimitWeekly: money.nullable(),
    lossLimitMonthly: money.nullable(),
    sessionTimeLimitMinutes: z.number().int().min(1).max(1440).nullable(),
  })
  .partial()
  .strict();

const exclusionSchema = z.union([
  z.object({ days: z.number().int().min(1).max(3650) }).strict(),
  z.object({ permanent: z.literal(true) }).strict(),
]);
const coolOffSchema = z.object({ hours: z.number().int().min(1).max(720) }).strict();
const kycReviewSchema = z
  .object({
    status: z.enum(['NONE', 'PENDING', 'VERIFIED', 'REJECTED']),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
const idParam = z.object({ id: z.uuid() });

export function createPlayerAccountRouter(deps: PlayerAccountRoutesDeps): Router {
  const r = Router();
  const player = [deps.resolveTenant, deps.requirePlayer];

  r.get('/api/me/limits', ...player, async (req, res) => {
    const p = req.player!;
    res.json(await deps.rgService.getLimits(p.userId, p.operatorId));
  });

  r.put('/api/me/limits', ...player, async (req, res) => {
    const p = req.player!;
    const body = limitsSchema.parse(req.body) as LimitInput;
    res.json(await deps.rgService.updateLimits(p.userId, p.operatorId, body));
  });

  r.post('/api/me/self-exclusion', ...player, async (req, res) => {
    const p = req.player!;
    const body = exclusionSchema.parse(req.body);
    res.json(await deps.rgService.selfExclude(p.userId, p.operatorId, body));
  });

  r.post('/api/me/cool-off', ...player, async (req, res) => {
    const p = req.player!;
    const { hours } = coolOffSchema.parse(req.body);
    res.json(await deps.rgService.coolOff(p.userId, p.operatorId, hours));
  });

  r.post('/api/me/kyc/submit', ...player, async (req, res) => {
    const p = req.player!;
    res.json(await deps.rgService.submitKyc(p.userId, p.operatorId));
  });

  // Backoffice: no requiere tenant; el alcance sale del rol y del operador del usuario.
  r.put(
    '/api/backoffice/players/:id/kyc',
    deps.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT']),
    async (req, res) => {
      const { id } = idParam.parse(req.params);
      const body = kycReviewSchema.parse(req.body);
      res.json(await deps.rgService.reviewKyc(req.backoffice!, id, body.status, body.reason, req.ip));
    },
  );

  return r;
}

