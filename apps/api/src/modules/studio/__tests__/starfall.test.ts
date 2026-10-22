import { describe, expect, it } from 'vitest';
import { SeededRng } from '../domain/fairness/Rng';
import { simulate } from '../domain/simulator';
import { starfall, starfallFastRound, type StarfallOutcome, type StarfallSpin } from '../domain/games/starfall/math';
import { estimateStarfallRtp } from '../domain/games/starfall/estimate';

const LONG = process.env.RTP_LONG === '1';
const TARGET = starfall.rtpTarget;
const TOL = 0.003;

/** Simulación directa de rondas completas (mismo camino de RNG que play, sin construir outcome). */
function direct(spins: number, seed: number, bonusBuy: boolean) {
  const rng = new SeededRng(seed);
  let sum = 0;
  let sumSq = 0;
  let max = 0;
  for (let i = 0; i < spins; i++) {
    const m = starfallFastRound(rng, bonusBuy).total / 100;
    sum += m;
    sumSq += m * m;
    if (m > max) max = m;
  }
  const cost = bonusBuy ? starfall.bonusBuy!.costMultiplier : 1;
  const mean = sum / spins;
  const sd = Math.sqrt(Math.max(sumSq / spins - mean * mean, 0));
  return { rtp: mean / cost, se: sd / cost / Math.sqrt(spins), max };
}

const spinWin = (s: StarfallSpin) => s.steps.reduce((a, st) => a + st.stepWin, 0) * (s.multiplierSum > 0 ? s.multiplierSum : 1) + s.scatterPay;

