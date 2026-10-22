/** Decimales por moneda (unidad mínima = 10^-decimales). Sin floats en el money-path. */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  COP: 2,
  USD: 2,
  EUR: 2,
  MXN: 2,
  BRL: 2,
  PEN: 2,
  CLP: 2,
  ARS: 2,
  USDT: 6,
  USDC: 6,
  BTC: 8,
  ETH: 8,
  LTC: 8,
  TRX: 6,
});

export function currencyDecimals(currency: string): number {
  const d = CURRENCY_DECIMALS[currency.toUpperCase()];
  if (d === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return d;
}

export function isSupportedCurrency(currency: string): boolean {
  return CURRENCY_DECIMALS[currency.toUpperCase()] !== undefined;
}
