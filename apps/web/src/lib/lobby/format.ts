import { formatMinor } from '../modules';

/** Formato de dinero (unidades mínimas bigint como string, decimales según la moneda) y utilidades. */
export function toNumber(minor: string | bigint | number | undefined | null): number {
  if (minor === undefined || minor === null) return 0;
  const n = Number(minor);
  return Number.isFinite(n) ? n : 0;
}
/** Dinero en unidades mínimas (bigint como string) → texto con los decimales de la moneda; sin floats. */
export function formatMoney(minor: string | bigint | number | undefined | null, currency = ''): string {
  return formatMinor(minor, currency || undefined);
}
export function formatInt(v: string | number): string {
  return new Intl.NumberFormat('es-CO').format(toNumber(v));
}
/** Hash determinista → matiz HSL. */
export function hueOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
export function initials(title: string): string {
  const w = title.split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? '?') + (w[1]?.[0] ?? '')).toUpperCase();
}
/** Miniatura SVG generada (data URL) con iniciales y color por proveedor. */
export function fallbackThumb(title: string, providerId: string): string {
  const h = hueOf(providerId);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,45%)"/><stop offset="1" stop-color="hsl(${(h + 50) % 360},70%,22%)"/></linearGradient></defs><rect width="300" height="200" fill="url(#g)"/><text x="150" y="115" font-family="sans-serif" font-size="64" font-weight="700" fill="rgba(255,255,255,.9)" text-anchor="middle">${initials(title).replace(/[<>&]/g, '')}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
export function formatScore(metric: string, score: string, currency = ''): string {
  if (metric === 'highest_multiplier') return `${(toNumber(score) / 10000).toFixed(2)}x`;
  if (metric === 'total_wagered') return formatMoney(score, currency);
  return formatInt(score);
}
export function rewardLabel(r: { type: string; points?: string; amount?: string }, currency = ''): string {
  return r.type === 'points' ? `${formatInt(r.points ?? '0')} pts` : `${formatMoney(r.amount ?? '0', currency)} bono`;
}
export function benefitsText(b: unknown): string {
  if (typeof b === 'string') return b;
  if (Array.isArray(b)) return b.map(String).join(' · ');
  return '';
}
