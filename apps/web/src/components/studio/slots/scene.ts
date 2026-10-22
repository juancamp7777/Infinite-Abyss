/**
 * Contrato entre el shell React de las slots y las escenas Canvas, más una clase base con
 * banners, textos flotantes, fondo y ajuste del tablero. Las escenas solo animan el outcome del servidor.
 */
import { Stage, glowText, seeded } from '../engine';

export interface SceneCtl {
  /** Modo turbo (el reloj ya va escalado; las escenas lo usan para acortar pausas opcionales). */
  turbo: boolean;
  /** Ganancia acumulada de la ronda, en veces la apuesta base. */
  onWin(mult: number): void;
  /** Contador de free spins (null = fuera de free spins). */
  onFreeSpins(info: { left: number; total: number } | null): void;
  /** Evento de audio. */
  sfx(name: import('../engine').Sfx, intensity?: number): void;
}

export interface SlotScene<O> {
  /** Anima el outcome completo; resuelve al terminar. Nunca modifica resultados. */
  play(outcome: O, ctl: SceneCtl): Promise<void>;
  /** Partículas y sacudida para celebraciones (1 = big, 2 = mega, 3 = epic). */
  celebrate(tier: number): void;
  destroy(): void;
}

export type SceneFactory<O> = (stage: Stage) => SlotScene<O>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Banner {
  title: string;
  sub?: string;
  t: number;
  color: string;
}
interface Popup {
  x: number;
  y: number;
  text: string;
  t: number;
  color: string;
  size: number;
}

export interface Palette {
  bgTop: string;
  bgBottom: string;
  accent: string;
  glow: string;
  frame: string;
}

/** Base: dibuja fondo (campo de partículas lentas), el tablero y overlays. */
export abstract class BaseScene {
  protected board: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private banner: Banner | null = null;
  private popups: Popup[] = [];
  private stars: Array<{ x: number; y: number; r: number; p: number }> = [];
  protected dim = 0;

  constructor(
    protected readonly stage: Stage,
    protected readonly pal: Palette,
    /** columnas/filas para ajustar el tablero a la pantalla */
    protected readonly cols: number,
    protected readonly rows: number,
    /** relación alto/ancho de una celda */
    protected readonly cellAspect = 1,
  ) {
    const rnd = seeded(7);
    for (let i = 0; i < 70; i++) this.stars.push({ x: rnd(), y: rnd(), r: 0.5 + rnd() * 1.6, p: rnd() * 6.28 });
    stage.onResize = () => this.layout();
    stage.onDraw = (ctx, w, h, t) => this.render(ctx, w, h, t);
    // Las escenas hijas llaman a this.layout() al final de su constructor (sus campos aún no existen aquí).
  }

  /** Tamaño de celda según el tablero ajustado. */
  protected get cell(): number {
    return this.board.w / this.cols;
  }

  protected layout(): void {
    const { width: w, height: h } = this.stage;
    const padX = Math.max(6, w * 0.02);
    const padY = Math.max(6, h * 0.03);
    const cw = Math.min((w - padX * 2) / this.cols, ((h - padY * 2) / this.rows) / this.cellAspect);
    const bw = cw * this.cols;
    const bh = cw * this.cellAspect * this.rows;
    this.board = { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
    this.onLayout();
  }

  protected onLayout(): void {
    /* las escenas hijas pueden recalcular posiciones */
  }

  protected abstract drawBoard(ctx: CanvasRenderingContext2D, t: number): void;

  /** Banner central (intro/fin de free spins). */
  protected async showBanner(title: string, sub: string | undefined, ms: number, color = this.pal.accent): Promise<void> {
    const b: Banner = { title, sub, t: 0, color };
    this.banner = b;
    await this.stage.tweens.tween(ms, (v) => (b.t = v), (x) => x);
    if (this.banner === b) this.banner = null;
  }

  protected popup(x: number, y: number, text: string, color = '#fff6c2', size = 22): void {
    const p: Popup = { x, y, text, t: 0, color, size };
    this.popups.push(p);
    void this.stage.tweens.tween(
      1100,
      (v) => (p.t = v),
      (x2) => x2,
    ).then(() => (this.popups = this.popups.filter((q) => q !== p)));
  }

  protected dimBoard(to: number, ms = 250): Promise<void> {
    return this.stage.tweens.value(this.dim, to, ms, (v) => (this.dim = v));
  }

  private render(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, this.pal.bgTop);
    g.addColorStop(1, this.pal.bgBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    for (const s of this.stars) {
      ctx.globalAlpha = 0.25 + 0.35 * Math.sin(t / 900 + s.p);
      ctx.fillStyle = this.pal.glow;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    this.drawBoard(ctx, t);
    if (this.dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.dim * 0.5})`;
      ctx.fillRect(0, 0, w, h);
    }
    for (const p of this.popups) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (1 - p.t) * 2);
      glowText(ctx, p.text, p.x, p.y - p.t * 40, p.size, p.color, this.pal.glow);
      ctx.restore();
    }
    const b = this.banner;
    if (b) {
      const k = b.t < 0.15 ? b.t / 0.15 : b.t > 0.85 ? (1 - b.t) / 0.15 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, h * 0.36, w, h * 0.28);
      const sc = 0.8 + 0.2 * Math.min(1, k);
      const fs = Math.min(w * 0.11, 64) * sc;
      glowText(ctx, b.title, w / 2, h * 0.47, fs, b.color, this.pal.glow, 900);
      if (b.sub) glowText(ctx, b.sub, w / 2, h * 0.47 + fs * 0.9, fs * 0.42, '#ffffff', this.pal.glow, 600);
      ctx.restore();
    }
  }

  /** Celebración compartida: partículas y sacudida. */
  celebrate(tier: number): void {
    const { width: w, height: h } = this.stage;
    const n = 30 + tier * 24;
    for (let i = 0; i < 4 + tier * 2; i++) {
      this.stage.particles.burst(w * (0.15 + Math.random() * 0.7), h * (0.25 + Math.random() * 0.4), {
        count: Math.ceil(n / 4),
        color: [this.pal.accent, '#ffffff', this.pal.glow, '#ffd86b'],
        speed: 320,
        size: 4,
        life: 1100,
        shape: i % 2 ? 'star' : 'dot',
      });
    }
    this.stage.shake(4 + tier * 3, 300 + tier * 120);
  }

  destroy(): void {
    this.stage.tweens.clear();
    this.stage.particles.clear();
    this.stage.onDraw = () => undefined;
    this.stage.onResize = () => undefined;
  }
}
