/**
 * Montos de apuesta (unidades mínimas, string). Los publica el operador en /api/operator/brand
 * (`operator.betLimits`); si faltan se usan estos valores razonables por moneda.
 * COP: el ledger va en centavos, así que 50000 = $ 500.
 */
import { operatorBetLimits } from "./modules";

const FALLBACK_PRESETS: Record<string, string[]> = {
  COP: ["50000", "100000", "200000", "500000", "1000000", "5000000"],
  USD: ["10", "50", "100", "200", "500", "1000"],
};
const GENERIC_PRESETS = FALLBACK_PRESETS.USD;

/** Montos rápidos (unidades mínimas) de la moneda: operador → respaldo por moneda → genérico. */
export function betPresets(currency?: string): string[] {
  const cur = (currency || "").toUpperCase();
  const fromOperator = operatorBetLimits()?.presets?.[cur];
  const list = fromOperator && fromOperator.length > 0 ? fromOperator : FALLBACK_PRESETS[cur] ?? GENERIC_PRESETS;
  return list.filter((p) => /^\d+$/.test(p));
}

function parseOpt(v: string | undefined): bigint | null {
  return v && /^\d+$/.test(v) ? BigInt(v) : null;
}

/** Apuesta mínima y máxima del operador (unidades mínimas) o null si no hay límite configurado. */
export function betBounds(): { min: bigint | null; max: bigint | null } {
  const l = operatorBetLimits();
  return { min: parseOpt(l?.minBet), max: parseOpt(l?.maxBet) };
}

/** Montos rápidos dentro de minBet/maxBet del operador (si el filtro vacía la lista, sin filtrar). */
export function betSteps(currency?: string): string[] {
  const all = betPresets(currency);
  const ok = all.filter((p) => withinBetBounds(BigInt(p)));
  return ok.length > 0 ? ok : all;
}

/** Primer preset ≥ apuesta mínima (o el primero). */
export function defaultBetIndex(presets: string[], min: bigint | null): number {
  if (min === null) return 0;
  const i = presets.findIndex((p) => BigInt(p) >= min);
  return i >= 0 ? i : Math.max(0, presets.length - 1);
}

/** ¿Está el monto dentro de minBet/maxBet del operador? */
export function withinBetBounds(minor: bigint): boolean {
  const { min, max } = betBounds();
  return (min === null || minor >= min) && (max === null || minor <= max);
}
