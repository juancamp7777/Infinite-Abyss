/** Easings y gestor de tweens del mini motor Canvas 2D de Studios. */
export type Ease = (t: number) => number;

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  /** Rebote al caer (ideal para símbolos que aterrizan). */
  outBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * (2 * Math.PI)) / 3) + 1),
} satisfies Record<string, Ease>;

interface Tween {
  elapsed: number;
  delay: number;
  duration: number;
  ease: Ease;
  onUpdate: (v: number) => void;
  resolve: () => void;
}

/** Tweens y esperas avanzados por el reloj del escenario (respetan turbo/skip). Cada uno devuelve una promesa. */
export class Tweens {
  private list: Tween[] = [];

  tween(duration: number, onUpdate: (v: number) => void, easing: Ease = ease.outCubic, delay = 0): Promise<void> {
    return new Promise((resolve) => {
      this.list.push({ elapsed: 0, delay, duration: Math.max(1, duration), ease: easing, onUpdate, resolve });
    });
  }

  wait(ms: number): Promise<void> {
    return this.tween(ms, () => undefined, ease.linear);
  }

  /** Interpola un número entre a y b. */
  value(a: number, b: number, duration: number, onUpdate: (v: number) => void, easing: Ease = ease.outCubic, delay = 0): Promise<void> {
    return this.tween(duration, (t) => onUpdate(a + (b - a) * t), easing, delay);
  }

  update(dtMs: number): void {
    if (!this.list.length) return;
    const done: Tween[] = [];
    for (const tw of this.list) {
      let d = dtMs;
      if (tw.delay > 0) {
        tw.delay -= d;
        if (tw.delay > 0) continue;
        d = -tw.delay;
        tw.delay = 0;
      }
      tw.elapsed += d;
      const t = Math.min(1, tw.elapsed / tw.duration);
      tw.onUpdate(tw.ease(t));
      if (t >= 1) done.push(tw);
    }
    if (done.length) {
      this.list = this.list.filter((x) => !done.includes(x));
      for (const tw of done) tw.resolve();
    }
  }

  get active(): number {
    return this.list.length;
  }

  clear(): void {
    const l = this.list;
    this.list = [];
    for (const tw of l) tw.resolve();
  }
}
