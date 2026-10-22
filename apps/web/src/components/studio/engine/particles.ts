/** Partículas simples (chispas, confeti, estelas) dibujadas en canvas con composición aditiva. */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  gravity: number;
  drag: number;
  shape: 'dot' | 'star' | 'rect';
  rot: number;
  vr: number;
}

export interface BurstOptions {
  count?: number;
  color?: string | string[];
  speed?: number;
  spread?: number;
  angle?: number;
  size?: number;
  life?: number;
  gravity?: number;
  shape?: Particle['shape'];
}

export class ParticleSystem {
  private items: Particle[] = [];
  /** Tope para no degradar el rendimiento en móviles. */
  maxParticles = 600;
  enabled = true;

  burst(x: number, y: number, o: BurstOptions = {}): void {
    if (!this.enabled) return;
    const n = o.count ?? 16;
    const colors = Array.isArray(o.color) ? o.color : [o.color ?? '#ffd86b'];
    for (let i = 0; i < n && this.items.length < this.maxParticles; i++) {
      const a = (o.angle ?? 0) + (Math.random() - 0.5) * (o.spread ?? Math.PI * 2) + ((o.spread ?? Math.PI * 2) >= Math.PI * 2 ? Math.random() * Math.PI : 0);
      const sp = (o.speed ?? 220) * (0.35 + Math.random() * 0.8);
      const life = (o.life ?? 800) * (0.6 + Math.random() * 0.7);
      this.items.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life,
        max: life,
        size: (o.size ?? 4) * (0.6 + Math.random() * 0.8),
        color: colors[Math.floor(Math.random() * colors.length)],
        gravity: o.gravity ?? 260,
        drag: 0.6,
        shape: o.shape ?? 'dot',
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 10,
      });
    }
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.items) {
      p.life -= dtMs;
      p.vx *= Math.max(0, 1 - p.drag * dt);
      p.vy = p.vy * Math.max(0, 1 - p.drag * dt) + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    this.items = this.items.filter((p) => p.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.items.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.items) {
      const k = Math.max(0, p.life / p.max);
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.fillStyle = p.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const s = p.size * (0.4 + k * 0.6);
      if (p.shape === 'rect') ctx.fillRect(-s, -s / 2, s * 2, s);
      else if (p.shape === 'star') {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const r = i % 2 ? s * 0.4 : s * 1.4;
          const a = (i * Math.PI) / 4;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  clear(): void {
    this.items = [];
  }

  get count(): number {
    return this.items.length;
  }
}
