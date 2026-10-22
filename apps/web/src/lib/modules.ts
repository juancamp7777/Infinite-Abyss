/**
 * Cliente unificado de los módulos (Hub, Studios, promociones, gamificación, backoffice público).
 *
 * Reutiliza `apiRequest` de lib/api.ts: misma base de URL, misma cabecera de tenant (X-Operator-Host),
 * mismo token de sesión de la Fase 1 y refresh automático. Los montos viajan como string de unidades
 * mínimas (bigint) y se formatean con lib/money.ts, nunca con Number().
 */
import { API_URL, ApiError, apiRequest, tokens, decimalsFor, type BetLimits, type OperatorInfo, type RequestOptions } from "./api";
import { formatCurrency, inputToMinor, minorToInput, parseMinor } from "./money";

export { API_URL, ApiError };

/**
 * Obsoleto: la moneda sale del saldo, del usuario o de operator.defaultCurrency (operatorCurrency()).
 * Se conserva vacío para no romper importaciones; nunca asume USD ni COP.
 */
export const DEFAULT_CURRENCY = "";

/** Id fijo del operador (opcional). Normalmente se deduce del token o de /api/operator/brand. */
const ENV_OPERATOR_ID = process.env.NEXT_PUBLIC_OPERATOR_ID || "";
/** Token de desarrollo (`dev:PLAYER:<operatorId>:<id>`) para `npm run dev:modules`. Se ignora en producción. */
const DEV_TOKEN = process.env.NODE_ENV !== "production" ? process.env.NEXT_PUBLIC_DEV_TOKEN || "" : "";
/** Operador del dev-server de módulos cuando no hay nada más. */
const DEV_OPERATOR_ID = "op-demo";

let registered: { id?: string; slug?: string; operator: OperatorInfo | null } = { operator: null };

/** El ThemeProvider registra aquí el operador resuelto por /api/operator/brand. */
export function registerModuleOperator(operator: OperatorInfo | null): void {
  registered = { id: operator?.id, slug: operator?.slug, operator };
}

/** Claim `op` (operatorId) del access token del jugador, si hay sesión. */
function tokenOperatorId(): string | null {
  const t = tokens.getAccess();
  if (!t) return null;
  try {
    const part = t.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const op = (JSON.parse(json) as { op?: unknown }).op;
    return typeof op === "string" && op ? op : null;
  } catch {
    return null;
  }
}

/** Operador (tenant) que usan los endpoints públicos de los módulos. */
export function moduleOperatorId(): string {
  return (
    ENV_OPERATOR_ID ||
    tokenOperatorId() ||
    registered.id ||
    (DEV_TOKEN ? DEV_TOKEN.split(":")[2] || DEV_OPERATOR_ID : "") ||
    DEV_OPERATOR_ID
  );
}

/** Decimales del ledger de una moneda según el operador registrado (2 por defecto). */
export function moneyDecimals(currency?: string): number {
  return decimalsFor(registered.operator, currency || operatorCurrency());
}

/** Moneda por defecto del operador resuelto ('' mientras no se conoce: nunca se asume USD). */
export function operatorCurrency(): string {
  return registered.operator?.defaultCurrency || "";
}

/** Límites y montos rápidos de apuesta del operador (unidades mínimas), si los publica /api/operator/brand. */
export function operatorBetLimits(): BetLimits | null {
  return registered.operator?.betLimits ?? null;
}

/** Formatea unidades mínimas (string/bigint) en es-CO con símbolo ("$ 1.234.567"); ledger decimals del operador. */
export function formatMinor(minor: string | bigint | number | null | undefined, currency?: string): string {
  const cur = currency || operatorCurrency();
  return formatCurrency(parseMinor(minor), cur, moneyDecimals(cur));
}

/** Unidades mínimas → texto editable en un input ("500000" COP → "5000"). */
export function minorToEditable(minor: bigint, currency?: string): string {
  const cur = currency || operatorCurrency();
  return minorToInput(minor, moneyDecimals(cur), cur);
}

/** Bearer de jugador: la sesión real; el token dev solo si no hay sesión y se configuró explícitamente. */
export function playerBearer(): string | null {
  return tokens.getAccess() || DEV_TOKEN || null;
}

export interface ModuleRequestOptions extends Omit<RequestOptions, "scope" | "bearer"> {
  /** Enviar el token del jugador (por defecto false: endpoints públicos). */
  auth?: boolean;
}

/** Petición a un módulo. Los errores llegan como ApiError (status, code, message). */
export function moduleRequest<T>(path: string, opts: ModuleRequestOptions = {}): Promise<T> {
  const { auth, ...rest } = opts;
  if (!auth) return apiRequest<T>(path, { ...rest, scope: "none" });
  // Con sesión real se usa el flujo normal (refresh ante 401); el token dev se manda como override.
  if (!tokens.getAccess() && DEV_TOKEN) return apiRequest<T>(path, { ...rest, scope: "player", bearer: DEV_TOKEN });
  return apiRequest<T>(path, { ...rest, scope: "player" });
}

/** "12.5" → unidades mínimas (bigint) con los decimales de la moneda; null si no es un monto válido. */
export function toMinorUnits(input: string, currency?: string): bigint | null {
  const cur = currency || operatorCurrency();
  return inputToMinor(input, cur, moneyDecimals(cur));
}
