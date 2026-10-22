import { z } from 'zod';
import { zAmount, zAmountOrZero } from '../../shared/http/validate';

/**
 * Protocolo seamless wallet estándar de Infinite Abyss (v1). Es el formato que hablan nuestros endpoints
 * /hub/v1/wallet/* y también el que enviamos a casinos remotos en el lado saliente.
 *
 * Cabeceras: X-Provider-Id (o X-Operator-Id en el saliente) y X-Signature = hex(HMAC-SHA256(secreto, rawBody)).
 * Montos como string entero en unidades mínimas.
 */

const zId = z.string().min(1).max(128);

export const balanceRequestSchema = z.object({
  sessionToken: z.string().min(8).max(256),
  playerId: zId.optional(),
  currency: z.string().min(3).max(10).optional(),
});

export const betRequestSchema = z.object({
  sessionToken: z.string().min(8).max(256),
  transactionId: zId,
  roundId: zId,
  gameId: zId.optional(),
  amount: zAmount,
  currency: z.string().min(3).max(10).optional(),
});

export const winRequestSchema = z.object({
  sessionToken: z.string().min(8).max(256),
  transactionId: zId,
  roundId: zId,
  gameId: zId.optional(),
  /** 0 permitido: cierra la ronda sin premio. */
  amount: zAmountOrZero,
  currency: z.string().min(3).max(10).optional(),
  /** Por defecto true: la ronda queda liquidada. false para premios parciales. */
  roundClosed: z.boolean().default(true),
  /** Premio de bonus/giros gratis del proveedor (puede llegar sin apuesta previa si el adaptador lo permite). */
  bonus: z.object({ type: z.enum(['free_rounds', 'promo']), id: zId }).optional(),
});

export const rollbackRequestSchema = z.object({
  sessionToken: z.string().min(8).max(256),
  transactionId: zId,
  /** transactionId de la operación (normalmente la apuesta) que se anula. */
  referenceTransactionId: zId,
  roundId: zId.optional(),
});

export type BalanceRequest = z.infer<typeof balanceRequestSchema>;
export type BetRequest = z.infer<typeof betRequestSchema>;
export type WinRequest = z.infer<typeof winRequestSchema>;
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

export type WalletAction = 'balance' | 'bet' | 'win' | 'rollback';

export const WALLET_SCHEMAS = {
  balance: balanceRequestSchema,
  bet: betRequestSchema,
  win: winRequestSchema,
  rollback: rollbackRequestSchema,
} as const;

export interface WalletOkResponse {
  status: 'OK';
  currency: string;
  /** Saldo total (cash + bonus). */
  balance: bigint;
  cash: bigint;
  bonus: bigint;
  /** Id de la transacción en Infinite Abyss Hub (ausente en balance). */
  transactionId?: string;
  /** transactionId recibido del proveedor. */
  providerTransactionId?: string;
}

export interface WalletErrorResponse {
  status: number;
  code: string;
  message: string;
}
