import { describe, expect, it } from 'vitest';
import { SeededRng } from '../domain/fairness/Rng';
import { simulate } from '../domain/simulator';
import {
  EMBER_CONFIG,
  EmberEngine,
  computeEmberAnalyticBase,
  computeEmberExactBase,
  createEmberLines,
  emberFreeSpinsWin,
  emberLines,
  type EmberConfig,
  type EmberOutcome,
} from '../domain/games/ember-lines/math';

const LONG = process.env.RTP_LONG === '1';
const TARGET = 0.965;

/** Grilla grid[rodillo][fila] a partir de filas (más legible en las pruebas). */
function fromRows(rows: number[][]): number[][] {
  return [0, 1, 2, 3, 4].map((r) => rows.map((row) => row[r]));
}

describe('Ember Lines 20 · evaluación de líneas', () => {
  const e = new EmberEngine(EMBER_CONFIG);
  const W = EMBER_CONFIG.wild;
  const S = EMBER_CONFIG.scatter;
  const pay = (sym: number, n: number) => EMBER_CONFIG.paytable[sym].pays[n - 3] / EMBER_CONFIG.lines.length;

  it('paga 3 iguales en la línea central sin wilds', () => {
    const spin = e.evaluateBaseGrid(fromRows([
      [4, 5, 6, 7, 5],
      [0, 0, 0, 7, 6],
      [5, 6, 7, 4, 7],
    ]));
    expect(spin.expandedReels).toEqual([]);
    const l0 = spin.lineWins.find((w) => w.line === 0)!;
    expect(l0).toMatchObject({ symbol: 0, count: 3, positions: [[0, 1], [1, 1], [2, 1]] });
    expect(l0.win).toBeCloseTo(pay(0, 3), 10);
  });

  it('el wild que participa en un premio se expande a todo el rodillo y se reevalúa la grilla', () => {
    // Línea central: 0 W 0 → premio con wild del rodillo 2 (índice 1). Tras expandir, la línea superior 4 W 4 4 también paga.
    const spin = e.evaluateBaseGrid(fromRows([
      [4, 5, 4, 4, 7],
      [0, W, 0, 6, 5],
      [6, 7, 5, 7, 6],
    ]));
    expect(spin.expandedReels).toEqual([1]);
    expect(spin.finalGrid[1]).toEqual([W, W, W]);
    expect(spin.grid[1]).toEqual([5, W, 7]);
    const top = spin.lineWins.find((w) => w.line === 1)!;
    expect(top).toMatchObject({ symbol: 4, count: 4 });
    expect(top.win).toBeCloseTo(pay(4, 4), 10);
    const mid = spin.lineWins.find((w) => w.line === 0)!;
    expect(mid).toMatchObject({ symbol: 0, count: 3 });
    const sum = spin.lineWins.reduce((a, w) => a + w.win, 0) + spin.scatterWin;
    expect(spin.win).toBeCloseTo(sum, 10);
  });

  it('un wild que no forma parte de ningún premio no se expande', () => {
    const spin = e.evaluateBaseGrid(fromRows([
      [4, 5, 7, 4, 7],
      [0, W, 1, 6, 5],
      [6, 7, 5, 7, 6],
    ]));
    expect(spin.expandedReels).toEqual([]);
    expect(spin.lineWins).toEqual([]);
    expect(spin.win).toBe(0);
  });

  it('el scatter corta la línea, no lo sustituye el wild y paga en cualquier posición', () => {
    const spin = e.evaluateBaseGrid(fromRows([
      [S, 5, 6, 4, 7],
      [0, 0, S, 6, S],
      [6, 7, 5, 7, 6],
    ]));
    expect(spin.lineWins.find((w) => w.line === 0)).toBeUndefined();
    expect(spin.scatterCount).toBe(3);
    expect(spin.scatterPositions).toEqual([[0, 0], [2, 1], [4, 1]]);
    expect(spin.scatterWin).toBe(EMBER_CONFIG.scatterPays[3]);
    expect(spin.freeSpinsAwarded).toBe(EMBER_CONFIG.freeSpins.award);
  });

  it('las tiras nunca muestran wild y scatter en el mismo rodillo (la expansión no tapa scatters)', () => {
    for (const strips of [EMBER_CONFIG.strips.base, EMBER_CONFIG.strips.freeSpins]) {
      for (const strip of strips) {
        for (let s = 0; s < strip.length; s++) {
          const win = [0, 1, 2].map((k) => strip[(s + k) % strip.length]);
          expect(win.includes(W) && win.includes(S)).toBe(false);
          expect(win.filter((x) => x === S).length).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(EMBER_CONFIG.strips.base[0]).not.toContain(W);
    expect(EMBER_CONFIG.strips.base[4]).not.toContain(W);
  });
});

describe('Ember Lines 20 · rondas', () => {
  it('es determinista dado el Rng', () => {
    const a = new SeededRng(99);
    const b = new SeededRng(99);
    for (let i = 0; i < 300; i++) expect(emberLines.play(a)).toEqual(emberLines.play(b));
  });

  it('el outcome es consistente: premios por línea + scatter = giro, giros = total', () => {
    const rng = new SeededRng(4242);
    let withFs = 0;
    for (let i = 0; i < 20000; i++) {
      const { multiplier, outcome, bonusTriggered } = emberLines.play(rng);
      const check = (s: EmberOutcome['base']) => {
        const sum = s.lineWins.reduce((a, w) => a + w.win, 0) + s.scatterWin;
        expect(Math.abs(sum - s.win)).toBeLessThan(1e-9);
        for (const r of s.stickyReels ?? s.expandedReels) expect(s.finalGrid[r].every((c) => c === EMBER_CONFIG.wild)).toBe(true);
      };
      check(outcome.base);
      let total = outcome.base.win;
      if (outcome.freeSpins) {
        withFs++;
        expect(bonusTriggered).toBe(true);
        let fsSum = 0;
        let prevSticky: number[] = [];
        for (const s of outcome.freeSpins.spins) {
          check(s);
          // Los rodillos pegajosos solo crecen durante el bonus.
          expect(prevSticky.every((r) => s.stickyReels!.includes(r))).toBe(true);
          prevSticky = s.stickyReels!;
          fsSum += s.win;
        }
        const awarded = EMBER_CONFIG.freeSpins.award + outcome.freeSpins.spins.reduce((a, s) => a + s.freeSpinsAwarded, 0);
        expect(awarded).toBe(outcome.freeSpins.totalAwarded);
        if (!outcome.capped) expect(outcome.freeSpins.spins.length).toBe(awarded);
        expect(Math.abs(fsSum - outcome.freeSpins.win)).toBeLessThan(1e-9);
        total += fsSum;
      }
      if (outcome.capped) expect(total).toBeGreaterThanOrEqual(EMBER_CONFIG.maxWinMultiplier);
      else expect(Math.abs(total - outcome.totalWin)).toBeLessThan(1e-9);
      expect(multiplier).toBe(outcome.totalWin);
      expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
    }
    expect(withFs).toBeGreaterThan(50);
  });

  it('respeta el tope de ganancia (variante con tope bajo)', () => {
    const cfg: EmberConfig = { ...EMBER_CONFIG, maxWinMultiplier: 20 };
    const game = createEmberLines(cfg);
    const rng = new SeededRng(7);
    let capped = 0;
    for (let i = 0; i < 20000; i++) {
      const r = game.play(rng);
      expect(r.multiplier).toBeLessThanOrEqual(20);
      if (r.outcome.capped) {
        capped++;
        expect(r.multiplier).toBe(20);
      }
    }
    expect(capped).toBeGreaterThan(0);
    const real = simulate(emberLines, { spins: 50000, seed: 3 });
    expect(real.maxMultiplier).toBeLessThanOrEqual(EMBER_CONFIG.maxWinMultiplier);
  });
});

describe('Ember Lines 20 · RTP', () => {
  /*
   * Reducción de varianza (honesta, sin sesgo):
   *   RTP = E[base] + P(FS) · E[premio de la sesión de FS]
   * - E[base] (líneas con expansiones + scatter) y P(FS) se calculan de forma EXACTA (computeEmberAnalyticBase:
   *   enumeración de los rodillos 1–4 y esperanza del 5; scatters por convolución). No tienen error de muestreo.
   * - Solo E[FS] se estima por Monte Carlo simulando sesiones de giros gratis directamente (en vez de esperar
   *   ~1 de cada 117 giros a que se activen), lo que reduce el error estándar del RTP ~10 veces a igual tiempo.
   * - Sesgo despreciable: la sesión aislada aplica el tope sin sumar el premio del giro base que la activó
   *   (P(FS) · P(llegar a 2000x) · premio base ≈ 1e-7).
   */
  function estimate(sessions: number, seed: number) {
    const an = computeEmberAnalyticBase();
    const rng = new SeededRng(seed);
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < sessions; i++) {
      const w = emberFreeSpinsWin(rng);
      s += w;
      s2 += w * w;
    }
    const mean = s / sessions;
    const sd = Math.sqrt(s2 / sessions - mean * mean);
    return { ...an, efs: mean, rtp: an.baseRtp + an.triggerProb * mean, se: (an.triggerProb * sd) / Math.sqrt(sessions) };
  }

  it('RTP (base exacto + FS por Monte Carlo) dentro de ±0.3 % del 96.5 %', () => {
    const r = estimate(LONG ? 6_000_000 : 1_000_000, 20261021);
    // eslint-disable-next-line no-console
    console.log(`[ember-lines] base=${(r.baseRtp * 100).toFixed(3)}% FS=${(r.triggerProb * r.efs * 100).toFixed(3)}% RTP=${(r.rtp * 100).toFixed(3)}% ±${(r.se * 100).toFixed(3)}% (1σ)`);
    expect(r.se).toBeLessThan(0.001);
    expect(Math.abs(r.rtp - TARGET)).toBeLessThanOrEqual(LONG ? 0.0015 : 0.003);
  }, LONG ? 1_800_000 : 300_000);

  it('la simulación directa de play() concuerda con la descomposición', () => {
    // Error estándar de play() por giro ≈ 6.5x apuesta: con 300k giros, σ ≈ 1.2 %; tolerancia 4σ.
    const spins = LONG ? 10_000_000 : 300_000;
    const rep = simulate(emberLines, { spins, seed: 11 });
    const tol = 4 * rep.stdDev / Math.sqrt(spins);
    expect(Math.abs(rep.rtp - TARGET)).toBeLessThanOrEqual(tol + 0.001);
    expect(rep.bonusFrequency).toBeGreaterThan(0.007);
    expect(rep.bonusFrequency).toBeLessThan(0.01);
  }, LONG ? 1_800_000 : 300_000);

  it.runIf(LONG)('el cálculo analítico del juego base coincide con la enumeración completa de las tiras', () => {
    const an = computeEmberAnalyticBase();
    const ex = computeEmberExactBase();
    expect(ex.lineRtp).toBeCloseTo(an.lineRtp, 12);
    expect(ex.scatterRtp).toBeCloseTo(an.scatterRtp, 12);
    expect(ex.triggerProb).toBeCloseTo(an.triggerProb, 12);
  }, 1_800_000);
});
