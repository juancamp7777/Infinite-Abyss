// Sin literales BigInt (123n): el target de TypeScript puede ser < ES2020 en algunos entornos.
const ZERO = BigInt(0);
const HUNDRED = BigInt(100);

/** ¿El importe (string/bigint/number en unidades mínimas) es >= 0? Sin perder precisión. */
export function isNonNegative(v: string | number | bigint | null | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  try {
    return (typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : v)) >= ZERO;
  } catch {
    return Number(v) >= 0;
  }
}

/** Monedas que se muestran sin decimales (el ledger sigue guardando centavos). */
const HIDE_DECIMALS = new Set(["COP"]);
const SYMBOL: Record<string, string> = { COP: "$", USD: "US$" };

/** Separa miles con punto (es-CO) sin usar Intl con floats. */
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/**
 * Importes en unidades mínimas (centavos) que llegan como string/bigint/number → texto es-CO, sin floats.
 * COP → "$ 1.234.567" (sin decimales, se trunca); USD → "US$ 1.234,56"; otra moneda → "EUR 1.234,56".
 * Sin moneda (dato desconocido) → "1.234,56".
 */
export function money(v: string | number | bigint | null | undefined, currency?: string | null): string {
  if (v === null || v === undefined || v === "") return "—";
  let big: bigint;
  try {
    big = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : v);
  } catch {
    return String(v);
  }
  const code = currency?.toUpperCase();
  const neg = big < ZERO;
  const abs = neg ? -big : big;
  const units = group((abs / HUNDRED).toString());
  const body = code && HIDE_DECIMALS.has(code) ? units : `${units},${(abs % HUNDRED).toString().padStart(2, "0")}`;
  const prefix = code ? `${SYMBOL[code] ?? code} ` : "";
  return `${neg ? "-" : ""}${prefix}${body}`;
}

/**
 * Convierte lo que escribe el usuario (monto en la moneda, no en centavos) a unidades mínimas como texto.
 * COP: pesos enteros ("1.500" → "150000"). Otras: admite coma o punto decimal ("12,5" → "1250").
 * Devuelve null si el texto no es un monto válido.
 */
export function toMinorUnits(input: string, currency?: string | null): string | null {
  const s = input.trim().replace(/\s/g, "");
  if (!s) return null;
  if (currency && HIDE_DECIMALS.has(currency.toUpperCase())) {
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(s)) return null;
    return (BigInt(s.replace(/\./g, "")) * HUNDRED).toString();
  }
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return (BigInt(m[1]) * HUNDRED + BigInt((m[2] ?? "").padEnd(2, "0") || "0")).toString();
}

/** Factor de escala de los ejemplos de plantilla: montos pensados en USD, ×4000 para COP. */
export const sampleScale = (currency?: string | null) => (currency?.toUpperCase() === "COP" ? 4000 : 1);

/** Monto de ejemplo (en unidades mayores, p. ej. 10 = US$ 10) → unidades mínimas como texto. */
export const sampleMinor = (major: number, currency?: string | null) => String(Math.round(major * sampleScale(currency) * 100));

/** Convierte importe mínimo a número para gráficos (pierde precisión solo por encima de 2^53). */
export const toNum = (v: string | number | bigint | null | undefined): number => (v === null || v === undefined ? 0 : Number(v) / 100);

export const int = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("es-CO"));
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1).replace(".", ",")}%`);

export function dateTime(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));
