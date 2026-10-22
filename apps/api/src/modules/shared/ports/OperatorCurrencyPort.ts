import type { ModuleLogger } from '../module';

/** Límites de apuesta por jugada del operador, en unidades mínimas de su defaultCurrency. */
export interface OperatorBetLimits {
  minBet?: bigint;
  maxBet?: bigint;
}

export interface OperatorCurrencyInfo {
  defaultCurrency: string;
  /** Monedas habilitadas del operador (incluye defaultCurrency). */
  currencies: string[];
  limits: OperatorBetLimits;
}

/**
 * Moneda y límites de apuesta del operador (Operator.defaultCurrency/currencies/limits en la Fase 1).
 * Devuelve null si el operador no existe (p. ej. operadores remotos del Hub o el dev-server sin BD).
 */
export interface OperatorCurrencyPort {
  getCurrencyInfo(operatorId: string): Promise<OperatorCurrencyInfo | null>;
}

/**
 * Último recurso SOLO para el dev-server de módulos y pruebas sin operador real: en la plataforma
 * la moneda sale siempre del jugador (User.currency) o del operador (Operator.defaultCurrency).
 */
export const DEV_FALLBACK_CURRENCY = 'USD';

/** Consulta segura: un fallo del puerto se registra y se trata como "operador desconocido". */
export async function lookupOperatorCurrency(
  port: OperatorCurrencyPort | undefined,
  operatorId: string | undefined,
  logger?: ModuleLogger,
): Promise<OperatorCurrencyInfo | null> {
  if (!port || !operatorId) return null;
  try {
    return await port.getCurrencyInfo(operatorId);
  } catch (e) {
    logger?.warn('No se pudo leer la moneda del operador', { operatorId, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Moneda por defecto de un operador: defaultCurrency del operador → `fallback` (variable de entorno del módulo,
 * pensada para el dev-server) → DEV_FALLBACK_CURRENCY.
 */
export async function resolveOperatorCurrency(
  port: OperatorCurrencyPort | undefined,
  operatorId: string | undefined,
  fallback?: string,
  logger?: ModuleLogger,
): Promise<string> {
  const info = await lookupOperatorCurrency(port, operatorId, logger);
  return info?.defaultCurrency || fallback || DEV_FALLBACK_CURRENCY;
}
