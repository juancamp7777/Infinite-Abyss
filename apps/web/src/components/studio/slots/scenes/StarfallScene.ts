/** Escena Canvas de Starfall Nymphs (6x5, pay anywhere + tumble). Anima solo el outcome del servidor. */
import { Stage, drawSprite, ease, glowText, roundRect, sprite } from '../../engine';
import type { StarfallOutcome, StarfallSpin } from '../outcomes';
import { BaseScene, type Palette, type SceneCtl, type SlotScene } from '../scene';
import { paintStarfall, STARFALL_SYMBOLS } from '../art/starfall';

const COLS = 6;
const ROWS = 5;
const GLOW: Record<string, string> = { astra: '#ffd34d', lyra: '#ff7ae0', selene: '#9ec2ff', orbis: '#34e0c4', comet: '#ff9f43', nebula: '#a78bfa', pulsar: '#22d3ee', quark: '#ff6fa8', meteor: '#a08672', portal: '#7cf3ff' };

interface Cell {
  sym: string;
  row: number;
  scale: number;
  alpha: number;
  hl: number;
}
interface Flyer {
  x: number;
  y: number;
  s: number;
  alpha: number;
  sym: string;
}

const PAL: Palette = { bgTop: '#1d0f4d', bgBottom: '#05020f', accent: '#ffd86b', glow: '#a78bfa', frame: '#6d4bd8' };

export class StarfallScene extends BaseScene implements SlotScene<StarfallOutcome> {
  private cells: Cell[][] = [];
  private flyers: Flyer[] = [];
  private multShow = 0;
  private ctl!: SceneCtl;

  constructor(stage: Stage) {
    super(stage, PAL, COLS, ROWS);
    for (let c = 0; c < COLS; c++) {
      const col: Cell[] = [];
      for (let r = 0; r < ROWS; r++) col.push({ sym: STARFALL_SYMBOLS[Math.floor(Math.random() * 9)], row: r, scale: 1, alpha: 1, hl: 0 });
      this.cells.push(col);
    }
    this.layout();
  }

  private pos(col: number, row: number): { x: number; y: number } {
    return { x: this.board.x + (col + 0.5) * this.cell, y: this.board.y + (row + 0.5) * this.cell };
  }

