/** Escena Canvas de Verdant Grid (cluster 7x7, casillas marcadas y multiplicadores de posición). */
import { Stage, drawSprite, ease, glowText, roundRect, sprite } from '../../engine';
import type { VerdantOutcome, VerdantSpin } from '../outcomes';
import { BaseScene, type Palette, type SceneCtl, type SlotScene } from '../scene';
import { paintVerdant, VERDANT_GLOW } from '../art/verdant';

const N = 7;

interface Cell {
  sym: number;
  row: number;
  scale: number;
  alpha: number;
  hl: number;
}

const PAL: Palette = { bgTop: '#0b2a22', bgBottom: '#020b09', accent: '#7cf0b0', glow: '#5eead4', frame: '#2fa87a' };

export class VerdantScene extends BaseScene implements SlotScene<VerdantOutcome> {
  private tiles: Cell[][] = [];
  /** 0 = sin marca, 1 = marcada, ≥2 = multiplicador. */
  private mults: number[] = new Array(N * N).fill(0);
  private pop: number[] = new Array(N * N).fill(0);
  private ctl!: SceneCtl;

  constructor(stage: Stage) {
    super(stage, PAL, N, N);
    for (let c = 0; c < N; c++) {
      const col: Cell[] = [];
      for (let r = 0; r < N; r++) col.push({ sym: Math.floor(Math.random() * 8), row: r, scale: 1, alpha: 1, hl: 0 });
      this.tiles.push(col);
    }
    this.layout();
  }

  private pos(col: number, row: number): { x: number; y: number } {
    return { x: this.board.x + (col + 0.5) * this.cell, y: this.board.y + (row + 0.5) * this.cell };
  }

