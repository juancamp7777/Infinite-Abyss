import type { BankTx } from './types';

/** Monto USDT normalizado a 6 decimales ("25.5" → 25500000n). null si no es un número válido. */
export function usdtMicro(raw: string): bigint | null {
  let s = raw.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  if (s.includes('.') && s.includes(',')) {
    // "1.234,56" o "1,234.56": el último separador es el decimal.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (s.includes(',')) {
    // Solo comas: "1,000" / "12,345,678" son miles; "25,5" es decimal.
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt(((m[2] ?? '') + '000000').slice(0, 6));
}

/**
 * USDT → unidades mínimas de la moneda del casino con la tasa del operador (pesos por 1 USDT, p. ej. "3950" o "3950.5").
 * Redondea hacia abajo: nunca se acredita de más.
 */
export function usdtToMinor(micro: bigint, rate: string, decimals: number): bigint | null {
  const r = usdtMicro(rate);
  if (!r || r <= 0n) return null;
  // micro (6 dec) × rate (6 dec) → 12 decimales; se lleva a los decimales de la moneda.
  return (micro * r * 10n ** BigInt(decimals)) / 10n ** 12n;
}

export const isCryptoTx = (t: Pick<BankTx, 'asset'>) => t.asset === 'USDT';

/**
 * Cruce de un comprobante USDT con los depósitos que reportó Binance: por TxID si el comprobante lo trae;
 * si no, por el monto exacto en USDT (y, si hay varios, por la hora más cercana).
 */
export function matchCryptoTx<T extends Pick<BankTx, 'externalId' | 'assetAmount' | 'occurredAt'>>(
  receipt: { micro: bigint; txId?: string; at?: Date },
  feed: T[],
): { kind: 'unique'; tx: T; by: 'txid' | 'amount' } | { kind: 'ambiguous' } | { kind: 'none' } {
  const id = receipt.txId?.trim().toLowerCase();
  if (id && id.length >= 8) {
    const byId = feed.filter((t) => t.externalId.toLowerCase() === id || t.externalId.toLowerCase().endsWith(id));
    if (byId.length === 1) return { kind: 'unique', tx: byId[0], by: 'txid' };
  }
  const hits = feed.filter((t) => t.assetAmount !== undefined && usdtMicro(t.assetAmount) === receipt.micro);
  if (!hits.length) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'unique', tx: hits[0], by: 'amount' };
  if (!receipt.at) return { kind: 'ambiguous' };
  const at = receipt.at.getTime();
  const sorted = [...hits].sort((a, b) => Math.abs(a.occurredAt.getTime() - at) - Math.abs(b.occurredAt.getTime() - at));
  return Math.abs(sorted[0].occurredAt.getTime() - at) === Math.abs(sorted[1].occurredAt.getTime() - at) ? { kind: 'ambiguous' } : { kind: 'unique', tx: sorted[0], by: 'amount' };
}