  protected drawBoard(ctx: CanvasRenderingContext2D, t: number): void {
    const { board, cell } = this;
    ctx.save();
    roundRect(ctx, board.x - 6, board.y - 6, board.w + 12, board.h + 12, 16);
    ctx.fillStyle = 'rgba(12,6,40,.72)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.pal.frame;
    ctx.shadowColor = this.pal.glow;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    roundRect(ctx, board.x, board.y, board.w, board.h, 10);
    ctx.clip();
    for (let c = 0; c < COLS; c++) {
      if (c % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,.035)';
        ctx.fillRect(board.x + c * cell, board.y, cell, board.h);
      }
    }
    const dpr = this.stage.dpr;
    for (let c = 0; c < COLS; c++) {
      for (const cl of this.cells[c]) {
        if (cl.alpha <= 0.01 || cl.scale <= 0.01) continue;
        const { x, y } = this.pos(c, cl.row);
        const size = cell * 0.9;
        const pulse = 1 + cl.hl * (0.14 + 0.06 * Math.sin(t / 70));
        if (cl.hl > 0) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(x, y, 0, x, y, cell * 0.62);
          const col = GLOW[cl.sym] ?? '#ff5cf0';
          g.addColorStop(0, col + 'cc');
          g.addColorStop(1, col + '00');
          ctx.fillStyle = g;
          ctx.globalAlpha = cl.hl;
          ctx.fillRect(x - cell, y - cell, cell * 2, cell * 2);
          ctx.restore();
        }
        const sp = sprite(`sf-${cl.sym}`, size, dpr, (g, s) => paintStarfall(cl.sym, g, s));
        drawSprite(ctx, sp, x, y, size, cl.scale * pulse, cl.alpha);
      }
    }
    ctx.restore();

    for (const f of this.flyers) {
      const sp = sprite(`sf-${f.sym}`, cell * 0.9, this.stage.dpr, (g, s) => paintStarfall(f.sym, g, s));
      drawSprite(ctx, sp, f.x, f.y, cell * 0.9, f.s, f.alpha);
    }
    if (this.multShow > 0) {
      glowText(ctx, `x${this.multShow}`, board.x + board.w / 2, board.y + cell * 0.45, Math.max(22, cell * 0.5), '#ff9ef2', '#ff5cf0', 900);
    }
  }

  /** Cae el tablero anterior y entra el nuevo. */
  private async dropIn(grid: string[][]): Promise<void> {
    const { tweens } = this.stage;
    const exits: Promise<void>[] = [];
    for (let c = 0; c < COLS; c++) {
      for (const cl of this.cells[c]) {
        const r0 = cl.row;
        exits.push(tweens.value(0, 1, 260, (v) => ((cl.row = r0 + v * (ROWS + 2)), (cl.alpha = 1 - v)), ease.inQuad, c * 25));
      }
    }
    await Promise.all(exits);
    const ins: Promise<void>[] = [];
    this.cells = grid.map((col, c) =>
      col.map((sym, r) => {
        const cl: Cell = { sym, row: r - ROWS - 1, scale: 1, alpha: 1, hl: 0 };
        const from = cl.row;
        ins.push(
          tweens.value(
            from,
            r,
            520,
            (v) => {
              cl.row = v;
            },
            ease.outBounce,
            c * 70 + (ROWS - r) * 30,
          ),
        );
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

  private async playSpin(spin: StarfallSpin, fs: boolean, runBase: number): Promise<number> {
    const { tweens, particles } = this.stage;
    let run = runBase;
    await this.dropIn(spin.grid);

    // Scatter que activa o reactiva free spins (o paga).
    if (spin.scatterCount >= (fs ? 3 : 4) || spin.scatterPay > 0) {
      const sc: Cell[] = [];
      this.cells.forEach((col) => col.forEach((c) => c.sym === 'portal' && sc.push(c)));
      this.ctl.sfx('scatter');
      await this.pulse(sc, 900);
    }

    for (const step of spin.steps) {
      const removed = step.removed.map(([c, r]) => this.cells[c][r]).filter(Boolean);
      let cx = 0;
      let cy = 0;
      step.removed.forEach(([c, r]) => {
        const p = this.pos(c, r);
        cx += p.x;
        cy += p.y;
      });
      const n = Math.max(1, step.removed.length);
      this.ctl.sfx('win');
      this.popup(cx / n, cy / n, `+${fmt(step.stepWin)}x`);
      await this.pulse(removed, 520);
      // Explosión.
      step.removed.forEach(([c, r]) => {
        const p = this.pos(c, r);
        const sym = this.cells[c][r]?.sym ?? 'astra';
        particles.burst(p.x, p.y, { count: 7, color: [GLOW[sym] ?? '#fff', '#ffffff'], speed: 200, size: 3.5, life: 600, shape: 'star' });
      });
      this.ctl.sfx('tumble', run);
      await Promise.all(
        removed.map((c) =>
          tweens.value(
            1,
            0,
            220,
            (v) => {
              c.scale = v;
              c.alpha = v;
            },
            ease.inQuad,
          ),
        ),
      );
      // Caída.
      const gone = new Set(step.removed.map(([c, r]) => `${c},${r}`));
      const moves: Promise<void>[] = [];
      this.cells = this.cells.map((col, c) => {
        const survivors = col.filter((_, r) => !gone.has(`${c},${r}`));
        const fresh = (step.newSymbols[c] ?? []).map((sym, i, arr): Cell => ({ sym, row: -(arr.length - i) - 0.5, scale: 1, alpha: 1, hl: 0 }));
        const all = [...fresh, ...survivors];
        all.forEach((cl, r) => {
          if (cl.row === r) return;
          const from = cl.row;
          moves.push(tweens.value(from, r, 140 + (r - from) * 55, (v) => (cl.row = v), ease.outBounce, c * 35));
        });
        return all;
      });
      this.ctl.sfx('land');
      run += step.stepWin;
      this.ctl.onWin(run);
      await Promise.all(moves);
    }

    // Orbes multiplicadores (solo FS): vuelan al total.
    if (spin.multiplierSum > 0 && spin.tumbleWin > 0) {
      const target = { x: this.board.x + this.board.w / 2, y: this.board.y + this.cell * 0.45 };
      this.multShow = 0;
      for (const m of spin.multipliers) {
        const cl = this.cells[m.col]?.[m.row];
        if (!cl) continue;
        const p = this.pos(m.col, m.row);
        const fl: Flyer = { x: p.x, y: p.y, s: 1, alpha: 1, sym: cl.sym };
        this.flyers.push(fl);
        cl.alpha = 0.25;
        this.ctl.sfx('orb');
        await tweens.tween(
          520,
          (v) => {
            fl.x = p.x + (target.x - p.x) * v;
            fl.y = p.y + (target.y - p.y) * v - Math.sin(Math.PI * v) * this.cell * 0.8;
            fl.s = 1 + Math.sin(Math.PI * v) * 0.35 - v * 0.5;
          },
          ease.inOutCubic,
        );
        this.flyers = this.flyers.filter((f) => f !== fl);
        cl.alpha = 1;
        this.multShow += m.value;
        particles.burst(target.x, target.y, { count: 14, color: ['#ff9ef2', '#ffffff'], speed: 240, size: 4, life: 700, shape: 'star' });
        this.stage.shake(4, 160);
      }
      run = runBase + spin.tumbleWin * spin.multiplierSum;
      this.ctl.onWin(run);
      this.popup(target.x, target.y + this.cell * 0.9, `${fmt(spin.tumbleWin)}x × ${spin.multiplierSum}`, '#ff9ef2', 24);
      await tweens.wait(650);
      this.multShow = 0;
    }

    if (spin.scatterPay > 0) {
      this.popup(this.board.x + this.board.w / 2, this.board.y + this.board.h / 2, `Scatter +${fmt(spin.scatterPay)}x`, '#7cf3ff', 26);
    }
    // El servidor manda: la grilla visible y el acumulado se alinean con su resultado.
    spin.finalGrid.forEach((col, c) => col.forEach((sym, r) => this.cells[c]?.[r] && (this.cells[c][r].sym = sym)));
    run = runBase + spin.totalWin;
    this.ctl.onWin(run);
    return run;
  }

  async play(o: StarfallOutcome, ctl: SceneCtl): Promise<void> {
    this.ctl = ctl;
    const { tweens } = this.stage;
    const short = ctl.turbo ? 700 : 1700;
    let run = 0;
    if (o.base.grid.length) run = await this.playSpin(o.base, false, 0);
    if (o.freeSpins && o.freeSpins.spins.length) {
      const fsr = o.freeSpins;
      ctl.sfx('scatter');
      await this.dimBoard(1, 200);
      await this.showBanner('GIROS GRATIS', `${o.base.freeSpinsAwarded || fsr.awarded} giros · orbes multiplicadores`, short);
      await this.dimBoard(0, 200);
      let total = o.base.freeSpinsAwarded || fsr.awarded;
      for (let i = 0; i < fsr.spins.length; i++) {
        const sp = fsr.spins[i];
        ctl.onFreeSpins({ left: total - i, total });
        run = await this.playSpin(sp, true, run);
        if (sp.freeSpinsAwarded > 0) {
          total += sp.freeSpinsAwarded;
          ctl.onFreeSpins({ left: total - i - 1, total });
          await this.showBanner(`+${sp.freeSpinsAwarded} GIROS`, undefined, ctl.turbo ? 500 : 1100);
        }
        await tweens.wait(250);
      }
      ctl.onFreeSpins(null);
      await this.dimBoard(1, 200);
      await this.showBanner('TOTAL GIROS GRATIS', `${fmt(fsr.totalWin)}x`, short);
      await this.dimBoard(0, 200);
    }
    ctl.onWin(o.totalWin);
    if (o.capped) await this.showBanner('GANANCIA MÁXIMA', undefined, short);
    await tweens.wait(200);
  }
}

const fmt = (n: number) => n.toLocaleString('es', { maximumFractionDigits: 2 });
