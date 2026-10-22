/** Arte de Verdant Grid dibujado por código: flora fantástica. 0–7 símbolos de pago, 8 = Fuente Encantada (scatter). */
import { gemFill, shine } from '../../engine';

function petals(ctx: CanvasRenderingContext2D, n: number, len: number, wid: number, light: string, dark: string, glow: string, rot = -Math.PI / 2): void {
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.rotate(rot + (i * Math.PI * 2) / n);
    ctx.beginPath();
    ctx.ellipse(len * 0.55, 0, len * 0.5, wid, 0, 0, Math.PI * 2);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 8;
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, dark);
    g.addColorStop(1, light);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }
}

export function paintVerdant(id: number, ctx: CanvasRenderingContext2D, s: number): void {
  const r = s * 0.38;
  ctx.save();
  switch (id) {
    case 0: // Orquídea Lunar
      petals(ctx, 5, r * 1.05, r * 0.34, '#f1e6ff', '#8b5cf6', '#c4b5fd');
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#fff3a8';
      ctx.shadowColor = '#fde047';
      ctx.shadowBlur = 10;
      ctx.fill();
      break;
    case 1: {
      // Mandrágora Dormida: raíz con hojas
      ctx.beginPath();
      ctx.moveTo(0, r * 1.05);
      ctx.bezierCurveTo(-r * 0.9, r * 0.5, -r * 0.7, -r * 0.5, 0, -r * 0.5);
      ctx.bezierCurveTo(r * 0.7, -r * 0.5, r * 0.9, r * 0.5, 0, r * 1.05);
      gemFill(ctx, s, '#e9c9a0', '#7a4a22', '#c08a52');
      ctx.fillStyle = '#2a1608';
      ctx.fillRect(-r * 0.32, -r * 0.05, r * 0.18, r * 0.07);
      ctx.fillRect(r * 0.14, -r * 0.05, r * 0.18, r * 0.07);
      ctx.save();
      for (const k of [-1, 0, 1]) {
        ctx.beginPath();
        ctx.ellipse(k * r * 0.45, -r * 0.82 + Math.abs(k) * r * 0.12, r * 0.14, r * 0.36, k * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = '#4ade80';
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 8;
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 2: // Rosa de Cristal
      petals(ctx, 8, r * 1.0, r * 0.36, '#ffe4ec', '#e11d48', '#fb7185', 0);
      petals(ctx, 6, r * 0.62, r * 0.24, '#fff1f4', '#fb7185', '#ffc2d1', 0.3);
      break;
    case 3: // Helecho Dorado
      ctx.strokeStyle = '#fde68a';
      ctx.lineWidth = s * 0.045;
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, r * 1.0);
      ctx.quadraticCurveTo(r * 0.8, r * 0.2, r * 0.3, -r * 1.0);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const t = 0.15 + i * 0.15;
        const x = -r * 0.5 * (1 - t) * (1 - t) + 2 * (1 - t) * t * r * 0.8 + t * t * r * 0.3;
        const y = r * (1 - t) * (1 - t) + 2 * (1 - t) * t * r * 0.2 - t * t * r;
        for (const d of [-1, 1]) {
          ctx.beginPath();
          ctx.ellipse(x + d * r * 0.28, y, r * 0.3 * (1 - t * 0.5), r * 0.09, d * -0.6, 0, Math.PI * 2);
          ctx.fillStyle = i % 2 ? '#fbbf24' : '#f59e0b';
          ctx.fill();
        }
      }
      break;
    case 4: // Semilla Azul
      ctx.beginPath();
      ctx.moveTo(0, -r * 1.05);
      ctx.bezierCurveTo(r * 0.95, -r * 0.1, r * 0.8, r * 0.95, 0, r * 0.95);
      ctx.bezierCurveTo(-r * 0.8, r * 0.95, -r * 0.95, -r * 0.1, 0, -r * 1.05);
      gemFill(ctx, s, '#bfe3ff', '#1d4ed8', '#60a5fa');
      break;
    case 5: // Hoja de Rocío
      ctx.beginPath();
      ctx.moveTo(-r * 0.95, r * 0.9);
      ctx.bezierCurveTo(-r * 1.1, -r * 0.5, 0, -r * 1.2, r * 1.0, -r * 0.95);
      ctx.bezierCurveTo(r * 1.1, 0, r * 0.2, r * 1.1, -r * 0.95, r * 0.9);
      gemFill(ctx, s, '#bbf7d0', '#15803d', '#4ade80');
      ctx.strokeStyle = 'rgba(255,255,255,.7)';
      ctx.lineWidth = s * 0.025;
      ctx.beginPath();
      ctx.moveTo(-r * 0.85, r * 0.8);
      ctx.quadraticCurveTo(0, 0, r * 0.85, -r * 0.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r * 0.35, r * 0.3, r * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(190,240,255,.9)';
      ctx.fill();
      break;
    case 6: // Baya Ígnea
      for (const [x, y, k] of [[-0.35, 0.3, 0.55], [0.4, 0.25, 0.5], [0.02, -0.4, 0.55]] as const) {
        ctx.save();
        ctx.translate(x * r, y * r);
        ctx.beginPath();
        ctx.arc(0, 0, r * k, 0, Math.PI * 2);
        gemFill(ctx, s * 0.6, '#ffd2a8', '#c2410c', '#fb923c');
        ctx.restore();
      }
      break;
    default: {
      if (id === 7) {
        // Seta Violeta
        ctx.beginPath();
        ctx.moveTo(-r * 1.05, r * 0.1);
        ctx.bezierCurveTo(-r * 1.05, -r * 1.2, r * 1.05, -r * 1.2, r * 1.05, r * 0.1);
        ctx.closePath();
        gemFill(ctx, s, '#e9d5ff', '#7e22ce', '#c084fc');
        ctx.fillStyle = '#fdf4ff';
        for (const [x, y, k] of [[-0.45, -0.3, 0.16], [0.1, -0.6, 0.2], [0.5, -0.2, 0.14]] as const) {
          ctx.beginPath();
          ctx.arc(x * r, y * r, k * r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.roundRect(-r * 0.3, r * 0.1, r * 0.6, r * 0.85, r * 0.2);
        ctx.fillStyle = '#f5e9d6';
        ctx.fill();
      } else {
        // Fuente Encantada (scatter)
        ctx.shadowColor = '#5eead4';
        ctx.shadowBlur = s * 0.25;
        const g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.05);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.5, '#5eead4');
        g.addColorStop(1, '#0f766e');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#fde68a';
        ctx.lineWidth = s * 0.05;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 3; i++) {
          const a = -Math.PI / 2 + (i - 1) * 0.6;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
          ctx.quadraticCurveTo(Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35 - r * 0.3, 0, r * 0.35);
          ctx.quadraticCurveTo(Math.cos(a) * r * 0.5 + r * 0.1, Math.sin(a) * r * 0.5, Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
          ctx.fill();
        }
      }
    }
  }
  shine(ctx, s * 0.9, 0.25);
  ctx.restore();
}

export const VERDANT_GLOW = ['#c4b5fd', '#c08a52', '#fb7185', '#fbbf24', '#60a5fa', '#4ade80', '#fb923c', '#c084fc', '#5eead4'];
