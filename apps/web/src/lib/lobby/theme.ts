import type { Skin } from './types';

/** Tema Nymfo por defecto (si el operador no tiene skin o el endpoint falla). */
export const DEFAULT_SKIN: Skin = {
  name: 'Nymfo Casino',
  logoUrl: null,
  colors: { primary: '#8b5cf6', secondary: '#22d3ee', background: '#0b0b14', surface: '#15152a', text: '#f1f1f8', accent: '#f5c542' },
  banners: [
    { title: 'Bienvenido a Nymfo', subtitle: 'Originals, slots y torneos en un solo lugar', href: '/lobby/category/originals' },
    { title: 'Jackpots progresivos', subtitle: 'Mini, Major y Mega en vivo', href: '/lobby/category/slots' },
    { title: 'Torneos activos', subtitle: 'Compite por el leaderboard', href: '/lobby/tournaments' },
  ],
};

const HEX = /^#[0-9a-f]{3,8}$/i;
export function skinStyle(c: Skin['colors']): Record<string, string> {
  const ok = (v: string, d: string) => (HEX.test(v) ? v : d);
  const d = DEFAULT_SKIN.colors;
  return {
    '--nf-primary': ok(c.primary, d.primary), '--nf-secondary': ok(c.secondary, d.secondary),
    '--nf-bg': ok(c.background, d.background), '--nf-surface': ok(c.surface, d.surface),
    '--nf-text': ok(c.text, d.text), '--nf-accent': ok(c.accent, d.accent),
  };
}
