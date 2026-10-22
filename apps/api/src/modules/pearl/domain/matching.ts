/** Reglas deterministas de Pearl: montos, nombres, cuentas y conciliación contra el feed bancario. */

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "12.345,67" · "12,345.67" · "12345.67" · "$ 12.345" → unidades mínimas (null si no es un monto válido). */
export function parseAmountToMinor(raw: string | number, decimals: number): bigint | null {
  let s = String(raw).replace(/[^\d.,-]/g, '');
  if (!s || s.startsWith('-')) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const sep = Math.max(lastDot, lastComma);
  // El último separador es decimal solo si lo siguen 1-2 dígitos; si no, todo son miles.
  let intPart = s;
  let frac = '';
  if (sep >= 0 && s.length - sep - 1 >= 1 && s.length - sep - 1 <= 2) {
    intPart = s.slice(0, sep);
    frac = s.slice(sep + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d+$/.test(intPart || '0') || !/^\d*$/.test(frac)) return null;
  if (frac.length > decimals) return null;
  s = `${intPart || '0'}${frac.padEnd(decimals, '0')}`;
  const v = BigInt(s);
  return v > 0n ? v : null;
}

export const nameTokens = (name: string) => strip(name).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);

/** Similitud 0-1 tipo Levenshtein normalizado. */
export function ratio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * ¿Mismo titular? (criterio probado en producción por la caja anterior)
 * - mismos tokens; o el conjunto menor contenido en el mayor con ≥2 tokens en común;
 * - o ≥2 tokens exactos en común y los sobrantes del menor parecidos (≥0.8) a alguno del mayor.
 * Un nombre vacío nunca coincide.
 */
export function sameHolder(a: string, b: string): boolean {
  const ta = [...new Set(nameTokens(a))];
  const tb = [...new Set(nameTokens(b))];
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const shared = small.filter((t) => big.includes(t));
  if (shared.length === small.length && small.length === big.length) return true;
  if (shared.length === small.length && shared.length >= 2) return true;
  if (shared.length < 2) return false;
  const rest = small.filter((t) => !big.includes(t));
  const bigRest = big.filter((t) => !shared.includes(t));
  return rest.every((t) => bigRest.some((u) => ratio(t, u) >= 0.8));
}

const digits = (s: string) => s.replace(/\D/g, '');

/** La cuenta destino del comprobante es nuestra: CBU/CVU completo, alias o los últimos 6 dígitos. */
export function isOwnAccount(receiver: string, accounts: Array<{ accountNumber: string; alias?: string | null }>): boolean {
  const r = strip(receiver).trim();
  const rd = digits(receiver);
  return accounts.some((a) => {
    const ad = digits(a.accountNumber);
    // Completo, o parcial (los comprobantes suelen mostrar solo los últimos dígitos).
    if (rd.length >= 6 && ad.length >= 6 && (rd === ad || ad.endsWith(rd))) return true;
    return !!a.alias && strip(a.alias) === r;
  });
}

/** Nombres que nunca son el titular que paga: billeteras y bancos (y nuestros propios titulares). */
const WALLET_NAMES = ['mercado pago', 'mercadopago', 'uala', 'brubank', 'naranja x', 'lemon', 'prex', 'personal pay', 'modo', 'cuenta dni', 'belo', 'astropay', 'quikipay', 'hg cash'];
export function isWalletOrOwnName(name: string, ownHolders: string[]): boolean {
  const n = nameTokens(name).join(' ');
  if (!n) return false;
  if (WALLET_NAMES.some((w) => n === w || n.startsWith(`${w} `))) return true;
  return ownHolders.some((h) => sameHolder(h, name));
}

export interface BankCandidate {
  id: string;
  amount: bigint;
  senderName: string;
  occurredAt: Date;
}

export type MatchResult<T> = { kind: 'unique'; tx: T } | { kind: 'none' } | { kind: 'ambiguous'; candidates: T[] };

/**
 * Conciliación: monto EXACTO + mismo titular (con cualquiera de los nombres conocidos del jugador).
 * La hora no filtra: solo desempata (gana la más cercana; empate exacto = ambiguo).
 */
export function matchBankTx<T extends BankCandidate>(receipt: { amount: bigint; names: string[]; at?: Date }, feed: T[]): MatchResult<T> {
  const names = receipt.names.filter((n) => nameTokens(n).length);
  const hits = feed.filter((t) => t.amount === receipt.amount && names.some((n) => sameHolder(n, t.senderName)));
  if (!hits.length) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'unique', tx: hits[0] };
  if (!receipt.at) return { kind: 'ambiguous', candidates: hits };
  const at = receipt.at.getTime();
  const sorted = [...hits].sort((a, b) => Math.abs(a.occurredAt.getTime() - at) - Math.abs(b.occurredAt.getTime() - at));
  const d0 = Math.abs(sorted[0].occurredAt.getTime() - at);
  const d1 = Math.abs(sorted[1].occurredAt.getTime() - at);
  return d0 === d1 ? { kind: 'ambiguous', candidates: sorted } : { kind: 'unique', tx: sorted[0] };
}

/** Clave normalizada del comprobante (fecha·hora·monto·titular): el mismo pago no se registra dos veces. */
export const receiptKey = (r: { amount: bigint; senderName: string; date?: string; time?: string }) =>
  [r.date ?? '', r.time ?? '', r.amount.toString(), nameTokens(r.senderName).sort().join(' ')].join('|');
