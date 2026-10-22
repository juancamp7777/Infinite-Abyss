/**
 * Límites de apuesta públicos del operador (lo único de Operator.limits que se expone al front).
 * Todos los montos son strings de dígitos en unidades mínimas de la moneda.
 */

export interface PublicBetLimits {
  minBet?: string;
  maxBet?: string;
  /** Montos rápidos de apuesta por moneda (unidades mínimas). */
  presets: Record<string, string[]>;
}

/** Presets por defecto en unidades mínimas (COP en centavos: 500…50.000 COP). */
export const DEFAULT_BET_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  COP: ['50000', '100000', '200000', '500000', '1000000', '5000000'],
  USD: ['10', '50', '100', '200', '500', '1000'],
  EUR: ['10', '50', '100', '200', '500', '1000'],
});

const USD_DECIMALS = 2;
const DIGITS = /^\d{1,30}$/;

/** Escala los presets de USD (2 decimales) a otra moneda según sus decimales. */
function scaleUsdPresets(decimals: number): string[] {
  const shift = decimals - USD_DECIMALS;
  return DEFAULT_BET_PRESETS.USD.map((v) => {
    const n = BigInt(v);
    if (shift >= 0) return (n * 10n ** BigInt(shift)).toString();
    const scaled = n / 10n ** BigInt(-shift);
    return (scaled > 0n ? scaled : 1n).toString();
  }).filter((v, i, arr) => arr.indexOf(v) === i);
}

/** Presets por defecto de una moneda; `decimals` = decimales de su unidad mínima (null si no está soportada). */
export function defaultBetPresets(currency: string, decimals: number | null): string[] {
  const known = DEFAULT_BET_PRESETS[currency.toUpperCase()];
  if (known) return [...known];
  return scaleUsdPresets(decimals ?? USD_DECIMALS);
}

const digitString = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === 'string' && DIGITS.test(v.trim()) ? v.trim() : undefined;
};

/**
 * Construye los límites públicos a partir de Operator.limits (JSON libre): minBet, maxBet y betPresets
 * (`{ "COP": ["50000", …] }`). Ignora valores inválidos y completa con los defaults por moneda.
 * Nunca copia límites de depósito ni de retiro.
 */
export function publicBetLimits(
  limits: unknown,
  currencies: string[],
  decimalsOf: (currency: string) => number | null,
): PublicBetLimits {
  const l = limits && typeof limits === 'object' ? (limits as Record<string, unknown>) : {};
  const raw = l.betPresets && typeof l.betPresets === 'object' ? (l.betPresets as Record<string, unknown>) : {};
  const presets: Record<string, string[]> = {};
  for (const c of currencies) {
    const configured = Array.isArray(raw[c]) ? (raw[c] as unknown[]).map(digitString).filter((v): v is string => !!v && v !== '0') : [];
    presets[c] = configured.length > 0 ? configured : defaultBetPresets(c, decimalsOf(c));
  }
  const out: PublicBetLimits = { presets };
  const minBet = digitString(l.minBet);
  const maxBet = digitString(l.maxBet);
  if (minBet !== undefined) out.minBet = minBet;
  if (maxBet !== undefined) out.maxBet = maxBet;
  return out;
}
