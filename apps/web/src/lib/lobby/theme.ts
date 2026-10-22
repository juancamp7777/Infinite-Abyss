import type { Skin } from './types';

/** Tema Infinite Abyss por defecto (si el operador no tiene skin o el endpoint falla). */
export const DEFAULT_SKIN: Skin = {
  name: 'Infinite Abyss',
  logoUrl: null,
  colors: { primary: '#f4b73f', secondary: '#3cc8f0', background: '#050d1c', surface: '#0b1a30', text: '#e8eef8', accent: '#ffd978' },
  banners: [
    { title: 'Bienvenido al abismo', subtitle: 'Originals provably fair, slots de los mejores estudios y recompensas desde tu primera apuesta.', href: '/lobby/category/originals', art: '/brand/art/gift.svg', cta: 'Jugar ahora' },
    { title: 'Jackpots progresivos', subtitle: 'Mini, Major y Mega creciendo en vivo con cada giro.', href: '/lobby/category/slots', art: '/brand/art/wheel.svg', cta: 'Ver slots' },
    { title: 'Torneos con premios reales', subtitle: 'Sube en la tabla en tiempo real y llévate el pozo.', href: '/lobby/tournaments', art: '/brand/art/trophy.svg', cta: 'Competir' },
  ],
};

const HEX = /^#[0-9a-f]{3,8}$/i;

/** #rgb / #rrggbb / #rrggbbaa → [r, g, b] (0-255). */
export function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX.test(hex)) return null;
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** Luminancia relativa WCAG 2.x. */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return 1;
  const [hi, lo] = [luminance(ra), luminance(rb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const INK = '#0a0f1a';
const WHITE = '#ffffff';

/** Texto legible sobre un fondo: el de mayor contraste entre tinta oscura y blanco. */
export function readableOn(bg: string): string {
  return contrastRatio(bg, INK) >= contrastRatio(bg, WHITE) ? INK : WHITE;
}

export function skinStyle(c: Skin['colors']): Record<string, string> {
  const ok = (v: string, d: string) => (HEX.test(v) ? v : d);
  const d = DEFAULT_SKIN.colors;
  const primary = ok(c.primary, d.primary);
  const secondary = ok(c.secondary, d.secondary);
  return {
    '--nf-primary': primary, '--nf-secondary': secondary,
    '--nf-bg': ok(c.background, d.background), '--nf-surface': ok(c.surface, d.surface),
    '--nf-text': ok(c.text, d.text), '--nf-accent': ok(c.accent, d.accent),
    '--nf-on-primary': readableOn(primary), '--nf-on-secondary': readableOn(secondary),
  };
}
