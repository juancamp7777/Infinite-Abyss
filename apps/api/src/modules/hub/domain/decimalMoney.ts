/**
 * Montos decimales de los agregadores ("25.50") ↔ unidades mínimas bigint del ledger. Nunca pasa por float:
 * se trabaja sobre el texto. Un monto con más decimales que la moneda se rechaza (no se redondea dinero).
 */

export class DecimalAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalAmountError';
  }
}

const DECIMAL = /^(\d{1,30})(?:\.(\d{1,18}))?$/;

/**
 * Texto decimal no negativo → unidades mínimas. Acepta un número JSON solo si su representación más corta
 * es exacta para la moneda (10.1 → "10.1"); el texto es lo recomendado.
 */
export function decimalToMinor(value: unknown, decimals: number): bigint {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    text = String(value);
    if (/e/i.test(text)) throw new DecimalAmountError('Monto en notación científica');
  } else throw new DecimalAmountError('Monto inválido');
  const m = DECIMAL.exec(text);
  if (!m) throw new DecimalAmountError(`Monto inválido: "${text.slice(0, 40)}"`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new DecimalAmountError(`El monto tiene más de ${decimals} decimales`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/** Unidades mínimas → texto con exactamente `decimals` decimales ("90000" COP → "900.00"). */
export function minorToDecimal(minor: bigint, decimals: number): string {
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(decimals + 1, '0');
  const int = decimals > 0 ? abs.slice(0, -decimals) : abs;
  const frac = decimals > 0 ? `.${abs.slice(-decimals)}` : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}
