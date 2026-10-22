/**
 * Sonido sintetizado con WebAudio (sin archivos). Silenciado por defecto; la preferencia se persiste.
 */
const KEY = 'nymfo.studio.sound';

export type Sfx = 'spin' | 'stop' | 'land' | 'win' | 'tumble' | 'scatter' | 'anticipation' | 'orb' | 'big' | 'click';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _enabled = false;
  private listeners = new Set<() => void>();

  constructor() {
    try {
      this._enabled = typeof window !== 'undefined' && window.localStorage.getItem(KEY) === '1';
    } catch {
      this._enabled = false;
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setEnabled(v: boolean): void {
    this._enabled = v;
    try {
      window.localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* sin almacenamiento */
    }
    if (v) this.ensure();
    this.listeners.forEach((l) => l());
  }

  /** Debe llamarse desde un gesto del usuario para desbloquear el audio. */
  ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  play(name: Sfx, intensity = 0): void {
    if (!this._enabled || !this.ensure()) return;
    switch (name) {
      case 'click':
        this.tone(520, 0.05, 'square', 0.12);
        break;
      case 'spin':
        this.tone(180, 0.18, 'sawtooth', 0.1, 0, 90);
        break;
      case 'stop':
        this.tone(140, 0.09, 'triangle', 0.22);
        break;
      case 'land':
        this.tone(220 + Math.random() * 40, 0.06, 'triangle', 0.1);
        break;
      case 'tumble':
        this.tone(330 + intensity * 40, 0.14, 'sine', 0.2, 0, 660 + intensity * 60);
        break;
      case 'win':
        [523, 659, 784].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.18, i * 0.07));
        break;
      case 'scatter':
        [440, 554, 659, 880].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.2, i * 0.08));
        break;
      case 'anticipation':
        this.tone(300, 0.6, 'sawtooth', 0.08, 0, 900);
        break;
      case 'orb':
        this.tone(900, 0.25, 'sine', 0.18, 0, 1500);
        this.tone(1200, 0.2, 'triangle', 0.1, 0.05);
        break;
      case 'big':
        [392, 494, 587, 784, 988].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.22, i * 0.09));
        break;
    }
  }
}

export const sound = new SoundEngine();
