import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../../domain/errors/AppError';
import { currencyDecimals } from '../../../domain/money';
import { publicBetLimits } from '../../../modules/shared/betLimits';
import { toJsonSafe } from '../serialize';
import type { HttpGuards } from '../types';

export interface OperatorRoutesDeps extends Pick<HttpGuards, 'resolveTenant'> {
  prisma: PrismaClient;
}

function safeDecimals(currency: string): number | null {
  try {
    return currencyDecimals(currency);
  } catch {
    return null;
  }
}

const DEFAULT_COLORS = {
  primary: '#7c3aed',
  secondary: '#1e1b4b',
  accent: '#22d3ee',
  background: '#0b0b14',
  surface: '#151526',
  text: '#f5f5ff',
};

export function createOperatorRouter(deps: OperatorRoutesDeps): Router {
  const r = Router();

  /**
   * Pública: marca y datos mínimos del operador resuelto por tenant (sin secretos).
   * De Operator.limits solo se exponen los límites de apuesta (betLimits); nunca depósitos ni retiros.
   */
  r.get('/api/operator/brand', deps.resolveTenant, async (req, res) => {
    const t = req.tenant!;
    const op = await deps.prisma.operator.findUnique({ where: { id: t.operatorId }, include: { brand: true } });
    if (!op) throw AppError.notFound('Operador no encontrado');
    const decimals: Record<string, number> = {};
    for (const c of op.currencies) {
      try {
        decimals[c] = currencyDecimals(c);
      } catch {
        /* moneda no soportada: se omite */
      }
    }
    const currencies = op.currencies.includes(op.defaultCurrency) ? op.currencies : [op.defaultCurrency, ...op.currencies];
    const betLimits = publicBetLimits(op.limits, currencies, (c) => decimals[c] ?? safeDecimals(c));
    const b = op.brand;
    res.json(
      toJsonSafe({
        operator: {
          slug: op.slug,
          name: op.name,
          currencies: op.currencies,
          defaultCurrency: op.defaultCurrency,
          currencyDecimals: decimals,
          chipsEnabled: op.chipsEnabled,
          chipMinorUnitsPerChip: op.chipMinorUnitsPerChip,
          betLimits,
        },
        brand: {
          displayName: b?.displayName ?? op.name,
          logoUrl: b?.logoUrl ?? null,
          faviconUrl: b?.faviconUrl ?? null,
          colors: b?.colors ?? DEFAULT_COLORS,
          fontFamily: b?.fontFamily ?? 'Inter, sans-serif',
          legal: b?.legal ?? {},
        },
      }),
    );
  });
  return r;
}
