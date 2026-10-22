/**
 * Helpers de dinero. Todos los montos son enteros en unidades mínimas (bigint).
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Convierte string/number/bigint entero no negativo a bigint. Rechaza decimales, notación científica y negativos. */
export function parseAmount(value: unknown, opts: { allowZero?: boolean } = {}): bigint {
  let out: bigint;
  if (typeof value === 'bigint') {
    out = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new MoneyError('El monto debe ser un entero seguro');
    out = BigInt(value);
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!/^\d{1,30}$/.test(s)) throw new MoneyError('El monto debe ser un entero en unidades mínimas');
    out = BigInt(s);
  } else {
    throw new MoneyError('Monto inválido');
  }
  if (out < 0n) throw new MoneyError('El monto no puede ser negativo');
  if (out === 0n && !opts.allowZero) throw new MoneyError('El monto debe ser mayor que cero');
  return out;
}

/** Serializa bigint a string (seguro para JSON). */
export function amountToJSON(value: bigint): string {
  return value.toString();
}

/** Convierte recursivamente los bigint de un objeto a string. */
export function toJSONSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => toJSONSafe(v));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJSONSafe(v);
    return out;
  }
  return value;
}

/** Replacer para JSON.stringify / app.set('json replacer', bigintReplacer). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Ganancia = floor(bet * mult) con precisión de 1e-4 usando aritmética entera. */
export function applyMultiplier(bet: bigint, mult: number): bigint {
  if (!Number.isFinite(mult) || mult < 0) throw new MoneyError('Multiplicador inválido');
  return (bet * BigInt(Math.round(mult * 10000))) / 10000n;
}

/** Porcentaje en puntos básicos (1 bp = 0.01%) con floor: applyBps(1000n, 250) = 25n. */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new MoneyError('bps inválido');
  return (amount * BigInt(bps)) / 10000n;
}

export const minBigint = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBigint = (a: bigint, b: bigint): bigint => (a > b ? a : b);
