/**
 * Sprites generados por código (paths, gradientes y glow): se pintan una vez en un canvas fuera de pantalla
 * y se reutilizan. Sin imágenes de terceros.
 */
export type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;

const cache = new Map<string, HTMLCanvasElement>();

/** Devuelve el sprite (cuadrado `size` px CSS, centrado en el origen al pintar) con resolución HiDPI. */
export function sprite(key: string, size: number, dpr: number, painter: Painter): HTMLCanvasElement {
  const px = Math.max(8, Math.round(size));
  const k = `${key}@${px}x${dpr}`;
  let c = cache.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  const pad = 1.3; // margen para glow
  c.width = Math.ceil(px * pad * dpr);
  c.height = Math.ceil(px * pad * dpr);
  const g = c.getContext('2d');
  if (g) {
    g.scale(dpr, dpr);
    g.translate((px * pad) / 2, (px * pad) / 2);
    painter(g, px);
  }
  if (cache.size > 400) cache.clear();
  cache.set(k, c);
  return c;
}

/** Dibuja un sprite centrado en (x,y) con escala y opacidad. */
export function drawSprite(ctx: CanvasRenderingContext2D, s: HTMLCanvasElement, x: number, y: number, size: number, scale = 1, alpha = 1, rot = 0): void {
  const pad = 1.3;
  const w = size * pad * scale;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  ctx.drawImage(s, -w / 2, -w / 2, w, w);
  ctx.restore();
}

export function polyPath(ctx: CanvasRenderingContext2D, n: number, r: number, rot = -Math.PI / 2, squash = 1): void {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r * squash);
  }
  ctx.closePath();
}

export function starPath(ctx: CanvasRenderingContext2D, n: number, ro: number, ri: number, rot = -Math.PI / 2): void {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? ri : ro;
    const a = rot + (i * Math.PI) / n;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Rellena el path actual con degradado radial + borde claro + brillo especular, con glow. */
export function gemFill(ctx: CanvasRenderingContext2D, size: number, light: string, dark: string, glow: string, edge = 'rgba(255,255,255,.75)'): void {
  const r = size / 2;
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.16;
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.05, 0, 0, r * 1.1);
  g.addColorStop(0, light);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, size * 0.035);
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.restore();
}

/** Brillo especular suave en la parte superior-izquierda. */
export function shine(ctx: CanvasRenderingContext2D, size: number, alpha = 0.45): void {
  const r = size / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createLinearGradient(-r, -r, r * 0.4, r * 0.4);
  g.addColorStop(0, 'rgba(255,255,255,.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(-r * 0.25, -r * 0.35, r * 0.4, r * 0.2, -0.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Campo de estrellas determinista (para fondos). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function glowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, glow: string, weight = 800): void {
  ctx.save();
  ctx.font = `${weight} ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = glow;
  ctx.shadowBlur = size * 0.5;
  ctx.lineWidth = size * 0.12;
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}
