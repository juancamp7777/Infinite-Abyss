import { describe, expect, it } from 'vitest';
import { SeededRng } from '../domain/fairness/Rng';
import { simulate } from '../domain/simulator';
import {
  VERDANT_CONFIG,
  VerdantEngine,
  createVerdantGrid,
  verdantAnalytic,
  verdantBaseClusterWin,
  verdantFreeSpinsWin,
  verdantGrid,
  type VerdantConfig,
  type VerdantSpin,
} from '../domain/games/verdant-grid/math';

const LONG = process.env.RTP_LONG === '1';
const TARGET = 0.965;
const N = 49;

/** Grilla 7x7 rellena con un patrón de tablero de ajedrez de 4 símbolos que nunca forma clusters. */
function noise(): number[] {
  const g: number[] = [];
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) g.push(4 + ((r + c) % 2) * 2 + (r % 2));
  return g;
}
const idx = (r: number, c: number) => r * 7 + c;

describe('Verdant Grid · detección de clusters', () => {
  const e = new VerdantEngine(VERDANT_CONFIG);

  it('el patrón de fondo no forma clusters', () => {
    expect(e.evaluateClusters(noise())).toEqual([]);
  });

  it('5 adyacentes en horizontal/vertical forman cluster; 4 no', () => {
    const g = noise();
    // Forma de L: (0,0) (0,1) (0,2) (1,2) (2,2)
    for (const [r, c] of [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]]) g[idx(r, c)] = 0;
    const cl = e.evaluateClusters(g);
    expect(cl).toHaveLength(1);
    expect(cl[0]).toMatchObject({ symbol: 0, size: 5, multiplier: 1 });
    expect(cl[0].positions).toEqual([idx(0, 0), idx(0, 1), idx(0, 2), idx(1, 2), idx(2, 2)]);
    expect(cl[0].win).toBe(VERDANT_CONFIG.paytable.pays[0][0]);

    const g4 = noise();
    for (const [r, c] of [[4, 0], [4, 1], [4, 2], [5, 2]]) g4[idx(r, c)] = 1;
    expect(e.evaluateClusters(g4)).toEqual([]);
  });

  it('la adyacencia diagonal NO conecta', () => {
    const g = noise();
    // Escalera diagonal de 5 celdas + parejas que solo tocan en diagonal.
    for (let k = 0; k < 5; k++) g[idx(k, k)] = 2;
    expect(e.evaluateClusters(g)).toEqual([]);
    // Dos grupos de 3 unidos solo por una esquina: no forman uno de 6.
    const g2 = noise();
    for (const [r, c] of [[1, 1], [1, 2], [1, 3], [2, 4], [3, 4], [4, 4]]) g2[idx(r, c)] = 3;
    expect(e.evaluateClusters(g2)).toEqual([]);
  });

  it('no envuelve bordes (la columna 6 no es vecina de la columna 0 de la fila siguiente)', () => {
    const g = noise();
    for (const [r, c] of [[0, 4], [0, 5], [0, 6], [1, 0], [1, 1]]) g[idx(r, c)] = 1;
    expect(e.evaluateClusters(g)).toEqual([]);
  });

  it('el scatter nunca forma cluster', () => {
    const g = noise();
    for (let c = 0; c < 6; c++) g[idx(3, c)] = VERDANT_CONFIG.scatter;
    expect(e.evaluateClusters(g)).toEqual([]);
  });

  it('paga por tamaño y suma los multiplicadores de posición del cluster', () => {
    const g = noise();
    const cells = [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [2, 3]];
    for (const [r, c] of cells) g[idx(r, c)] = 1;
    const m = new Array<number>(N).fill(0);
    m[idx(3, 1)] = 2;
    m[idx(3, 4)] = 8;
    m[idx(2, 3)] = 1; // marcada, aún sin multiplicador
    m[idx(0, 0)] = 64; // fuera del cluster: no cuenta
    const [cl] = e.evaluateClusters(g, m);
    expect(cl.size).toBe(8);
    expect(cl.basePay).toBe(VERDANT_CONFIG.paytable.pays[1][3]);
    expect(cl.multiplier).toBe(10);
    expect(cl.win).toBeCloseTo(cl.basePay * 10, 10);
  });
});

