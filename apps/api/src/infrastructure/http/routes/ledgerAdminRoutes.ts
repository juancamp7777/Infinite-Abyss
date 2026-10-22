import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../../domain/errors/AppError';
import type { IReconciliationService, IWalletService } from '../../../domain/contracts';
import { parseSignedMinorUnits } from '../../../domain/money';
import { toJsonSafe } from '../serialize';
import type { HttpGuards } from '../types';

export interface LedgerAdminDeps extends HttpGuards {
  walletService: IWalletService;
  reconciliationService: IReconciliationService;
  prisma: PrismaClient;
}

const reconciliationQuery = z.object({ operatorId: z.uuid().optional() });

const adjustmentBody = z.object({
  amount: z.string().regex(/^-?[0-9]+$/, 'amount must be an integer string in minor units'),
  reason: z.string().trim().min(1, 'reason is required').max(500),
  currency: z.string().trim().min(2).max(10).optional(),
});

const idempotencyHeader = z.string().trim().min(8).max(120);

/** Envuelve el handler: AppError/zod → { error: { code, message } } sin depender del error handler global. */
const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof z.ZodError) {
        res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: e.issues.map((i) => i.message).join('; ') } });
      } else if (e instanceof AppError) {
        res.status(e.statusCode).json({ error: { code: e.code, message: e.message } });
      } else {
        next(e);
      }
    }
  };

export function createLedgerAdminRouter(deps: LedgerAdminDeps): Router {
  const { walletService, reconciliationService, prisma, requireBackoffice } = deps;
  const router = Router();
  // El alcance por operador lo fuerza este router a partir del usuario de backoffice.
  const opts = { enforceTenant: false };

  const scopeOf = (req: Request): string | null => {
    const bo = req.backoffice;
    if (!bo) throw AppError.unauthorized();
    return bo.role === 'PLATFORM_ADMIN' ? null : bo.operatorId;
  };

  router.get(
    '/api/backoffice/reconciliation',
    requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_FINANCE'], opts),
    handle(async (req, res) => {
      const forced = scopeOf(req);
      const q = reconciliationQuery.parse(req.query);
      if (req.backoffice!.role !== 'PLATFORM_ADMIN' && !forced) throw AppError.forbidden('Se requiere un operador específico');
      const operatorId = forced ?? q.operatorId;
      res.json(toJsonSafe(await reconciliationService.run({ operatorId })));
    }),
  );

  router.post(
    '/api/backoffice/players/:id/adjustments',
    requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_FINANCE'], opts),
    handle(async (req, res) => {
      const bo = req.backoffice!;
      const playerId = z.uuid().parse(req.params.id);
      const body = adjustmentBody.parse(req.body ?? {});
      let amount: bigint;
      try {
        amount = parseSignedMinorUnits(body.amount);
      } catch (e) {
        throw AppError.validation((e as Error).message);
      }
      const headerKey = req.header('Idempotency-Key');
      const idempotencyKey = headerKey ? `adj:${idempotencyHeader.parse(headerKey)}` : `adj:${randomUUID()}`;

      const player = await prisma.user.findUnique({ where: { id: playerId } });
      // Un usuario de operador no distingue "no existe" de "es de otro operador".
      if (!player || (bo.operatorId && player.operatorId !== bo.operatorId)) throw AppError.notFound('Jugador no encontrado');
      const currency = body.currency ?? player.currency;

      const result = await walletService.manualAdjustment({
        operatorId: player.operatorId,
        userId: player.id,
        currency,
        idempotencyKey,
        amount,
        reason: body.reason,
        actorBackofficeUserId: bo.backofficeUserId,
      });
      res.status(result.idempotentReplay ? 200 : 201).json(toJsonSafe({ ...result, idempotencyKey }));
    }),
  );

  router.get(
    '/api/backoffice/stats',
    requireBackoffice(['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_SUPPORT', 'OPERATOR_FINANCE'], opts),
    handle(async (req, res) => {
      const forced = scopeOf(req);
      const q = reconciliationQuery.parse(req.query);
      if (req.backoffice!.role !== 'PLATFORM_ADMIN' && !forced) throw AppError.forbidden('Se requiere un operador específico');
      const operatorId = forced ?? q.operatorId;
      const opFilter = operatorId ? { operatorId } : {};

      const [players, balances, sessions] = await Promise.all([
        prisma.user.count({ where: opFilter }),
        prisma.ledgerAccount.groupBy({
          by: ['type', 'currency'],
          where: { ...opFilter, type: { in: ['PLAYER_CASH', 'PLAYER_BONUS', 'HOUSE'] } },
          _sum: { balance: true },
        }),
        prisma.playerSession.findMany({
          where: opFilter,
          orderBy: { startedAt: 'desc' },
          take: 20,
          select: { id: true, userId: true, operatorId: true, startedAt: true, lastSeenAt: true, endedAt: true },
        }),
      ]);

      const liability: Record<string, bigint> = {};
      const ggr: Record<string, bigint> = {};
      for (const b of balances) {
        const sum = b._sum.balance ?? 0n;
        if (b.type === 'HOUSE') ggr[b.currency] = (ggr[b.currency] ?? 0n) + sum;
        else liability[b.currency] = (liability[b.currency] ?? 0n) + sum;
      }
      res.json(
        toJsonSafe({
          scope: operatorId ?? 'ALL',
          players,
          // Pasivo = lo que se le debe a los jugadores (CASH + BONUS); GGR = saldo de la cuenta HOUSE.
          liability,
          ggr,
          recentSessions: sessions,
        }),
      );
    }),
  );

  return router;
}
