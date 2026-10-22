import { z } from 'zod';
import { parseMinorUnits } from '../../../domain/money';

/** Tope de una apuesta individual por socket: 10^12 unidades mínimas. */
export const MAX_BET_MINOR_UNITS = 10n ** 12n;

/** `amount`: string de dígitos en unidades mínimas → bigint (>0, con tope). */
export const amountSchema = z.string().transform((value, ctx) => {
  try {
    return parseMinorUnits(value, MAX_BET_MINOR_UNITS);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid amount' });
    return z.NEVER;
  }
});

export const requestIdSchema = z.string().uuid().optional();

export const betSchema = z.object({
  type: z.enum(['pleno', 'color']),
  value: z.union([z.number().min(0).max(36), z.enum(['red', 'black'])]),
  amount: amountSchema,
  requestId: requestIdSchema
}).refine((data) => {
  if (data.type === 'pleno' && typeof data.value !== 'number') return false;
  if (data.type === 'color' && typeof data.value !== 'string') return false;
  return true;
}, {
  message: "Invalid combination of bet type and value"
});

export type BetPayload = z.infer<typeof betSchema>;
