/** Escena Canvas de Ember Lines (5x3, 20 líneas): giro de rodillos, anticipación, líneas ganadoras, wild expansivo y FS. */
import { Stage, drawSprite, ease, glowText, roundRect, sprite } from '../../engine';
import type { EmberOutcome, EmberSpin } from '../outcomes';
import { BaseScene, type Palette, type SceneCtl, type SlotScene } from '../scene';
import { EMBER_GLOW, paintEmber } from '../art/ember';

const REELS = 5;
const ROWS = 3;
const LINE_COLORS = ['#ffd34d', '#ff6a3d', '#7cd4ff', '#34d399', '#ff7ae0', '#c4b5fd'];

interface Reel {
  strip: number[];
  pos: number;
  antic: boolean;
  spinning: boolean;
  wildFx: number;
  sticky: boolean;
}

const PAL: Palette = { bgTop: '#3a0d08', bgBottom: '#0d0302', accent: '#ffb347', glow: '#ff7a1a', frame: '#c2410c' };

export class EmberScene extends BaseScene implements SlotScene<EmberOutcome> {
  private reels: Reel[] = [];
  private hl: number[][] = Array.from({ length: REELS }, () => new Array(ROWS).fill(0));
  private lineFx: { pts: Array<{ x: number; y: number }>; color: string; a: number } | null = null;
  private current: number[][] = [];
  private ctl!: SceneCtl;

  constructor(stage: Stage) {
    super(stage, PAL, REELS, ROWS);
    for (let i = 0; i < REELS; i++) {
      const col = [0, 1, 2].map(() => Math.floor(Math.random() * 8));
      this.current.push(col);
      this.reels.push({ strip: col.slice(), pos: 0, antic: false, spinning: false, wildFx: 0, sticky: false });
    }
    this.layout();
  }

  private pos(reel: number, row: number): { x: number; y: number } {
    return { x: this.board.x + (reel + 0.5) * this.cell, y: this.board.y + (row + 0.5) * this.cell };
  }

