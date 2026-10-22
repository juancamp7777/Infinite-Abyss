import { z } from 'zod';
import type { Skin } from '../domain/types';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const MAX_SVG = 20_000;

export const DEFAULT_SKIN: Skin = {
  name: 'Infinite Abyss',
  logoUrl: '',
  colors: { primary: '#f4b73f', secondary: '#3cc8f0', background: '#050d1c', surface: '#0b1a30', text: '#e8eef8', accent: '#ffd978' },
  banners: [],
};

/** URL http(s) o ruta relativa del propio sitio (nunca `//host` ni esquemas peligrosos). */
export function isSafeUrl(v: string, opts: { allowDataImage?: boolean } = {}): boolean {
  if (v.length > 2048 || /[\u0000-\u001f\s]/.test(v)) return false;
  if (v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return true;
  if (opts.allowDataImage && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v)) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'title', 'desc', 'text', 'tspan', 'clippath']);
const CAMEL: Record<string, string> = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath' };
const ALLOWED_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'offset', 'stop-color', 'stop-opacity', 'id', 'gradientunits', 'gradienttransform', 'clip-path', 'clip-rule', 'font-family', 'font-size',
  'font-weight', 'text-anchor', 'preserveaspectratio', 'fx', 'fy',
]);
const ATTR_CAMEL: Record<string, string> = { viewbox: 'viewBox', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform', preserveaspectratio: 'preserveAspectRatio' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Sanea un SVG con lista blanca de etiquetas y atributos. Lanza Error si no es seguro o es inválido. */
export function sanitizeSvg(input: string): string {
  const src = input.trim();
  if (src.length > MAX_SVG) throw new Error('SVG demasiado grande (máx. 20 KB)');
  if (!/^<svg[\s>]/i.test(src)) throw new Error('El logo SVG debe comenzar con <svg');
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>|([^<>]+)/gy;
  const stack: string[] = [];
  let out = '';
  let pos = 0;
  let m: RegExpExecArray | null;
  while (pos < src.length) {
    tokenRe.lastIndex = pos;
    m = tokenRe.exec(src);
    if (!m) throw new Error('SVG no válido (comentarios, DOCTYPE u otras construcciones no permitidas)');
    pos = tokenRe.lastIndex;
    if (m[5] !== undefined) {
      if (/[^\s]/.test(m[5]) && !stack.some((t) => t === 'text' || t === 'tspan' || t === 'title' || t === 'desc')) throw new Error('Texto fuera de <text> no permitido en SVG');
      out += esc(m[5]);
      continue;
    }
    const closing = m[1] === '/';
    const lower = m[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) throw new Error(`Etiqueta SVG no permitida: <${m[2]}>`);
    const name = CAMEL[lower] ?? lower;
    if (closing) {
      if (stack.pop() !== lower) throw new Error('SVG mal formado');
      out += `</${name}>`;
      continue;
    }
    const attrSrc = m[3] ?? '';
    let rebuilt = '';
    let consumed = 0;
    const attrRe = /\s+([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    while (consumed < attrSrc.length) {
      attrRe.lastIndex = consumed;
      const a = attrRe.exec(attrSrc);
      if (!a) {
        if (attrSrc.slice(consumed).trim() === '') break;
        throw new Error('Atributo SVG no válido');
      }
      consumed = attrRe.lastIndex;
      const an = a[1]!.toLowerCase();
      const av = a[2] ?? a[3] ?? '';
      if (!ALLOWED_ATTRS.has(an)) throw new Error(`Atributo SVG no permitido: ${a[1]}`);
      if (/javascript:|data:|expression|<|&#|@import/i.test(av)) throw new Error('Valor de atributo SVG no permitido');
      if (/url\(/i.test(av) && !/^url\(#[\w-]+\)$/.test(av.trim())) throw new Error('Solo se permiten referencias url(#id) internas');
      rebuilt += ` ${ATTR_CAMEL[an] ?? an}="${esc(av)}"`;
    }
    if (lower === 'svg' && stack.length === 0 && !/xmlns=/.test(rebuilt)) rebuilt += ' xmlns="http://www.w3.org/2000/svg"';
    if (m[4] === '/') out += `<${name}${rebuilt}/>`;
    else {
      stack.push(lower);
      out += `<${name}${rebuilt}>`;
    }
  }
  if (stack.length) throw new Error('SVG mal formado (etiquetas sin cerrar)');
  return out;
}

const hex = z.string().regex(HEX, 'Color hex inválido (#rgb, #rrggbb o #rrggbbaa)');
const text = (max: number) => z.string().trim().max(max);

export const skinInputSchema = z
  .object({
    name: text(80).min(1),
    logoUrl: z.string().max(4096).optional(),
    logoSvg: z.string().max(MAX_SVG * 2).optional(),
    colors: z.object({ primary: hex, secondary: hex, background: hex, surface: hex, text: hex, accent: hex }).strict(),
    banners: z
      .array(
        z.object({
          title: text(80).min(1),
          subtitle: text(160).default(''),
          imageUrl: z.string().max(2048).optional(),
          href: z.string().max(2048),
        }),
      )
      .max(10)
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.logoUrl && v.logoSvg) ctx.addIssue({ code: 'custom', path: ['logoSvg'], message: 'Envía logoUrl o logoSvg, no ambos' });
    if (v.logoUrl && !isSafeUrl(v.logoUrl, { allowDataImage: true })) ctx.addIssue({ code: 'custom', path: ['logoUrl'], message: 'logoUrl debe ser http(s), ruta relativa o data:image base64' });
    v.banners.forEach((b, i) => {
      if (b.imageUrl && !isSafeUrl(b.imageUrl)) ctx.addIssue({ code: 'custom', path: ['banners', i, 'imageUrl'], message: 'URL de imagen no válida' });
      if (!isSafeUrl(b.href)) ctx.addIssue({ code: 'custom', path: ['banners', i, 'href'], message: 'href debe ser http(s) o ruta relativa' });
    });
  });

export type SkinInput = z.infer<typeof skinInputSchema>;

/** Normaliza la entrada ya validada: sanea el SVG y lo guarda como data URI. */
export function toSkin(input: SkinInput): Skin {
  let logoUrl = input.logoUrl ?? '';
  if (input.logoSvg) logoUrl = `data:image/svg+xml;base64,${Buffer.from(sanitizeSvg(input.logoSvg), 'utf8').toString('base64')}`;
  return {
    name: input.name,
    logoUrl,
    colors: { ...input.colors },
    banners: input.banners.map((b) => ({ title: b.title, subtitle: b.subtitle, ...(b.imageUrl ? { imageUrl: b.imageUrl } : {}), href: b.href })),
  };
}
