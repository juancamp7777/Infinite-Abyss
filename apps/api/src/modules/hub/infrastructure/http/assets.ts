import { createHash } from 'crypto';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * Arte propio generado por código para las miniaturas/banners del catálogo (sin imágenes de terceros):
 * degradado con colores derivados del id, formas geométricas y el título.
 */
export function gameArtSvg(game: { id: string; title: string; providerName?: string; category: string }, kind: 'thumb' | 'banner'): string {
  const h = createHash('sha256').update(game.id).digest();
  const hue1 = h[0] * 360 / 255;
  const hue2 = (hue1 + 40 + (h[1] % 120)) % 360;
  const [w, hgt] = kind === 'thumb' ? [300, 400] : [1200, 400];
  const shapes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = (h[2 + i] / 255) * w;
    const y = (h[10 + i] / 255) * hgt;
    const r = 20 + (h[18 + i] % 90);
    shapes.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r}" fill="hsl(${(hue2 + i * 25) % 360},90%,70%)" opacity="0.18"/>`);
  }
  const title = esc(game.title);
  const sub = esc((game.providerName ?? '').toUpperCase());
  const fs = kind === 'thumb' ? Math.max(22, Math.min(40, Math.floor(520 / Math.max(8, game.title.length)))) : 64;
  const tx = kind === 'thumb' ? w / 2 : 80;
  const anchor = kind === 'thumb' ? 'middle' : 'start';
  const ty = kind === 'thumb' ? hgt * 0.62 : hgt / 2 + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}" role="img" aria-label="${title}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1.toFixed(0)},70%,22%)"/><stop offset="1" stop-color="hsl(${hue2.toFixed(0)},75%,38%)"/></linearGradient></defs>
<rect width="100%" height="100%" rx="${kind === 'thumb' ? 24 : 0}" fill="url(#g)"/>
${shapes.join('')}
<polygon points="${tx},${ty - fs * 3.2} ${tx + fs * 0.9},${ty - fs * 1.9} ${tx},${ty - fs * 0.6} ${tx - fs * 0.9},${ty - fs * 1.9}" fill="hsl(${hue2.toFixed(0)},95%,75%)" opacity="${kind === 'thumb' ? 0.9 : 0}"/>
<text x="${tx}" y="${ty}" text-anchor="${anchor}" font-family="system-ui,sans-serif" font-weight="800" font-size="${fs}" fill="#fff">${title}</text>
<text x="${tx}" y="${ty + fs * 0.9}" text-anchor="${anchor}" font-family="system-ui,sans-serif" font-size="${Math.round(fs * 0.4)}" letter-spacing="3" fill="#ffffffb0">${sub}</text>
</svg>`;
}
