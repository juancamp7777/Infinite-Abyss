/** Arte de Starfall Nymphs dibujado por código (paths y gradientes propios). */
import { gemFill, polyPath, shine, starPath } from '../../engine';

export const STARFALL_SYMBOLS = ['astra', 'lyra', 'selene', 'orbis', 'comet', 'nebula', 'pulsar', 'quark', 'meteor'] as const;

const PALETTE: Record<string, [string, string, string]> = {
  astra: ['#fff2a8', '#f59e0b', '#ffd34d'],
  lyra: ['#ffd1f0', '#c026d3', '#ff7ae0'],
  selene: ['#e6f2ff', '#4f7cff', '#9ec2ff'],
  orbis: ['#b9fff0', '#0f9d8a', '#34e0c4'],
  comet: ['#ffe2b0', '#e8590c', '#ff9f43'],
  nebula: ['#e9d5ff', '#6d28d9', '#a78bfa'],
  pulsar: ['#ccfbff', '#0891b2', '#22d3ee'],
  quark: ['#ffe0ec', '#e11d74', '#ff6fa8'],
  meteor: ['#d8cfc6', '#5b4636', '#a08672'],
};

export function paintStarfall(sym: string, ctx: CanvasRenderingContext2D, s: number): void {
  if (sym.startsWith('x')) return paintOrb(sym.slice(1), ctx, s);
  if (sym === 'portal') return paintPortal(ctx, s);
  const [light, dark, glow] = PALETTE[sym] ?? PALETTE.astra;
  const r = s * 0.36;
  ctx.save();
  switch (sym) {
    case 'astra':
      starPath(ctx, 5, r * 1.08, r * 0.48);
      gemFill(ctx, s, light, dark, glow);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.8)';
      ctx.fill();
      break;
    case 'lyra':
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.05);
      ctx.quadraticCurveTo(r * 0.95, -r * 0.2, 0, r * 1.05);
      ctx.quadraticCurveTo(-r * 0.95, -r * 0.2, 0, -r * 1.05);
      gemFill(ctx, s, light, dark, glow);
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = s * 0.02;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(i * r * 0.2, -r * 0.6 + Math.abs(i) * r * 0.1);
        ctx.lineTo(i * r * 0.2, r * 0.6 - Math.abs(i) * r * 0.1);
        ctx.stroke();
      }
      break;
    case 'selene':
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.05, Math.PI * 0.35, Math.PI * 1.65, false);
      ctx.bezierCurveTo(r * 0.2, -r * 0.9, r * 0.2, r * 0.9, Math.cos(Math.PI * 0.35) * r * 1.05, Math.sin(Math.PI * 0.35) * r * 1.05);
      ctx.closePath();
      gemFill(ctx, s, light, dark, glow);
      break;
    case 'orbis': {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      gemFill(ctx, s, light, dark, glow);
      ctx.restore();
      ctx.save();
      ctx.rotate(-0.4);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.3, r * 0.38, 0, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = s * 0.07;
      ctx.shadowColor = '#ffd34d';
      ctx.shadowBlur = s * 0.1;
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'comet': {
      ctx.beginPath();
      ctx.moveTo(-r * 1.15, -r * 1.0);
      ctx.quadraticCurveTo(-r * 0.2, -r * 0.9, r * 0.5, -r * 0.55);
      ctx.lineTo(r * 0.55, r * 0.5);
      ctx.quadraticCurveTo(-r * 0.4, r * 0.1, -r * 1.15, -r * 1.0);
      ctx.fillStyle = 'rgba(255,190,90,.55)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.18, r * 0.05, r * 0.7, 0, Math.PI * 2);
      gemFill(ctx, s, light, dark, glow);
      break;
    }
    case 'nebula':
      polyPath(ctx, 6, r * 1.02, 0);
      gemFill(ctx, s, light, dark, glow);
      polyPath(ctx, 6, r * 0.5, 0);
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fill();
      break;
    case 'pulsar':
      starPath(ctx, 4, r * 1.12, r * 0.34);
      gemFill(ctx, s, light, dark, glow);
      break;
    case 'quark':
      polyPath(ctx, 3, r * 1.15, -Math.PI / 2);
      ctx.lineJoin = 'round';
      gemFill(ctx, s, light, dark, glow);
      ctx.beginPath();
      ctx.arc(0, r * 0.08, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fill();
      break;
    default: {
      ctx.beginPath();
      const pts = [1, 0.8, 1.05, 0.78, 0.98, 0.85, 1.02, 0.8];
      pts.forEach((k, i) => {
        const a = (i * Math.PI * 2) / pts.length;
        ctx.lineTo(Math.cos(a) * r * k, Math.sin(a) * r * k);
      });
      ctx.closePath();
      gemFill(ctx, s, light, dark, glow, 'rgba(255,255,255,.4)');
    }
  }
  shine(ctx, s * 0.9, 0.35);
  ctx.restore();
}

function paintPortal(ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.42;
  ctx.save();
  ctx.shadowColor = '#7cf3ff';
  ctx.shadowBlur = s * 0.25;
  const g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#7cf3ff');
  g.addColorStop(0.75, '#6d28d9');
  g.addColorStop(1, '#1e1b4b');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = s * 0.04;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(0, 0, r * (0.25 + i * 0.22), i * 1.1, i * 1.1 + Math.PI * 1.3);
    ctx.stroke();
  }
  ctx.strokeStyle = '#ffd34d';
  ctx.lineWidth = s * 0.05;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function paintOrb(value: string, ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.4;
  ctx.save();
  ctx.shadowColor = '#ff5cf0';
  ctx.shadowBlur = s * 0.3;
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.05, 0, 0, r);
  g.addColorStop(0, '#fff7d6');
  g.addColorStop(0.45, '#ff8ae8');
  g.addColorStop(1, '#6d1b9c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = s * 0.035;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `900 ${s * (value.length > 2 ? 0.28 : 0.34)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#3b0764';
  ctx.shadowBlur = 4;
  ctx.fillText(`${value}x`, 0, s * 0.02);
  ctx.restore();
}
