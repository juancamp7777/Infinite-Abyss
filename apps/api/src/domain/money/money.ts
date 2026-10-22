import { currencyDecimals } from './currencies';

/** Tope de un monto individual: 10^18 unidades mínimas (cabe de sobra en BIGINT de Postgres). */
export const MAX_MINOR_UNITS = 10n ** 18n;

const DIGITS_RE = /^[0-9]+$/;

/**
 * Convierte un string de solo dígitos (unidades mínimas) a bigint.
 * Rechaza vacíos, signos, decimales, ceros y valores sobre el tope.
 */
export function parseMinorUnits(value: unknown, max: bigint = MAX_MINOR_UNITS): bigint {
  if (typeof value !== 'string' || !DIGITS_RE.test(value) || value.length > 19) {
    throw new Error('Invalid amount: expected a digits-only string in minor units');
  }
  const n = BigInt(value);
  if (n <= 0n) throw new Error('Invalid amount: must be greater than zero');
  if (n > max) throw new Error('Invalid amount: exceeds maximum');
  return n;
}

/** Igual que parseMinorUnits pero acepta con signo (ajustes manuales); no admite 0. */
export function parseSignedMinorUnits(value: unknown, max: bigint = MAX_MINOR_UNITS): bigint {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value) || value.length > 20) {
    throw new Error('Invalid amount: expected an integer string in minor units');
  }
  const n = BigInt(value);
  if (n === 0n) throw new Error('Invalid amount: must not be zero');
  if (n > max || n < -max) throw new Error('Invalid amount: exceeds maximum');
  return n;
}

/** Formatea unidades mínimas a texto decimal legible (p. ej. 123456n COP → "1234.56"). */
export function formatMinor(amount: bigint, currency: string): string {
  const decimals = currencyDecimals(currency);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return `${negative ? '-' : ''}${int}${decimals > 0 ? '.' + frac : ''}`;
}

const MULTIPLIER_SCALE = 1_000_000;

/**
 * amount × multiplier sin floats sobre el monto: el multiplicador se escala a entero
 * con 1e6 (redondeo al más cercano de ese paso) y el resultado se redondea hacia abajo.
 */
export function applyMultiplier(amount: bigint, multiplier: number): bigint {
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new Error('Invalid multiplier');
  }
  const scaled = BigInt(Math.round(multiplier * MULTIPLIER_SCALE));
  return (amount * scaled) / BigInt(MULTIPLIER_SCALE);
}
