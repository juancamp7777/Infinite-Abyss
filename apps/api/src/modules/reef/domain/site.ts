import { z } from 'zod';

/**
 * Reef: plantillas white-label del casino. Una plantilla define el DISEÑO (navegación, cartas, radios, fuentes y
 * paleta inicial); cada operador personaliza encima. Solo texto plano y URLs seguras: nunca HTML ni scripts.
 */

export const FONTS = ['cinzel', 'playfair', 'inter', 'poppins', 'montserrat', 'geist'] as const;
export const SECTIONS = ['hero', 'tiles', 'providers', 'last_wins', 'originals', 'slots', 'popular', 'new', 'live', 'live_bets', 'tournaments'] as const;
export const SOCIALS = ['instagram', 'facebook', 'x', 'tiktok', 'telegram', 'whatsapp', 'youtube'] as const;
export type SectionKey = (typeof SECTIONS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color hexadecimal #RRGGBB');
/** https absoluta o ruta interna (/lobby…). Nada de javascript:, data: ni protocolos raros. */
const safeUrl = z.string().trim().max(500).refine((v) => /^https:\/\/[^\s<>"']+$/i.test(v) || /^\/(?!\/)[^\s<>"']*$/.test(v), 'URL https o ruta interna');
const plain = (max: number) => z.string().trim().max(max).refine((v) => !/[<>]/.test(v), 'Sin HTML');

export const siteConfigSchema = z.object({
  template: z.enum(['abyss', 'golden', 'emerald', 'royal']),
  brand: z.object({ siteName: plain(40).pipe(z.string().min(1)), logoUrl: safeUrl.optional(), faviconUrl: safeUrl.optional() }),
  colors: z.object({ primary: hex, secondary: hex, background: hex, surface: hex, text: hex, accent: hex }),
  fonts: z.object({ display: z.enum(FONTS), body: z.enum(FONTS) }),
  layout: z.object({ nav: z.enum(['sidebar', 'topbar']), cards: z.enum(['square', 'portrait']), radius: z.enum(['sm', 'md', 'lg', 'xl']) }),
  home: z.object({
    sections: z.array(z.object({ key: z.enum(SECTIONS), visible: z.boolean() })).length(SECTIONS.length)
      .refine((s) => new Set(s.map((x) => x.key)).size === SECTIONS.length, 'Cada sección debe aparecer una vez'),
  }),
  banners: z.array(z.object({ title: plain(60).pipe(z.string().min(1)), subtitle: plain(140).optional(), cta: plain(24).optional(), href: safeUrl, imageUrl: safeUrl.optional() })).max(6),
  seo: z.object({ title: plain(70), description: plain(170) }),
  footer: z.object({
    about: plain(500).default(''),
    socials: z.array(z.object({ type: z.enum(SOCIALS), url: safeUrl })).max(8).default([]),
    legal: plain(2000).default(''),
    license: plain(200).default(''),
  }),
});
export type SiteConfig = z.infer<typeof siteConfigSchema>;

const order = (keys: SectionKey[], hidden: SectionKey[] = []) => [...keys, ...SECTIONS.filter((k) => !keys.includes(k))].map((key) => ({ key, visible: !hidden.includes(key) }));

/**
 * Catálogo de plantillas (en código: versionadas con el producto y probadas). Inspiradas en los casinos que ya
 * operan nuestros clientes (Golden Club, SubaPlay, RostarBet) pero con identidad propia.
 */
export const TEMPLATES: Record<SiteConfig['template'], { name: string; description: string; defaults: Omit<SiteConfig, 'brand' | 'banners' | 'seo' | 'footer'> }> = {
  abyss: {
    name: 'Abyss', description: 'Estilo Stake: menú lateral, azul profundo y oro, cartas cuadradas.',
    defaults: {
      template: 'abyss',
      colors: { primary: '#f4b73f', secondary: '#3cc8f0', background: '#050d1c', surface: '#0b1a30', text: '#e8eef8', accent: '#ffd978' },
      fonts: { display: 'cinzel', body: 'geist' }, layout: { nav: 'sidebar', cards: 'square', radius: 'lg' },
      home: { sections: order(['hero', 'last_wins', 'originals', 'slots', 'popular', 'new', 'live', 'live_bets', 'tournaments'], ['tiles', 'providers']) },
    },
  },
  golden: {
    name: 'Golden', description: 'Morado y oro tipo club: menú superior, accesos rápidos en mosaico, cartas verticales.',
    defaults: {
      template: 'golden',
      colors: { primary: '#f5c542', secondary: '#d946ef', background: '#14031f', surface: '#2a0b3d', text: '#fbf3ff', accent: '#ffe08a' },
      fonts: { display: 'montserrat', body: 'montserrat' }, layout: { nav: 'topbar', cards: 'portrait', radius: 'xl' },
      home: { sections: order(['hero', 'tiles', 'popular', 'slots', 'live', 'providers', 'originals', 'new', 'last_wins', 'live_bets', 'tournaments']) },
    },
  },
  emerald: {
    name: 'Emerald', description: 'Verde esmeralda sobre negro: proveedores destacados y últimas jugadas, menú lateral de íconos.',
    defaults: {
      template: 'emerald',
      colors: { primary: '#22c55e', secondary: '#a3e635', background: '#07100b', surface: '#0f1d15', text: '#ecfdf3', accent: '#facc15' },
      fonts: { display: 'poppins', body: 'inter' }, layout: { nav: 'sidebar', cards: 'square', radius: 'md' },
      home: { sections: order(['hero', 'providers', 'last_wins', 'slots', 'live', 'popular', 'originals', 'new', 'live_bets', 'tournaments'], ['tiles']) },
    },
  },
  royal: {
    name: 'Royal', description: 'Morado y azul noche, menú lateral por categorías, ranking Top y novedades.',
    defaults: {
      template: 'royal',
      colors: { primary: '#c026d3', secondary: '#38bdf8', background: '#0b0a24', surface: '#17153d', text: '#eef2ff', accent: '#f472b6' },
      fonts: { display: 'poppins', body: 'inter' }, layout: { nav: 'sidebar', cards: 'portrait', radius: 'lg' },
      home: { sections: order(['hero', 'popular', 'new', 'slots', 'live', 'originals', 'providers', 'last_wins', 'live_bets', 'tournaments'], ['tiles']) },
    },
  },
};

/** Configuración inicial de un operador a partir de una plantilla. */
export function defaultConfig(template: SiteConfig['template'] = 'abyss', siteName = 'Mi Casino'): SiteConfig {
  return {
    ...structuredClone(TEMPLATES[template].defaults),
    brand: { siteName },
    banners: [],
    seo: { title: `${siteName} · Casino online`, description: 'Juega slots, originals y casino en vivo con retiros rápidos.' },
    footer: { about: '', socials: [], legal: 'Juego solo para mayores de 18 años. Juega con responsabilidad.', license: '' },
  };
}

/** Cambiar de plantilla reemplaza el DISEÑO (paleta, fuentes, navegación, orden de la home) y conserva contenido y marca. */
export function switchTemplate(cfg: SiteConfig, template: SiteConfig['template']): SiteConfig {
  const d = TEMPLATES[template].defaults;
  return { ...cfg, template, colors: { ...d.colors }, fonts: { ...d.fonts }, layout: { ...d.layout }, home: structuredClone(d.home) };
}

// ───────────── contraste WCAG ─────────────

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (hexColor: string) => {
  const n = parseInt(hexColor.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

/** Problemas de legibilidad (todos a la vez, para mostrarlos juntos en el editor). */
export function contrastIssues(c: SiteConfig['colors']): string[] {
  const issues: string[] = [];
  if (contrast(c.text, c.background) < 4.5) issues.push(`Texto sobre fondo: ${contrast(c.text, c.background)}:1 (mínimo 4.5:1)`);
  if (contrast(c.text, c.surface) < 4.5) issues.push(`Texto sobre tarjetas: ${contrast(c.text, c.surface)}:1 (mínimo 4.5:1)`);
  if (contrast(c.primary, c.background) < 3) issues.push(`Color principal sobre fondo: ${contrast(c.primary, c.background)}:1 (mínimo 3:1)`);
  return issues;
}
