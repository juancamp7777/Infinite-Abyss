/** Campos de límite de juego responsable y utilidades puras (sin acceso a BD). */

export const LIMIT_FIELDS = [
  'depositLimitDaily',
  'depositLimitWeekly',
  'depositLimitMonthly',
  'lossLimitDaily',
  'lossLimitWeekly',
  'lossLimitMonthly',
  'sessionTimeLimitMinutes',
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];

/** Periodo de espera antes de que una subida (o retirada) de límite sea efectiva. */
export const LIMIT_INCREASE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
} as const;

/** Entrada pendiente: value null = quitar el límite. Todo viaja como string (bigint-safe). */
export interface PendingIncrease {
  value: string | null;
  effectiveAt: string;
}

export type PendingIncreaseMap = Partial<Record<LimitField, PendingIncrease>>;

export function isLimitField(v: string): v is LimitField {
  return (LIMIT_FIELDS as readonly string[]).includes(v);
}

export function parsePending(raw: unknown): PendingIncreaseMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: PendingIncreaseMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isLimitField(k) || !v || typeof v !== 'object') continue;
    const p = v as { value?: unknown; effectiveAt?: unknown };
    if (typeof p.effectiveAt !== 'string') continue;
    if (p.value !== null && typeof p.value !== 'string') continue;
    out[k] = { value: p.value as string | null, effectiveAt: p.effectiveAt };
  }
  return out;
}

/** true si pasar de `current` a `next` es una subida (null = sin límite = infinito). */
export function isIncrease(current: bigint | null, next: bigint | null): boolean {
  if (current === null) return false; // ya no hay límite: cualquier valor es una bajada
  if (next === null) return true; // quitar el límite
  return next > current;
}