describe('Verdant Grid · cascadas y multiplicadores', () => {
  it('marca, convierte en x2 y duplica hasta x1024 las posiciones que explotan', () => {
    const e = new VerdantEngine(VERDANT_CONFIG);
    e.mult.fill(0);
    const pos = [0, 1, 2, 3, 4];
    const seq: number[] = [];
    for (let k = 0; k < 13; k++) {
      e.nMembers = pos.length;
      pos.forEach((p, i) => (e.members[i] = p));
      e.explodeAndDrop(e.tBaseRefill, new SeededRng(k));
      seq.push(e.mult[0]);
    }
    expect(seq).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 1024, 1024]);
  });

  it('es determinista dado el Rng (base y bonus buy)', () => {
    for (const bonusBuy of [false, true]) {
      const a = new SeededRng(77);
      const b = new SeededRng(77);
      for (let i = 0; i < (bonusBuy ? 20 : 300); i++) expect(verdantGrid.play(a, { bonusBuy })).toEqual(verdantGrid.play(b, { bonusBuy }));
    }
  });

  it('el outcome es consistente: clusters = paso, pasos + scatter = giro, giros = total', () => {
    const rng = new SeededRng(9090);
    const checkSpin = (s: VerdantSpin, freeSpin: boolean) => {
      let sum = s.scatterWin;
      for (const st of s.steps) {
        expect(st.grid).toHaveLength(N);
        const stepSum = st.clusters.reduce((a, c) => a + c.win, 0);
        expect(Math.abs(stepSum - st.win)).toBeLessThan(1e-9);
        for (const c of st.clusters) {
          expect(c.size).toBeGreaterThanOrEqual(VERDANT_CONFIG.minCluster);
          expect(c.positions.every((p) => st.grid[p] === c.symbol)).toBe(true);
          const m = c.positions.reduce((a, p) => a + (st.multipliers[p] >= 2 ? st.multipliers[p] : 0), 0) || 1;
          expect(c.multiplier).toBe(m);
          expect(Math.abs(c.win - c.basePay * m)).toBeLessThan(1e-9);
          for (const p of c.positions) {
            const before = st.multipliers[p];
            expect(st.multipliersAfter[p]).toBe(before === 0 ? 1 : Math.min(Math.max(2, before * 2), 1024));
          }
        }
        sum += st.win;
      }
      expect(Math.abs(sum - s.win)).toBeLessThan(1e-9);
      if (!freeSpin && s.steps.length) expect(s.steps[0].multipliers.every((m) => m === 0)).toBe(true);
    };
    let fsSeen = 0;
    for (let i = 0; i < 6000; i++) {
      const bonusBuy = i % 500 === 0;
      const { outcome, multiplier } = verdantGrid.play(rng, { bonusBuy });
      let total = 0;
      if (outcome.base) {
        checkSpin(outcome.base, false);
        total += outcome.base.win;
      } else expect(bonusBuy).toBe(true);
      if (outcome.freeSpins) {
        fsSeen++;
        let prev: number[] | null = null;
        for (const s of outcome.freeSpins.spins) {
          checkSpin(s, true);
          // Persistencia en FS: cada giro empieza con los multiplicadores con que terminó el anterior.
          if (prev && s.steps.length) expect(s.steps[0].multipliers).toEqual(prev);
          const last = s.steps[s.steps.length - 1];
          if (last) prev = last.multipliersAfter;
        }
        const fsSum = outcome.freeSpins.spins.reduce((a, s) => a + s.win, 0);
        expect(Math.abs(fsSum - outcome.freeSpins.win)).toBeLessThan(1e-9);
        total += fsSum;
      }
      if (outcome.capped) expect(total).toBeGreaterThanOrEqual(VERDANT_CONFIG.maxWinMultiplier);
      else expect(Math.abs(total - outcome.totalWin)).toBeLessThan(1e-9);
      expect(multiplier).toBe(outcome.totalWin);
    }
    expect(fsSeen).toBeGreaterThanOrEqual(12);
  });

  it('respeta el tope de ganancia (variante con tope bajo y producción)', () => {
    const cfg: VerdantConfig = { ...VERDANT_CONFIG, maxWinMultiplier: 30 };
    const game = createVerdantGrid(cfg);
    const rng = new SeededRng(5);
    let capped = 0;
    for (let i = 0; i < 400; i++) {
      const r = game.play(rng, { bonusBuy: true });
      expect(r.multiplier).toBeLessThanOrEqual(30);
      if (r.outcome.capped) {
        capped++;
        expect(r.multiplier).toBe(30);
      }
    }
    expect(capped).toBeGreaterThan(0);
    const real = simulate(verdantGrid, { spins: 2000, seed: 1, bonusBuy: true });
    expect(real.maxMultiplier).toBeLessThanOrEqual(VERDANT_CONFIG.maxWinMultiplier);
  });
});

