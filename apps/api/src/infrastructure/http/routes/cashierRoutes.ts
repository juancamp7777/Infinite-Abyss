import { Router } from 'express';
import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../../domain/errors/AppError';
import { parseMinorUnits } from '../../../domain/money';
import type { CreateDepositUseCase } from '../../../application/cashier/CreateDepositUseCase';
import type { RequestWithdrawalUseCase } from '../../../application/cashier/RequestWithdrawalUseCase';
import type { PaymentProviderRegistry } from '../../payments/PaymentProviderRegistry';
import type { HttpGuards } from '../types';
import { toJsonSafe } from '../serialize';

export interface CashierRoutesDeps extends HttpGuards {
  prisma: PrismaClient;
  registry: PaymentProviderRegistry;
  createDeposit: CreateDepositUseCase;
  requestWithdrawal: RequestWithdrawalUseCase;
}

/** Monto como string de dígitos en unidades mínimas. */
const amountSchema = z
  .string()
  .regex(/^[0-9]{1,19}$/, 'amount must be a digits-only string in minor units')
  .transform((v, ctx) => {
    try {
      return parseMinorUnits(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  });

const providerSchema = z.enum(['PASSIMPAY', 'WOMPI', 'BOLD']);
const currencySchema = z.string().regex(/^[A-Z]{3,5}$/);

const depositBody = z.object({
  provider: providerSchema,
  amount: amountSchema,
  currency: currencySchema,
});

const destinationSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(200), z.number().finite()]))
  .refine((d) => Object.keys(d).length > 0 && Object.keys(d).length <= 10, 'destination must have 1-10 fields');

const withdrawalBody = z.object({
  provider: providerSchema,
  amount: amountSchema,
  currency: currencySchema,
  destination: destinationSchema,
});

const pageQuery = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw AppError.validation('Datos inválidos', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

/** Nombre que ve el jugador en la caja. */
const METHOD_LABELS: Record<string, string> = { BOLD: 'PSE, Nequi o tarjeta', WOMPI: 'Wompi', PASSIMPAY: 'Cripto' };

/** Cajero del jugador. Todas las rutas exigen jugador autenticado + rate limit de cajero. */
export function createCashierRouter(deps: CashierRoutesDeps): Router {
  const router = Router();
  router.use(deps.resolveTenant, deps.requirePlayer, deps.rateLimit.cashier);

  router.get('/methods', async (req, res) => {
    const tenant = req.tenant!;
    res.json({
      methods: (await deps.registry.listEnabledFor(tenant.operatorId)).map((p) => ({
        provider: p.code,
        ...(METHOD_LABELS[p.code] ? { label: METHOD_LABELS[p.code] } : {}),
        currencies: tenant.currencies,
        minDeposit: tenant.limits.minDeposit ?? null,
        maxDeposit: tenant.limits.maxDeposit ?? null,
      })),
    });
  });

  router.post('/deposits', async (req, res) => {
    const body = parseOrThrow(depositBody, req.body);
    const out = await deps.createDeposit.execute({
      auth: req.player!,
      tenant: req.tenant!,
      provider: body.provider,
      amount: body.amount,
      currency: body.currency,
    });
    res.status(201).json(toJsonSafe(out));
  });

  router.post('/withdrawals', async (req, res) => {
    const body = parseOrThrow(withdrawalBody, req.body);
    const w = await deps.requestWithdrawal.execute({
      auth: req.player!,
      tenant: req.tenant!,
      provider: body.provider,
      amount: body.amount,
      currency: body.currency,
      destination: body.destination,
      ip: clientIp(req),
    });
    res.status(201).json(toJsonSafe(publicWithdrawal(w)));
  });

  router.get('/withdrawals', async (req, res) => {
    const q = parseOrThrow(pageQuery, req.query);
    const rows = await deps.prisma.withdrawal.findMany({
      where: { userId: req.player!.userId, operatorId: req.player!.operatorId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit);
    res.json(
      toJsonSafe({
        items: items.map(publicWithdrawal),
        nextCursor: rows.length > q.limit ? items[items.length - 1].id : null,
      }),
    );
  });

  /**
   * Historial unificado (depósitos, retiros, movimientos de saldo) paginado por cursor de fecha:
   * `cursor` = createdAt ISO del último elemento recibido.
   */
  router.get('/transactions', async (req, res) => {
    const q = parseOrThrow(pageQuery, req.query);
    const { userId, operatorId } = req.player!;
    let before: Date | undefined;
    if (q.cursor) {
      before = new Date(q.cursor);
      if (Number.isNaN(before.getTime())) throw AppError.validation('Cursor inválido');
    }
    const createdAt = before ? { lt: before } : undefined;
    const take = q.limit + 1;
    const [deposits, withdrawals, entries] = await Promise.all([
      deps.prisma.deposit.findMany({
        where: { userId, operatorId, createdAt },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      deps.prisma.withdrawal.findMany({
        where: { userId, operatorId, createdAt },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      deps.prisma.ledgerEntry.findMany({
        where: { operatorId, createdAt, account: { userId, type: 'PLAYER_CASH' } },
        include: { transaction: { select: { type: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);
    const merged = [
      ...deposits.map((d) => ({
        kind: 'DEPOSIT' as const,
        id: d.id,
        status: d.status,
        provider: d.provider,
        amount: d.amount,
        currency: d.currency,
        createdAt: d.createdAt,
      })),
      ...withdrawals.map((w) => ({
        kind: 'WITHDRAWAL' as const,
        id: w.id,
        status: w.status,
        provider: w.provider,
        amount: w.amount,
        currency: w.currency,
        createdAt: w.createdAt,
      })),
      ...entries.map((e) => ({
        kind: 'MOVEMENT' as const,
        id: e.id,
        type: e.transaction.type,
        amount: e.amount,
        currency: e.currency,
        createdAt: e.createdAt,
      })),
    ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = merged.slice(0, q.limit);
    res.json(
      toJsonSafe({
        items,
        nextCursor: merged.length > q.limit ? items[items.length - 1].createdAt.toISOString() : null,
      }),
    );
  });

  return router;
}

function publicWithdrawal(w: {
  id: string;
  status: string;
  provider: string;
  amount: bigint;
  currency: string;
  rejectionReason: string | null;
  createdAt: Date;
}) {
  return {
    id: w.id,
    status: w.status,
    provider: w.provider,
    amount: w.amount,
    currency: w.currency,
    rejectionReason: w.rejectionReason,
    createdAt: w.createdAt,
  };
}
