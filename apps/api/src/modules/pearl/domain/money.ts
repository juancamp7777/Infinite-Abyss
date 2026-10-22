import { currencyDecimals } from '../../../domain/money/currencies';

/** "ARS 12.345,67": formato fijo (Intl omite el separador de miles en montos de 4 cifras con locale "es"). */
export function formatMoney(amount: bigint, currency: string): string {
  const dec = currencyDecimals(currency);
  const s = amount.toString().padStart(dec + 1, '0');
  const int = s.slice(0, s.length - dec).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${currency} ${int}${dec ? `,${s.slice(-dec)}` : ''}`;
}
