import { Router } from 'express';
import { z } from 'zod';
import type { ReviewWithdrawalUseCase } from '../../../application/cashier/ReviewWithdrawalUseCase';
import type { HttpGuards } from '../types';
import { toJsonSafe } from '../serialize';
import { parseOrThrow } from './cashierRoutes';

export interface BackofficeWithdrawalRoutesDeps extends HttpGuards {
  review: ReviewWithdrawalUseCase;
}

const listQuery = z.object({
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'PAID', 'FAILED']).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  operatorId: z.string().uuid().optional(),
});
const idParams = z.object({ id: z.string().uuid() });
const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Retiros en backoffice. Sin resolveTenant: el PLATFORM_ADMIN no tiene tenant; el aislamiento
 * por operador lo aplican los casos de uso (un OPERATOR_* solo ve/actúa sobre su operador).
 */
export function createBackofficeWithdrawalRouter(deps: BackofficeWithdrawalRoutesDeps): Router {
  const router = Router();
  const viewers = deps.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_FINANCE', 'OPERATOR_SUPPORT'], {
    enforceTenant: false,
  });
  const reviewers = deps.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_FINANCE'], {
    enforceTenant: false,
  });
  const finance = deps.requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_FINANCE'], { enforceTenant: false });

  router.get('/', viewers, async (req, res) => {
    const q = parseOrThrow(listQuery, req.query);
    res.json(toJsonSafe(await deps.review.list(req.backoffice!, q)));
  });

  router.post('/:id/approve', reviewers, async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    res.json(toJsonSafe(await deps.review.approve(req.backoffice!, id, { ip: req.ip })));
  });

  router.post('/:id/reject', reviewers, async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    const { reason } = parseOrThrow(rejectBody, req.body);
    res.json(toJsonSafe(await deps.review.reject(req.backoffice!, id, reason, { ip: req.ip })));
  });

  router.post('/:id/mark-paid', finance, async (req, res) => {
    const { id } = parseOrThrow(idParams, req.params);
    res.json(toJsonSafe(await deps.review.markPaid(req.backoffice!, id, { ip: req.ip })));
  });

  return router;
}