  protected drawBoard(ctx: CanvasRenderingContext2D, t: number): void {
    const { board, cell } = this;
    ctx.save();
    roundRect(ctx, board.x - 7, board.y - 7, board.w + 14, board.h + 14, 14);
    ctx.fillStyle = 'rgba(20,4,2,.85)';
    ctx.fill();
    ctx.lineWidth = 4;
    const g = ctx.createLinearGradient(board.x, board.y, board.x + board.w, board.y + board.h);
    g.addColorStop(0, '#f5c451');
    g.addColorStop(0.5, '#c2410c');
    g.addColorStop(1, '#f5c451');
    ctx.strokeStyle = g;
    ctx.shadowColor = this.pal.glow;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();

    const dpr = this.stage.dpr;
    for (let i = 0; i < REELS; i++) {
      const rl = this.reels[i];
      const x = board.x + i * cell;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 1, board.y, cell - 2, board.h);
      ctx.clip();
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.015)';
      ctx.fillRect(x, board.y, cell, board.h);
      const first = Math.floor(rl.pos) - 1;
      for (let j = first; j <= first + ROWS + 2; j++) {
        if (j < 0 || j >= rl.strip.length) continue;
        const row = j - rl.pos;
        const id = rl.strip[j];
        const cy = board.y + (row + 0.5) * cell;
        const size = cell * 0.86;
        const sp = sprite(`em-${id}`, size, dpr, (c2, s) => paintEmber(id, c2, s));
        const r = Math.round(row);
        const hv = row >= -0.01 && row < ROWS && Math.abs(row - r) < 0.02 ? this.hl[i][r] ?? 0 : 0;
        if (hv > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const gg = ctx.createRadialGradient(x + cell / 2, cy, 0, x + cell / 2, cy, cell * 0.62);
          const col = EMBER_GLOW[id] ?? '#fff';
          gg.addColorStop(0, col + 'dd');
          gg.addColorStop(1, col + '00');
          ctx.fillStyle = gg;
          ctx.globalAlpha = hv;
          ctx.fillRect(x - cell * 0.2, cy - cell, cell * 1.4, cell * 2);
          ctx.restore();
        }
        ctx.save();
        if (rl.spinning) ctx.globalAlpha = 0.82;
        drawSprite(ctx, sp, x + cell / 2, cy, size, 1 + hv * (0.1 + 0.05 * Math.sin(t / 70)));
        ctx.restore();
      }
      if (rl.wildFx > 0 || rl.sticky) {
        const k = rl.sticky ? 1 : rl.wildFx;
        const gr = ctx.createLinearGradient(0, board.y + board.h, 0, board.y);
        gr.addColorStop(0, `rgba(255,90,20,${0.55 * k})`);
        gr.addColorStop(1, `rgba(255,220,90,${0.15 * k})`);
        ctx.fillStyle = gr;
        ctx.fillRect(x, board.y + board.h * (1 - k), cell, board.h * k);
      }
      ctx.restore();
      if (rl.antic) {
        ctx.save();
        ctx.lineWidth = 3 + Math.sin(t / 60) * 1.5;
        ctx.strokeStyle = '#7cd4ff';
        ctx.shadowColor = '#7cd4ff';
        ctx.shadowBlur = 18;
        roundRect(ctx, x + 2, board.y + 2, cell - 4, board.h - 4, 8);
        ctx.stroke();
        ctx.restore();
      }
    }
    // Separadores de rodillo.
    ctx.save();
    ctx.strokeStyle = 'rgba(245,196,81,.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i < REELS; i++) {
      ctx.beginPath();
      ctx.moveTo(board.x + i * cell, board.y);
      ctx.lineTo(board.x + i * cell, board.y + board.h);
      ctx.stroke();
    }
    ctx.restore();

    const lf = this.lineFx;
    if (lf && lf.pts.length > 1) {
      ctx.save();
      ctx.globalAlpha = lf.a;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = lf.color;
      ctx.lineWidth = Math.max(3, cell * 0.07);
      ctx.shadowColor = lf.color;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      lf.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();
    }
  }

  private setStatic(grid: number[][]): void {
    this.current = grid.map((c) => c.slice());
    grid.forEach((col, i) => {
      const rl = this.reels[i];
      rl.strip = col.slice();
      rl.pos = 0;
      rl.spinning = false;
      rl.antic = false;
    });
  }

  private async spinReels(spin: EmberSpin): Promise<void> {
    const { tweens } = this.stage;
    // Tiempos de parada; con 2 scatters ya detenidos, los rodillos restantes hacen anticipación.
    const T: number[] = [];
    const anticip: boolean[] = [];
    let scat = 0;
    for (let i = 0; i < REELS; i++) {
      anticip[i] = scat >= 2;
      T[i] = (i ? T[i - 1] + 280 : 750) + (anticip[i] ? 900 : 0);
      if (spin.grid[i].includes(9)) scat += spin.grid[i].filter((v) => v === 9).length;
    }
    this.ctl.sfx('spin');
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < REELS; i++) {
      const rl = this.reels[i];
      if (rl.sticky) continue;
      const L = Math.max(8, Math.round(T[i] / 55));
      const prev = this.current[i];
      const strip = [...prev];
      for (let k = 0; k < L - 3; k++) strip.push(Math.floor(Math.random() * 8));
      strip.push(...spin.grid[i], 0, 1);
      rl.strip = strip;
      rl.pos = 0;
      rl.spinning = true;
      jobs.push(
        (async () => {
          if (anticip[i]) {
            void tweens.wait(Math.max(0, T[i] - 900)).then(() => {
              rl.antic = true;
              this.ctl.sfx('anticipation');
              this.stage.particles.burst(this.board.x + (i + 0.5) * this.cell, this.board.y + this.board.h / 2, { count: 10, color: '#7cd4ff', speed: 160, size: 3, life: 700 });
            });
          }
          await tweens.value(0, L - 1, Math.max(1, T[i] - 260), (v) => (rl.pos = v), ease.linear);
          await tweens.value(L - 1, L, 260, (v) => (rl.pos = v), ease.outBack);
          rl.pos = L;
          rl.spinning = false;
          rl.antic = false;
          this.ctl.sfx('stop');
          if (spin.grid[i].includes(9)) this.stage.shake(3, 140);
        })(),
      );
    }
    await Promise.all(jobs);
    this.setStatic(spin.grid);
  }

  private async playSpin(spin: EmberSpin, baseRun: number, fs: boolean): Promise<number> {
    const { tweens, particles } = this.stage;
    this.lineFx = null;
    await this.spinReels(spin);

    if (spin.scatterCount >= 3 || spin.scatterWin > 0) {
      this.ctl.sfx('scatter');
      const act = spin.scatterPositions;
      await tweens.value(0, 1, 800, (v) => act.forEach(([r, w]) => (this.hl[r][w] = Math.sin(Math.PI * v) * 0.9 + 0.1)), ease.linear);
      act.forEach(([r, w]) => (this.hl[r][w] = 0));
      if (spin.scatterWin > 0) this.popup(this.board.x + this.board.w / 2, this.board.y + this.board.h / 2, `Farolillos +${fmt(spin.scatterWin)}x`, '#7cd4ff', 26);
    }

    // Wild expansivo.
    if (spin.expandedReels.length) {
      this.ctl.sfx('orb');
      const jobs = spin.expandedReels.map((i) =>
        tweens.value(0, 1, 420, (v) => (this.reels[i].wildFx = v), ease.outCubic).then(() => {
          const x = this.board.x + (i + 0.5) * this.cell;
          for (let r = 0; r < ROWS; r++) particles.burst(x, this.board.y + (r + 0.5) * this.cell, { count: 8, color: ['#ff7a1a', '#ffe45e'], speed: 240, size: 3.5, life: 650, gravity: -80 });
        }),
      );
      await Promise.all(jobs);
      this.setStatic(spin.finalGrid);
      this.stage.shake(5, 200);
      await tweens.wait(160);
      spin.expandedReels.forEach((i) => (this.reels[i].wildFx = fs ? 1 : 0));
    }
    // Rodillos pegajosos de free spins.
    this.reels.forEach((rl, i) => (rl.sticky = fs && !!spin.stickyReels?.includes(i)));

    // Líneas ganadoras.
    if (spin.lineWins.length) {
      this.ctl.sfx('win');
      const all = new Set<string>();
      spin.lineWins.forEach((l) => l.positions.forEach(([r, w]) => all.add(`${r},${w}`)));
      const cells = [...all].map((k) => k.split(',').map(Number) as [number, number]);
      this.popup(this.board.x + this.board.w / 2, this.board.y + this.board.h * 0.5, `+${fmt(spin.win - spin.scatterWin)}x`, '#fff6c2', Math.max(24, this.cell * 0.4));
      this.ctl.onWin(baseRun + spin.win);
      await tweens.value(0, 1, 700, (v) => cells.forEach(([r, w]) => (this.hl[r][w] = Math.sin(Math.PI * v) * 0.9 + 0.1)), ease.linear);
      cells.forEach(([r, w]) => (this.hl[r][w] = 0));
      if (spin.lineWins.length > 1 && !this.ctl.turbo) {
        for (const lw of spin.lineWins.slice(0, 5)) {
          const pts = lw.positions.map(([r, w]) => this.pos(r, w));
          const fx = { pts, color: LINE_COLORS[lw.line % LINE_COLORS.length], a: 0 };
          this.lineFx = fx;
          const mine = lw.positions;
          await tweens.value(
            0,
            1,
            520,
            (v) => {
              fx.a = Math.min(1, v * 4, (1 - v) * 4);
              mine.forEach(([r, w]) => (this.hl[r][w] = 0.7));
            },
            ease.linear,
          );
          mine.forEach(([r, w]) => (this.hl[r][w] = 0));
        }
        this.lineFx = null;
      } else {
        const lw = spin.lineWins[0];
        this.lineFx = { pts: lw.positions.map(([r, w]) => this.pos(r, w)), color: LINE_COLORS[lw.line % LINE_COLORS.length], a: 1 };
        await tweens.wait(450);
        this.lineFx = null;
      }
    }
    this.ctl.onWin(baseRun + spin.win);
    return baseRun + spin.win;
  }

  async play(o: EmberOutcome, ctl: SceneCtl): Promise<void> {
    this.ctl = ctl;
    const { tweens } = this.stage;
    const short = ctl.turbo ? 700 : 1700;
    this.reels.forEach((r) => ((r.sticky = false), (r.wildFx = 0)));
    let run = await this.playSpin(o.base, 0, false);
    if (o.freeSpins && o.freeSpins.spins.length) {
      const fsr = o.freeSpins;
      ctl.sfx('scatter');
      await this.dimBoard(1, 200);
      await this.showBanner('GIROS DE BRASAS', `${o.base.freeSpinsAwarded || fsr.totalAwarded} giros · los wild quedan fijos`, short);
      await this.dimBoard(0, 200);
      let total = o.base.freeSpinsAwarded || fsr.totalAwarded;
      for (let i = 0; i < fsr.spins.length; i++) {
        const sp = fsr.spins[i];
        ctl.onFreeSpins({ left: Math.max(0, total - i), total });
        run = await this.playSpin(sp, run, true);
        if (sp.freeSpinsAwarded > 0) {
          total += sp.freeSpinsAwarded;
          ctl.onFreeSpins({ left: Math.max(0, total - i - 1), total });
          await this.showBanner(`+${sp.freeSpinsAwarded} GIROS`, undefined, ctl.turbo ? 500 : 1100);
        }
        await tweens.wait(250);
      }
      ctl.onFreeSpins(null);
      this.reels.forEach((r) => ((r.sticky = false), (r.wildFx = 0)));
      await this.dimBoard(1, 200);
      await this.showBanner('TOTAL GIROS GRATIS', `${fmt(fsr.win)}x`, short);
      await this.dimBoard(0, 200);
    }
    ctl.onWin(o.totalWin);
    if (o.capped) await this.showBanner('GANANCIA MÁXIMA', undefined, short);
    await tweens.wait(200);
  }
}

const fmt = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 });