describe('Verdant Grid · RTP', () => {
  /*
   * Reducción de varianza (honesta, sin sesgo apreciable):
   *   RTP = E[clusters del giro base] + E[pago scatter] + P(FS) · E[sesión de FS]
   * - P(FS) y E[pago scatter] son EXACTOS: los scatters solo llegan en el relleno inicial y cada celda es i.i.d.,
   *   así que su número es Binomial(49, p) (verdantAnalytic).
   * - E[clusters base] se estima con giros base sin FS y E[sesión de FS] simulando sesiones de FS directamente
   *   (estratificación por activación: en lugar de esperar ~1 de cada 240 giros a que se activen).
   * - Sesgo despreciable: la sesión aislada aplica el tope sin el premio del giro base que la activó.
   * Este juego es de volatilidad ALTA (σ por giro ≈ 17x la apuesta): el error estándar del estimador en CI ronda
   * 0.22 %, por lo que la comprobación de ±0.3 % en CI es orientativa; la corrida larga (RTP_LONG=1) baja a ≈0.1 %
   * y la calibración se hizo con >7M sesiones de FS y 6M giros base (ver resumen de la tarea).
   */
  function estimate(baseSpins: number, sessions: number, seed: number) {
    const an = verdantAnalytic();
    const rng = new SeededRng(seed);
    let b = 0;
    let b2 = 0;
    for (let i = 0; i < baseSpins; i++) {
      const w = verdantBaseClusterWin(rng);
      b += w;
      b2 += w * w;
    }
    let f = 0;
    let f2 = 0;
    for (let i = 0; i < sessions; i++) {
      const w = verdantFreeSpinsWin(rng);
      f += w;
      f2 += w * w;
    }
    const mb = b / baseSpins;
    const mf = f / sessions;
    const varB = (b2 / baseSpins - mb * mb) / baseSpins;
    const varF = (an.triggerProb ** 2 * (f2 / sessions - mf * mf)) / sessions;
    return { ...an, base: mb, efs: mf, rtp: mb + an.scatterRtp + an.triggerProb * mf, se: Math.sqrt(varB + varF) };
  }

  it('RTP (scatter exacto + base y FS por Monte Carlo) dentro de ±0.3 % del 96.5 %', () => {
    const r = LONG ? estimate(6_000_000, 6_000_000, 20261021) : estimate(800_000, 400_000, 20261021);
    // eslint-disable-next-line no-console
    console.log(
      `[verdant-grid] base=${((r.base + r.scatterRtp) * 100).toFixed(3)}% FS=${(r.triggerProb * r.efs * 100).toFixed(3)}% ` +
        `RTP=${(r.rtp * 100).toFixed(3)}% ±${(r.se * 100).toFixed(3)}% (1σ) E[FS]=${r.efs.toFixed(2)}x`,
    );
    expect(Math.abs(r.rtp - TARGET)).toBeLessThanOrEqual(0.003);
    if (LONG) expect(r.se).toBeLessThanOrEqual(0.0011);
  }, LONG ? 1_800_000 : 300_000);
});
