/**
 * Escenario Canvas 2D: bucle rAF, HiDPI, resize, tweens, partículas, sacudida de cámara y reloj escalable (turbo/skip).
 * Las coordenadas lógicas son en px CSS (el contexto ya está escalado por devicePixelRatio).
 */
import { ParticleSystem } from './particles';
import { Tweens } from './tween';

export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void;

export class Stage {
  readonly tweens = new Tweens();
  readonly particles = new ParticleSystem();
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;
  /** Multiplicador del reloj de animación (turbo > 1). */
  timeScale = 1;
  time = 0;
  reducedMotion = false;
  onDraw: DrawFn = () => undefined;
  onUpdate: (dtMs: number) => void = () => undefined;
  onResize: (w: number, h: number) => void = () => undefined;

  private raf = 0;
  private last = 0;
  private running = false;
  private ro: ResizeObserver | null = null;
  private shakeAmp = 0;
  private shakeTime = 0;
  private shakeDur = 0;
  private mq: MediaQueryList | null = null;
  private mqListener = () => {
    this.reducedMotion = !!this.mq?.matches;
    this.particles.enabled = !this.reducedMotion;
  };

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D no disponible');
    this.ctx = ctx;
    if (typeof window.matchMedia === 'function') {
      this.mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.mqListener();
      this.mq.addEventListener?.('change', this.mqListener);
    }
    const parent = canvas.parentElement ?? canvas;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(parent);
    this.resize();
  }

  resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.onResize(w, h);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      // dt acotado: tras una pausa de pestaña no se salta la animación.
      const dt = Math.min(50, now - this.last) * this.timeScale;
      this.last = now;
      this.time += dt;
      this.tweens.update(dt);
      this.particles.update(dt);
      this.onUpdate(dt);
      if (this.shakeTime > 0) this.shakeTime = Math.max(0, this.shakeTime - dt);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy(): void {
    this.stop();
    this.ro?.disconnect();
    this.mq?.removeEventListener?.('change', this.mqListener);
    this.tweens.clear();
    this.particles.clear();
  }

  /** Sacudida de cámara (se ignora con reduced-motion). */
  shake(amplitude = 8, durationMs = 350): void {
    if (this.reducedMotion) return;
    this.shakeAmp = amplitude;
    this.shakeDur = durationMs;
    this.shakeTime = durationMs;
  }

  private render(): void {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    if (this.shakeTime > 0) {
      const k = this.shakeTime / this.shakeDur;
      const a = this.shakeAmp * k * k;
      ctx.translate((Math.random() - 0.5) * 2 * a, (Math.random() - 0.5) * 2 * a);
    }
    this.onDraw(ctx, this.width, this.height, this.time);
    this.particles.draw(ctx);
    ctx.restore();
  }
}

/** Contador numérico que sube hasta un objetivo (para ganancias). */
export class CountUp {
  value = 0;
  constructor(private stage: Stage) {}
  to(target: number, durationMs: number, onUpdate?: (v: number) => void): Promise<void> {
    const from = this.value;
    return this.stage.tweens.value(from, target, durationMs, (v) => {
      this.value = v;
      onUpdate?.(v);
    });
  }
}