  protected drawBoard(ctx: CanvasRenderingContext2D, t: number): void {
    const { board, cell } = this;
    ctx.save();
    roundRect(ctx, board.x - 6, board.y - 6, board.w + 12, board.h + 12, 14);
    ctx.fillStyle = 'rgba(2,20,16,.78)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.pal.frame;
    ctx.shadowColor = this.pal.glow;
    ctx.shadowBlur = 14;
    ctx.stroke();
    ctx.restore();

    // Casillas: marcadas / multiplicador.
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const i = r * N + c;
        const x = board.x + c * cell;
        const y = board.y + r * cell;
        const m = this.mults[i];
        ctx.save();
        roundRect(ctx, x + 2, y + 2, cell - 4, cell - 4, cell * 0.14);
        ctx.fillStyle = (r + c) % 2 ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.02)';
        ctx.fill();
        if (m >= 1) {
          const k = 1 + this.pop[i] * 0.25;
          const level = m >= 2 ? Math.min(1, 0.45 + Math.log2(m) * 0.12) : 0.35;
          ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t / 400 + i);
          ctx.fillStyle = m >= 2 ? `rgba(255,${Math.round(200 - level * 90)},80,${0.25 + level * 0.3})` : 'rgba(94,234,212,.22)';
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.lineWidth = m >= 2 ? 2.5 : 1.8;
          ctx.strokeStyle = m >= 2 ? '#ffd86b' : '#5eead4';
          ctx.shadowColor = ctx.strokeStyle;
          ctx.shadowBlur = 8 + this.pop[i] * 14;
          ctx.stroke();
          ctx.restore();
          if (m >= 2) {
            glowText(ctx, `x${m}`, x + cell / 2, y + cell * 0.84, cell * 0.26 * k, '#fff2b0', '#ffb02e', 900);
          }
        } else {
          ctx.restore();
        }
      }
    }

    ctx.save();
    roundRect(ctx, board.x, board.y, board.w, board.h, 10);
    ctx.clip();
    const dpr = this.stage.dpr;
    for (let c = 0; c < N; c++) {
      for (const cl of this.tiles[c]) {
        if (cl.alpha <= 0.01 || cl.scale <= 0.01) continue;
        const { x, y } = this.pos(c, cl.row);
        const size = cell * 0.82;
        if (cl.hl > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(x, y, 0, x, y, cell * 0.65);
          const col = VERDANT_GLOW[cl.sym] ?? '#fff';
          g.addColorStop(0, col + 'dd');
          g.addColorStop(1, col + '00');
          ctx.fillStyle = g;
          ctx.globalAlpha = cl.hl;
          ctx.fillRect(x - cell, y - cell, cell * 2, cell * 2);
          ctx.restore();
        }
        const sp = sprite(`vg-${cl.sym}`, size, dpr, (g, s) => paintVerdant(cl.sym, g, s));
        drawSprite(ctx, sp, x, y, size, cl.scale * (1 + cl.hl * (0.1 + 0.05 * Math.sin(t / 70))), cl.alpha);
      }
    }
    ctx.restore();
  }

  private async dropIn(grid: number[]): Promise<void> {
    const { tweens } = this.stage;
    const exits: Promise<void>[] = [];
    for (let c = 0; c < N; c++) {
      for (const cl of this.tiles[c]) {
        const r0 = cl.row;
        exits.push(tweens.value(0, 1, 240, (v) => ((cl.row = r0 + v * (N + 2)), (cl.alpha = 1 - v)), ease.inQuad, c * 20));
      }
    }
    await Promise.all(exits);
    const ins: Promise<void>[] = [];
    this.tiles = Array.from({ length: N }, (_, c) =>
      Array.from({ length: N }, (_, r) => {
        const cl: Cell = { sym: grid[r * N + c], row: r - N - 1, scale: 1, alpha: 1, hl: 0 };
        const from = cl.row;
        ins.push(tweens.value(from, r, 520, (v) => (cl.row = v), ease.outBounce, c * 60 + (N - r) * 22));
        return cl;
      }),
    );
    this.ctl.sfx('land');
    await Promise.all(ins);
  }

  private async pulse(cells: Cell[], ms: number): Promise<void> {
    await this.stage.tweens.value(0, 1, ms, (v) => cells.forEach((c) => (c.hl = Math.sin(Math.PI * v) * 0.9 + 0.1)), ease.linear);
    cells.forEach((c) => (c.hl = 0));
  }

  private setMults(next: number[]): Promise<void> {
    const changed: number[] = [];
    next.forEach((v, i) => v !== this.mults[i] && changed.push(i));
    this.mults = next.slice();
    if (!changed.length) return Promise.resolve();
    this.ctl.sfx('orb');
    return this.stage.tweens.tween(
      500,
      (v) => changed.forEach((i) => (this.pop[i] = Math.sin(Math.PI * v))),
      ease.linear,
    ).then(() => changed.forEach((i) => (this.pop[i] = 0)));
  }

  private async playSpin(spin: VerdantSpin, baseRun: number): Promise<number> {
    const { tweens, particles } = this.stage;
    let run = baseRun;
    const first = spin.steps[0];
    if (first) this.mults = first.multipliers.slice();
    await this.dropIn(first ? first.grid : spin.finalGrid);

    if (spin.scatterCount >= 3 || spin.scatterWin > 0) {
      const sc = spin.scatterPositions.map((i) => this.tiles[i % N][Math.floor(i / N)]).filter(Boolean);
      this.ctl.sfx('scatter');
      await this.pulse(sc, 800);
      if (spin.scatterWin > 0) this.popup(this.board.x + this.board.w / 2, this.board.y + this.board.h / 2, `Fuentes +${fmt(spin.scatterWin)}x`, '#5eead4', 26);
    }

    for (let k = 0; k < spin.steps.length; k++) {
      const step = spin.steps[k];
      const nextGrid = spin.steps[k + 1]?.grid ?? spin.finalGrid;
      const gone = new Set<number>();
      step.clusters.forEach((cl) => cl.positions.forEach((p) => gone.add(p)));
      const cellsOf = (idx: number[]) => idx.map((i) => this.tiles[i % N]?.[Math.floor(i / N)]).filter(Boolean);
      this.ctl.sfx('win');
      for (const cl of step.clusters) {
        let cx = 0;
        let cy = 0;
        cl.positions.forEach((p) => {
          const q = this.pos(p % N, Math.floor(p / N));
          cx += q.x;
          cy += q.y;
        });
        const n = cl.positions.length;
        this.popup(cx / n, cy / n, `${cl.size}× +${fmt(cl.win)}x${cl.multiplier > 1 ? ` (x${cl.multiplier})` : ''}`, cl.multiplier > 1 ? '#ffd86b' : '#d7ffe9', 20);
      }
      await this.pulse(cellsOf([...gone]), 560);
      gone.forEach((p) => {
        const q = this.pos(p % N, Math.floor(p / N));
        const sym = this.tiles[p % N][Math.floor(p / N)]?.sym ?? 0;
        particles.burst(q.x, q.y, { count: 6, color: [VERDANT_GLOW[sym], '#ffffff'], speed: 200, size: 3.2, life: 600, shape: 'star' });
      });
      this.ctl.sfx('tumble', run);
      const removed = cellsOf([...gone]);
      const fade = Promise.all(
        removed.map((c) =>
          tweens.value(1, 0, 240, (v) => ((c.scale = v), (c.alpha = v)), ease.inQuad),
        ),
      );
      const marks = this.setMults(step.multipliersAfter);
      await Promise.all([fade, marks]);
      run += step.win;
      this.ctl.onWin(run);

      // Caída: los sobrevivientes bajan y entran los nuevos símbolos que muestra el siguiente paso.
      const moves: Promise<void>[] = [];
      this.tiles = this.tiles.map((col, c) => {
        const survivors = col.filter((_, r) => !gone.has(r * N + c));
        const miss = N - survivors.length;
        const fresh: Cell[] = [];
        for (let i = 0; i < miss; i++) fresh.push({ sym: nextGrid[i * N + c], row: -(miss - i) - 0.5, scale: 1, alpha: 1, hl: 0 });
        const all = [...fresh, ...survivors];
        all.forEach((cl, r) => {
          // El servidor manda: el símbolo visible es el del siguiente paso.
          cl.sym = nextGrid[r * N + c];
          if (cl.row === r) return;
          const from = cl.row;
          moves.push(tweens.value(from, r, 150 + (r - from) * 50, (v) => (cl.row = v), ease.outBounce, c * 30));
        });
        return all;
      });
      this.ctl.sfx('land');
      await Promise.all(moves);
    }
    run = baseRun + spin.win;
    this.ctl.onWin(run);
    return run;
  }

  async play(o: VerdantOutcome, ctl: SceneCtl): Promise<void> {
    this.ctl = ctl;
    const { tweens } = this.stage;
    const short = ctl.turbo ? 700 : 1700;
    let run = 0;
    if (o.base) run = await this.playSpin(o.base, 0);
    if (o.freeSpins && o.freeSpins.spins.length) {
      const fsr = o.freeSpins;
      ctl.sfx('scatter');
      await this.dimBoard(1, 200);
      await this.showBanner('BOSQUE ENCANTADO', `${o.base?.freeSpinsAwarded || fsr.totalAwarded} giros gratis · los multiplicadores crecen`, short);
      await this.dimBoard(0, 200);
      let total = o.base?.freeSpinsAwarded || fsr.totalAwarded;
      for (let i = 0; i < fsr.spins.length; i++) {
        const sp = fsr.spins[i];
        ctl.onFreeSpins({ left: Math.max(0, total - i), total });
        run = await this.playSpin(sp, run);
        if (sp.freeSpinsAwarded > 0) {
          total += sp.freeSpinsAwarded;
          ctl.onFreeSpins({ left: Math.max(0, total - i - 1), total });
          await this.showBanner(`+${sp.freeSpinsAwarded} GIROS`, undefined, ctl.turbo ? 500 : 1100);
        }
        await tweens.wait(250);
      }
      ctl.onFreeSpins(null);
      await this.dimBoard(1, 200);
      await this.showBanner('TOTAL GIROS GRATIS', `${fmt(fsr.win)}x`, short);
      await this.dimBoard(0, 200);
      this.mults = new Array(N * N).fill(0);
    }
    ctl.onWin(o.totalWin);
    if (o.capped) await this.showBanner('GANANCIA MÁXIMA', undefined, short);
    await tweens.wait(200);
  }
}

const fmt = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 });
