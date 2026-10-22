/**
 * Helpers de dinero. Todo el money-path usa strings/BigInt en unidades mínimas:
 * nunca se calcula con floats antes de enviar un monto al servidor.
 */

/** Convierte un monto "mayor" escrito por el usuario (p. ej. "12.5") a unidades mínimas. */
export function toMinor(major: string, decimals: number): bigint {
  const clean = major.trim().replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Monto inválido");
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) {
    // Más decimales de los que admite la moneda: se rechaza en vez de redondear.
    if (/[1-9]/.test(frac.slice(decimals))) throw new Error(`Máximo ${decimals} decimales`);
  }
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + padded);
}

/** Variante que no lanza: devuelve null si el texto no es un monto válido. */
export function tryToMinor(major: string, decimals: number): bigint | null {
  try {
    return toMinor(major, decimals);
  } catch {
    return null;
  }
}

/** Parsea un monto del servidor (string de dígitos, con signo opcional). */
export function parseMinor(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return BigInt(0);
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (!/^-?\d+$/.test(value)) return BigInt(0);
  return BigInt(value);
}

/** Monedas que se muestran sin decimales (los centavos del ledger se truncan hacia cero al mostrar). */
const ZERO_DECIMAL_DISPLAY = new Set(["COP", "CLP", "PYG", "JPY"]);

/** Decimales visibles de una moneda dado el decimal del ledger. */
export function displayDecimals(currency: string, ledgerDecimals: number): number {
  return ZERO_DECIMAL_DISPLAY.has(currency.toUpperCase()) ? 0 : ledgerDecimals;
}

/** Monedas sin decimales visibles: el usuario escribe unidades enteras y acepta '.' de miles. */
export function isZeroDecimalDisplay(currency: string): boolean {
  return ZERO_DECIMAL_DISPLAY.has(currency.toUpperCase());
}

/** Texto de un monto sin símbolo en es-CO (miles '.', decimal ','), p. ej. 123456 (2 dec.) → "1.234,56". */
export function formatAmount(minor: bigint, decimals: number, visibleDecimals: number = decimals): string {
  const negative = minor < BigInt(0);
  const abs = negative ? -minor : minor;
  const vis = Math.min(visibleDecimals, decimals);
  // Se descartan (truncan) los decimales que no se muestran.
  const shown = abs / BigInt(10) ** BigInt(decimals - vis);
  const base = BigInt(10) ** BigInt(vis);
  const whole = shown / base;
  const frac = (shown % base).toString().padStart(vis, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const isZero = shown === BigInt(0);
  return `${negative && !isZero ? "-" : ""}${wholeStr}${vis > 0 ? "," + frac : ""}`;
}

/** Símbolo/prefijo por moneda: "$ " para COP, "US$ " para USD, el código para el resto. */
function currencyPrefix(currency: string): string {
  const c = currency.toUpperCase();
  if (c === "COP") return "$ ";
  if (c === "USD") return "US$ ";
  return c ? `${c} ` : "";
}

/** Dinero con símbolo en es-CO sin floats: (123456789, COP, 2) → "$ 1.234.567"; (123456, USD, 2) → "US$ 1.234,56". */
export function formatCurrency(minor: bigint, currency: string, ledgerDecimals: number): string {
  const text = formatAmount(minor, ledgerDecimals, displayDecimals(currency, ledgerDecimals));
  const negative = text.startsWith("-");
  return `${negative ? "-" : ""}${currencyPrefix(currency)}${negative ? text.slice(1) : text}`;
}

/** Alias histórico: mismo formato es-CO con símbolo. */
export function formatMoney(minor: bigint, currency: string, decimals: number): string {
  return formatCurrency(minor, currency, decimals);
}

/** Pasa unidades mínimas a texto editable para inputs ("1234500" → "12345.00"; en COP "12345"). */
export function minorToInput(minor: bigint, decimals: number, currency = ""): string {
  const vis = currency ? displayDecimals(currency, decimals) : decimals;
  return formatAmount(minor, decimals, vis).replace(/\./g, "").replace(",", ".");
}

/** Texto escrito por el usuario → unidades mínimas; en COP/CLP/PYG/JPY '.' es separador de miles. */
export function inputToMinor(input: string, currency: string, ledgerDecimals: number): bigint | null {
  const raw = input.trim().replace(/\s/g, "");
  const normalized = isZeroDecimalDisplay(currency) ? raw.replace(/\./g, "") : raw;
  return tryToMinor(normalized, ledgerDecimals);
}