describe('Starfall Nymphs (nymfo-starfall)', () => {
  // Modo CI: una simulación directa con ±0.3 % necesitaría ~200M de rondas (desv. estándar ≈ 6.7x por ronda).
  // Se usa el estimador descompuesto de estimate.ts (partes exactas + simulación de giros base, free spins y giro
  // comprado), que es insesgado salvo el recorte del tope (despreciable, medido en la corrida larga directa).
  // Con semilla fija el resultado es determinista; además se exige que el error estándar sea pequeño para que
  // la comprobación tenga sentido.
  it.skipIf(LONG)('(a)(c) RTP base y bonus buy dentro de ±0.3 % (estimador con reducción de varianza, semilla fija)', () => {
    const est = estimateStarfallRtp({ seed: 20261020, baseSpins: 4_000_000, freeSpins: 6_000_000, bonusBuySpins: 300_000 });
    expect(est.rtpSe).toBeLessThan(0.0012);
    expect(est.bonusBuySe).toBeLessThan(0.0016);
    expect(Math.abs(est.rtp - TARGET)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(est.bonusBuyRtp - TARGET)).toBeLessThanOrEqual(TOL);
    // Free spins: 1 de cada ~425 rondas, ~22 % del RTP.
    expect(est.analytics.pTrigger).toBeGreaterThan(1 / 500);
    expect(est.analytics.pTrigger).toBeLessThan(1 / 350);
  });

  // RTP_LONG=1: simulación directa de rondas completas, estricta ±0.3 % (error estándar ≈ 0.1 % base y 0.07 % bonus buy).
  it.runIf(LONG)('(b) corrida larga directa: RTP base dentro de ±0.3 %', () => {
    const r = direct(40_000_000, 777, false);
    expect(Math.abs(r.rtp - TARGET)).toBeLessThanOrEqual(TOL);
    expect(r.max).toBeLessThanOrEqual(starfall.maxWinMultiplier);
  }, 900_000);

  it.runIf(LONG)('(b)(c) corrida larga directa: bonus buy dentro de ±0.3 %', () => {
    const r = direct(2_000_000, 4242, true);
    expect(Math.abs(r.rtp - TARGET)).toBeLessThanOrEqual(TOL);
  }, 900_000);

  it('(d) el tope de 5000x se respeta y se marca en el outcome', () => {
    // El tope es raro (~1 de cada 400k compras). Con la semilla 99 la compra n.º 356 447 lo alcanza: se avanza el
    // RNG con el modo rápido (mismo consumo que play) comprobando el tope en todas, y esa ronda se juega con outcome.
    const rng = new SeededRng(99);
    let max = 0;
    for (let i = 0; i < 356_447; i++) max = Math.max(max, starfallFastRound(rng, true).total / 100);
    expect(max).toBeLessThanOrEqual(starfall.maxWinMultiplier);
    const r = starfall.play(rng, { bonusBuy: true });
    expect(r.outcome.capped).toBe(true);
    expect(r.multiplier).toBe(starfall.maxWinMultiplier);
    expect(r.outcome.totalWin).toBe(starfall.maxWinMultiplier);
    // La ronda termina al alcanzar el tope: la ganancia sin recortar supera 5000x.
    const raw = [r.outcome.base, ...(r.outcome.freeSpins?.spins ?? [])].reduce((a, s) => a + s.totalWin, 0);
    expect(raw).toBeGreaterThanOrEqual(starfall.maxWinMultiplier);
  });

  it('(e) determinismo: misma semilla, mismo outcome', () => {
    const a = new SeededRng(31337);
    const b = new SeededRng(31337);
    for (let i = 0; i < 200; i++) {
      const bb = i % 10 === 0;
      expect(JSON.stringify(starfall.play(a, { bonusBuy: bb }))).toBe(JSON.stringify(starfall.play(b, { bonusBuy: bb })));
    }
    // El modo rápido consume el RNG igual que play().
    const c = new SeededRng(5);
    const d = new SeededRng(5);
    for (let i = 0; i < 2000; i++) expect(starfallFastRound(c).total / 100).toBe(starfall.play(d).multiplier);
  });

  it('(f) consistencia del outcome: los pasos suman el multiplicador total', () => {
    const rng = new SeededRng(7);
    let withFs = 0;
    let withMult = 0;
    for (let i = 0; i < 1500; i++) {
      const r = starfall.play(rng, { bonusBuy: i % 3 === 0 });
      const o: StarfallOutcome = r.outcome;
      const spins = [o.base, ...(o.freeSpins?.spins ?? [])];
      let total = 0;
      for (const s of spins) {
        expect(s.grid).toHaveLength(6);
        s.grid.forEach((col) => expect(col).toHaveLength(5));
        const w = spinWin(s);
        expect(w).toBeCloseTo(s.totalWin, 6);
        expect(s.steps.reduce((a, st) => a + st.stepWin, 0)).toBeCloseTo(s.tumbleWin, 6);
        for (const st of s.steps) {
          expect(st.wins.reduce((a, x) => a + x.pay, 0)).toBeCloseTo(st.stepWin, 6);
          st.wins.forEach((x) => expect(x.count).toBeGreaterThanOrEqual(8));
          // Lo que entra por arriba repone exactamente lo eliminado en cada columna.
          for (let c = 0; c < 6; c++) expect(st.newSymbols[c].length).toBe(st.removed.filter(([col]) => col === c).length);
        }
        expect(s.multiplierSum).toBe(s.multipliers.reduce((a, m) => a + m.value, 0));
        if (s.multipliers.length) withMult++;
        total += w;
      }
      if (o.base.multipliers.length) throw new Error('El giro base no puede tener multiplicadores');
      if (o.freeSpins) {
        withFs++;
        expect(r.bonusTriggered).toBe(true);
        expect(o.freeSpins.played).toBe(o.freeSpins.spins.length);
        if (!o.capped) expect(o.freeSpins.played).toBe(o.freeSpins.awarded);
      }
      if (o.bonusBuy) expect(o.base.scatterCount).toBeGreaterThanOrEqual(4);
      expect(r.multiplier).toBeCloseTo(o.capped ? starfall.maxWinMultiplier : total, 6);
      expect(o.totalWin).toBe(r.multiplier);
    }
    expect(withFs).toBeGreaterThan(450);
    expect(withMult).toBeGreaterThan(0);
  });

  it('se integra con el simulador común de Studio', () => {
    const rep = simulate(starfall, { spins: 20_000, seed: 1 });
    expect(rep.spins).toBe(20_000);
    expect(rep.hitRate).toBeGreaterThan(0.25);
    expect(rep.maxMultiplier).toBeLessThanOrEqual(starfall.maxWinMultiplier);
  });
});
