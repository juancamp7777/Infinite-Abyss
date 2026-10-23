import { usdtMicro } from './crypto';
import type { BankAccount, PearlSettings } from './types';

/**
 * Multimoneda de la caja: el casino lleva el saldo en su moneda (p. ej. COP) y acepta pagos en otras
 * (ARS, MXN, USDT) que se convierten con la tasa que fija el operador en Pearl.
 */
export const CURRENCY_BY_COUNTRY: Record<string, string> = { CO: 'COP', MX: 'MXN', AR: 'ARS' };

/** Proveedores de feed bancario argentinos: sus movimientos vienen en ARS. */
export const FEED_CURRENCY: Record<string, string> = { quikipay: 'ARS', hgcash: 'ARS' };

/** Moneda en la que se recibe en una cuenta: Binance = USDT; si no, la del país de la cuenta. */
export function accountCurrency(a: Pick<BankAccount, 'bank' | 'country'>, fallback: string): string {
  if (a.bank?.startsWith('binance')) return 'USDT';
  return (a.country && CURRENCY_BY_COUNTRY[a.country]) || fallback;
}

/** Tasa del operador: unidades de la moneda del casino por 1 unidad de `currency`. null si no la configuró. */
export function rateFor(s: Pick<PearlSettings, 'usdtRate' | 'fxRates'>, currency: string): string | null {
  if (currency === 'USDT') return s.usdtRate || null;
  return s.fxRates?.[currency] || null;
}

/**
 * Convierte un monto (unidades mínimas de su moneda) a unidades mínimas de la moneda del casino.
 * Redondea hacia abajo: nunca se acredita de más.
 */
export function convertMinor(amount: bigint, fromDecimals: number, rate: string, toDecimals: number): bigint | null {
  const r = usdtMicro(rate); // tasa con 6 decimales
  if (!r || r <= 0n) return null;
  return (amount * r * 10n ** BigInt(toDecimals)) / (10n ** BigInt(fromDecimals) * 1_000_000n);
}
