import type { OperatorBetLimits, OperatorCurrencyInfo, OperatorCurrencyPort } from '../ports/OperatorCurrencyPort';

/** Operadores en memoria (dev-server y pruebas de los módulos). */
export class InMemoryOperators implements OperatorCurrencyPort {
  private readonly ops = new Map<string, OperatorCurrencyInfo>();

  /** Registra/actualiza un operador. `currencies` por defecto = [defaultCurrency]. */
  set(operatorId: string, info: { defaultCurrency: string; currencies?: string[]; limits?: OperatorBetLimits }): this {
    const currencies = info.currencies?.length ? [...info.currencies] : [info.defaultCurrency];
    if (!currencies.includes(info.defaultCurrency)) currencies.unshift(info.defaultCurrency);
    this.ops.set(operatorId, { defaultCurrency: info.defaultCurrency, currencies, limits: { ...(info.limits ?? {}) } });
    return this;
  }

  async getCurrencyInfo(operatorId: string): Promise<OperatorCurrencyInfo | null> {
    const o = this.ops.get(operatorId);
    return o ? { defaultCurrency: o.defaultCurrency, currencies: [...o.currencies], limits: { ...o.limits } } : null;
  }
}
