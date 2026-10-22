/** Arte de Ember Lines dibujado por código: faroles, abanico, campana, chispas, wild (llama) y scatter (farolillo). */
import { gemFill, polyPath, shine, starPath } from '../../engine';

const SPARK: Array<[string, string, string]> = [
  ['#fff0b0', '#d97706', '#fbbf24'],
  ['#ffd0d0', '#b91c1c', '#f87171'],
  ['#cfe5ff', '#1d4ed8', '#60a5fa'],
  ['#c8ffe0', '#047857', '#34d399'],
];

export const EMBER_GLOW = ['#ff6a3d', '#34d399', '#ffa94d', '#e0a458', '#fbbf24', '#f87171', '#60a5fa', '#34d399', '#ff7a1a', '#7cd4ff'];

function lantern(ctx: CanvasRenderingContext2D, s: number, light: string, dark: string, glow: string, hex: boolean): void {
  const r = s * 0.38;
  ctx.strokeStyle = '#f5c451';
  ctx.lineWidth = s * 0.04;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.15);
  ctx.lineTo(0, -r * 0.85);
  ctx.stroke();
  ctx.fillStyle = '#f5c451';
  ctx.fillRect(-r * 0.35, -r * 0.9, r * 0.7, r * 0.16);
  ctx.beginPath();
  if (hex) {
    ctx.moveTo(-r * 0.7, -r * 0.7);
    ctx.lineTo(r * 0.7, -r * 0.7);
    ctx.lineTo(r * 0.95, 0);
    ctx.lineTo(r * 0.7, r * 0.7);
    ctx.lineTo(-r * 0.7, r * 0.7);
    ctx.lineTo(-r * 0.95, 0);
    ctx.closePath();
  } else {
    ctx.ellipse(0, 0, r * 0.95, r * 0.78, 0, 0, Math.PI * 2);
  }
  gemFill(ctx, s, light, dark, glow, '#f5c451');
  ctx.strokeStyle = 'rgba(245,196,81,.7)';
  ctx.lineWidth = s * 0.02;
  for (const k of [-0.4, 0, 0.4]) {
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.abs(k) * r * 0.9 + 0.01, r * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#f5c451';
  ctx.fillRect(-r * 0.35, r * 0.72, r * 0.7, r * 0.14);
  ctx.strokeStyle = '#f5c451';
  ctx.lineWidth = s * 0.025;
  for (const k of [-0.2, 0, 0.2]) {
    ctx.beginPath();
    ctx.moveTo(k * r, r * 0.86);
    ctx.lineTo(k * r, r * 1.2);
    ctx.stroke();
  }
}

function flame(ctx: CanvasRenderingContext2D, s: number, scale: number): void {
  const r = s * 0.4 * scale;
  ctx.beginPath();
  ctx.moveTo(0, -r * 1.2);
  ctx.bezierCurveTo(r * 0.5, -r * 0.6, r * 1.0, -r * 0.1, r * 0.8, r * 0.5);
  ctx.bezierCurveTo(r * 0.6, r * 1.1, -r * 0.6, r * 1.1, -r * 0.8, r * 0.5);
  ctx.bezierCurveTo(-r * 1.0, -r * 0.1, -r * 0.3, -r * 0.5, 0, -r * 1.2);
}

export function paintEmber(id: number, ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.38;
  ctx.save();
  if (id === 0) lantern(ctx, s, '#ff9a7a', '#b3120f', '#ff4d2e', false);
  else if (id === 1) lantern(ctx, s, '#b8ffd9', '#0b7a53', '#34d399', true);
  else if (id === 2) {
    // Abanico
    for (let i = 0; i < 7; i++) {
      ctx.save();
      ctx.translate(0, r * 0.8);
      ctx.rotate(-Math.PI / 2 + (i - 3) * 0.36);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(r * 1.45, -r * 0.2);
      ctx.lineTo(r * 1.45, r * 0.2);
      ctx.closePath();
      ctx.fillStyle = i % 2 ? '#ffb347' : '#ff7a1a';
      ctx.shadowColor = '#ff9a3d';
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,200,.7)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  } else if (id === 3) {
    // Campana de bronce
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.95);
    ctx.bezierCurveTo(-r * 0.2, -r * 1.15, r * 0.2, -r * 1.15, r * 0.2, -r * 0.95);
    ctx.bezierCurveTo(r * 0.95, -r * 0.6, r * 0.6, r * 0.35, r * 1.05, r * 0.7);
    ctx.lineTo(-r * 1.05, r * 0.7);
    ctx.bezierCurveTo(-r * 0.6, r * 0.35, -r * 0.95, -r * 0.6, -r * 0.2, -r * 0.95);
    gemFill(ctx, s, '#f7d9a0', '#8a5a1e', '#e0a458');
    ctx.beginPath();
    ctx.arc(0, r * 0.95, r * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = '#f5c451';
    ctx.fill();
  } else if (id >= 4 && id <= 7) {
    const [l, d, g] = SPARK[id - 4];
    starPath(ctx, 4, r * 1.1, r * 0.5);
    gemFill(ctx, s, l, d, g);
    polyPath(ctx, 4, r * 0.28, Math.PI / 4);
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fill();
  } else if (id === 8) {
    // Llama viva (wild)
    ctx.shadowColor = '#ff7a1a';
    ctx.shadowBlur = s * 0.25;
    flame(ctx, s, 1.0);
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, '#ffe45e');
    g.addColorStop(0.5, '#ff7a1a');
    g.addColorStop(1, '#b3120f');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    flame(ctx, s, 0.55);
    ctx.fillStyle = '#fff6c4';
    ctx.fill();
    ctx.font = `900 ${s * 0.2}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7a1d05';
    ctx.fillText('WILD', 0, r * 0.55);
  } else {
    // Farolillo celeste (scatter)
    ctx.shadowColor = '#7cd4ff';
    ctx.shadowBlur = s * 0.28;
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, -r * 0.9);
    ctx.bezierCurveTo(-r * 1.3, -r * 0.2, -r * 1.0, r * 0.8, -r * 0.45, r * 0.95);
    ctx.lineTo(r * 0.45, r * 0.95);
    ctx.bezierCurveTo(r * 1.0, r * 0.8, r * 1.3, -r * 0.2, r * 0.55, -r * 0.9);
    ctx.closePath();
    const g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#9ee0ff');
    g.addColorStop(1, '#2b6cc4');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = s * 0.035;
    ctx.stroke();
    starPath(ctx, 5, r * 0.38, r * 0.17);
    ctx.fillStyle = '#ffd34d';
    ctx.fill();
  }
  shine(ctx, s * 0.85, 0.22);
  ctx.restore();
}
