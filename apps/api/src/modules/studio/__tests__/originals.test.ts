import { describe, expect, it } from 'vitest';
import { createFairRng, createSeedPair } from '../domain/fairness/ProvablyFair';
import { SeededRng } from '../domain/fairness/Rng';
import { simulate } from '../domain/simulator';
import {
  nymfoBlackjack,
  nymfoCrash,
  nymfoCrashLive,
  nymfoDice,
  nymfoMines,
  nymfoMinesInteractive,
  nymfoPlinko,
  nymfoRoulette,
  GameParamError,
} from '../domain/originals';
import type { BlackjackState } from '../domain/originals/blackjack';
import { handScore } from '../domain/originals/blackjack';
import { crashMultiplierAt, crashPointFromRng, crashTimeTo } from '../domain/originals/crash';
import { dicePayout } from '../domain/originals/dice';
import { minesMultiplier } from '../domain/originals/mines';
import { binomialProbs, plinkoTable, tableRtp } from '../domain/originals/plinko';
import { coveredNumbers } from '../domain/originals/roulette';

const SEEDS = { serverSeed: createSeedPair().serverSeed, clientSeed: 'jugador-123' };
const rngAt = (nonce: number) => createFairRng(SEEDS.serverSeed, SEEDS.clientSeed, nonce);

describe('Originals: provably fair reproducible', () => {
  const cases: Array<[string, () => unknown]> = [
    ['dice', () => nymfoDice.play(rngAt(1), { params: { target: 33.33, over: false }, rtpProfile: '98.00' })],
    ['plinko', () => nymfoPlinko.play(rngAt(2), { params: { rows: 12, risk: 'high' } })],
    ['roulette', () => nymfoRoulette.play(rngAt(3), { params: { bets: [{ type: 'straight', value: 17, amount: '10' }, { type: 'red', amount: '5' }] } })],
    ['crash', () => nymfoCrash.play(rngAt(4), { params: { autoCashout: 1.5 } })],
    ['mines', () => nymfoMines.play(rngAt(5), { params: { mines: 5, picks: [0, 6, 12] } })],
  ];
  for (const [name, run] of cases) {
    it(`${name}: recalcular desde las semillas da el mismo resultado`, () => {
      expect(run()).toEqual(run());
    });
  }

  it('cambiar el nonce cambia el resultado (dice)', () => {
    const rolls = new Set(Array.from({ length: 20 }, (_, n) => (nymfoDice.play(rngAt(n)).outcome as { roll: number }).roll));
    expect(rolls.size).toBeGreaterThan(15);
  });

  it('interactivos: verify reproduce minas, zapato y punto de crash fijados en start', () => {
    const ctx = { rtp: 0.99, now: 0 };
    const mines = nymfoMinesInteractive.start(rngAt(10), { mines: 7 }, ctx);
    expect(nymfoMinesInteractive.verify(rngAt(10), { mines: 7 }, ctx).minePositions).toEqual(mines.state.minePositions);
    expect(new Set(mines.state.minePositions).size).toBe(7);
    expect(mines.view.minePositions).toBeUndefined();

    const bj = nymfoBlackjack.start(rngAt(11), {}, ctx);
    const shoe = nymfoBlackjack.verify(rngAt(11), {}, ctx).shoe as string[];
    expect(shoe).toEqual(bj.state.shoe);
    expect(shoe).toHaveLength(312);
    expect(bj.state.hands[0].cards).toEqual([shoe[0], shoe[2]]);
    expect(bj.state.dealer).toEqual([shoe[1], shoe[3]]);

    const crash = nymfoCrashLive.start(rngAt(12), {}, ctx);
    expect(nymfoCrashLive.verify(rngAt(12), {}, ctx).crashPoint).toBe(crash.state.crashPoint);
    expect(crash.state.crashPoint).toBe((nymfoCrash.play(rngAt(12), { params: { autoCashout: 2 } }).outcome as { crashPoint: number }).crashPoint);
  });
});

describe('Dice: RTP exacto por perfil', () => {
  for (const [profile, rtp] of [['99.00', 0.99], ['97.00', 0.97]] as const) {
    it(`RTP ${profile}% para todos los objetivos válidos (±0.3 %)`, () => {
      for (let t = 1; t < 99; t += 0.37) {
        const target = Math.round(t * 100) / 100;
        for (const over of [true, false]) {
          let p;
          try {
            nymfoDice.validateParams({ target, over });
            p = dicePayout(target, over, rtp);
          } catch {
            continue;
          }
          expect(Math.abs(p.winChance * p.payout - rtp)).toBeLessThan(0.003);
        }
      }
    });
  }

  it('simulación dentro de ±0.3 % del objetivo', () => {
    const r = simulate(nymfoDice, { spins: 1_000_000, seed: 7, params: { target: 50, over: true }, rtpProfile: '97.50' });
    expect(Math.abs(r.rtp - 0.975)).toBeLessThan(0.003);
  });

  it('rechaza RTP fuera de rango y parámetros inválidos', () => {
    expect(() => nymfoDice.play(new SeededRng(1), { rtpProfile: '99.50' })).toThrow(GameParamError);
    expect(() => nymfoDice.validateParams({ target: 99.5, over: true })).toThrow(GameParamError);
    expect(() => nymfoDice.validateParams({ target: 50.123 })).toThrow(GameParamError);
  });
});

describe('Plinko: tablas propias con binomial exacta', () => {
  for (const rtp of [0.99, 0.96]) {
    it(`RTP ${rtp} en 8–16 filas y los 3 riesgos (±0.3 %)`, () => {
      for (let rows = 8; rows <= 16; rows++) {
        for (const risk of ['low', 'medium', 'high'] as const) {
          const table = plinkoTable(rows, risk, rtp);
          expect(table).toHaveLength(rows + 1);
          expect(table).toEqual([...table].reverse());
          const exact = tableRtp(table, binomialProbs(rows));
          expect(exact).toBeLessThanOrEqual(rtp + 1e-9);
          expect(rtp - exact).toBeLessThan(0.003);
        }
      }
    });
  }

  it('simulación de 16 filas riesgo bajo dentro de ±0.3 %', () => {
    const r = simulate(nymfoPlinko, { spins: 1_000_000, seed: 11, params: { rows: 16, risk: 'low' }, rtpProfile: '96.00' });
    expect(Math.abs(r.rtp - 0.96)).toBeLessThan(0.003);
  });
});

describe('Roulette europea', () => {
  it('todas las apuestas tienen RTP 36/37', () => {
    const bets = [
      { type: 'straight', value: 0 }, { type: 'split', numbers: [0, 2] }, { type: 'split', numbers: [14, 17] },
      { type: 'street', numbers: [31, 32, 33] }, { type: 'corner', numbers: [8, 9, 11, 12] }, { type: 'line', numbers: [4, 5, 6, 7, 8, 9] },
      { type: 'dozen', value: 2 }, { type: 'column', value: 3 }, { type: 'red' }, { type: 'black' }, { type: 'odd' }, { type: 'even' },
      { type: 'low' }, { type: 'high' },
    ];
    for (const b of bets) {
      const covered = coveredNumbers(b);
      const payout = nymfoRoulette.config.payouts[b.type as keyof typeof nymfoRoulette.config.payouts];
      expect((covered.length / 37) * payout).toBeCloseTo(36 / 37, 12);
    }
    expect(() => coveredNumbers({ type: 'split', numbers: [3, 4] })).toThrow(GameParamError);
    expect(() => coveredNumbers({ type: 'corner', numbers: [3, 4, 6, 7] })).toThrow(GameParamError);
  });

  it('paga solo las apuestas ganadoras y la suma de fichas define la apuesta', () => {
    const params = { bets: [{ type: 'straight', value: 7, amount: '10' }, { type: 'black', amount: '30' }] };
    expect(nymfoRoulette.expectedStake!(params)).toBe(40n);
    for (let n = 0; n < 50; n++) {
      const r = nymfoRoulette.play(rngAt(100 + n), { params });
      const { number } = r.outcome;
      const expected = ((number === 7 ? 360 : 0) + (r.outcome.color === 'black' ? 60 : 0)) / 40;
      expect(r.multiplier).toBeCloseTo(expected, 4);
    }
  });
});

describe('Crash: edge por simulación', () => {
  for (const [profile, rtp] of [['99.00', 0.99], ['96.00', 0.96]] as const) {
    it(`retiro en 2x devuelve ≈ ${rtp} y P(punto ≥ c) = RTP/c`, () => {
      const r = simulate(nymfoCrash, { spins: 1_000_000, seed: 3, params: { autoCashout: 2 }, rtpProfile: profile });
      expect(Math.abs(r.rtp - rtp)).toBeLessThan(0.005);
      const rng = new SeededRng(99);
      const n = 400_000;
      let instant = 0;
      let over10 = 0;
      for (let i = 0; i < n; i++) {
        const p = crashPointFromRng(rng, rtp);
        if (p < 1.01) instant++;
        if (p >= 10) over10++;
      }
      expect(Math.abs(over10 / n - rtp / 10)).toBeLessThan(0.003);
      expect(Math.abs(instant / n - (1 - rtp / 1.01))).toBeLessThan(0.003);
    });
  }

  it('crash en vivo: retiro según el reloj del servidor y auto-retiro', () => {
    const ctx = { rtp: 0.99, now: 1_000 };
    let nonce = 0;
    let s;
    do s = nymfoCrashLive.start(rngAt(500 + nonce++), { autoCashout: 1.5 }, ctx);
    while (s.done || s.state.crashPoint < 3);
    expect(s.view.crashPoint).toBeUndefined();
    const at2 = 1_000 + crashTimeTo(2);
    const auto = nymfoCrashLive.action(s.state, { type: 'cashout' }, { rtp: 0.99, now: at2 });
    expect(auto.done).toBe(true);
    expect(auto.multiplier).toBe(1.5);
    const manual = nymfoCrashLive.start(rngAt(500 + nonce - 1), {}, ctx);
    const out = nymfoCrashLive.action(manual.state, { type: 'cashout' }, { rtp: 0.99, now: at2 });
    expect(out.multiplier).toBe(crashMultiplierAt(at2 - 1_000));
    const late = nymfoCrashLive.action(manual.state, { type: 'cashout' }, { rtp: 0.99, now: 1_000 + crashTimeTo(manual.state.crashPoint + 1) });
    expect(late.multiplier).toBe(0);
    expect(late.state.status).toBe('crashed');
  });
});

describe('Mines', () => {
  it('multiplicador = (1 − edge) / P(supervivencia)', () => {
    expect(minesMultiplier(1, 1, 0.99)).toBe(1.0312);
    expect(minesMultiplier(3, 1, 0.99)).toBe(1.125);
    expect(minesMultiplier(24, 1, 0.99)).toBe(24.75);
    expect(minesMultiplier(3, 2, 0.99)).toBe(Math.floor((0.99 / ((22 / 25) * (21 / 24))) * 10000) / 10000);
    expect(minesMultiplier(5, 3, 0.97)).toBe(Math.floor((0.97 / ((20 / 25) * (19 / 24) * (18 / 23))) * 10000) / 10000);
  });

  it('RTP por simulación dentro de ±0.3 %', () => {
    const r = simulate(nymfoMines, { spins: 200_000, seed: 5, params: { mines: 3, picks: 2 }, rtpProfile: '97.00' });
    // Exacto: P(sobrevivir 2) · multiplicador = 0.97 (salvo el floor a 4 decimales).
    expect(Math.abs((22 / 25) * (21 / 24) * minesMultiplier(3, 2, 0.97) - 0.97)).toBeLessThan(1e-4);
    expect(Math.abs(r.rtp - 0.97)).toBeLessThan(0.006);
  });

  it('flujo interactivo: descubrir, retirar y explotar', () => {
    const ctx = { rtp: 0.99, now: 0 };
    const s = nymfoMinesInteractive.start(rngAt(20), { mines: 3 }, ctx);
    const safe = Array.from({ length: 25 }, (_, i) => i).filter((c) => !s.state.minePositions.includes(c));
    const a = nymfoMinesInteractive.action(s.state, { type: 'reveal', cell: safe[0] }, ctx);
    expect(a.done).toBe(false);
    expect(a.view.currentMultiplier).toBe(1.125);
    const b = nymfoMinesInteractive.action(a.state, { type: 'cashout' }, ctx);
    expect(b.done).toBe(true);
    expect(b.multiplier).toBe(1.125);
    expect(b.view.minePositions).toEqual(s.state.minePositions);
    const bust = nymfoMinesInteractive.action(a.state, { type: 'reveal', cell: s.state.minePositions[0] }, ctx);
    expect(bust.done).toBe(true);
    expect(bust.multiplier).toBe(0);
    expect(() => nymfoMinesInteractive.action(s.state, { type: 'cashout' }, ctx)).toThrow();
  });
});

describe('Blackjack (6 mazos, S17, BJ 3:2)', () => {
  const ctx = { rtp: 0.995, now: 0 };
  const state = (player: string[], dealer: string[], rest: string[]): BlackjackState => ({
    shoe: [player[0], dealer[0], player[1], dealer[1], ...rest],
    pos: 4,
    dealer,
    hands: [{ cards: player, bet: 1, done: false, doubled: false, splitAces: false }],
    active: 0,
    status: 'playing',
  });

  it('puntúa ases blandos', () => {
    expect(handScore(['AS', '6H'])).toEqual({ total: 17, soft: true });
    expect(handScore(['AS', '6H', 'KD'])).toEqual({ total: 17, soft: false });
  });

  it('el dealer se planta en 17 blando y gana con mayor puntaje', () => {
    const r = nymfoBlackjack.action(state(['10S', '6H'], ['AS', '6D'], ['2C']), { type: 'stand' }, ctx);
    expect(r.done).toBe(true);
    expect(r.state.dealer).toEqual(['AS', '6D']);
    expect(r.multiplier).toBe(0);
  });

  it('doblar pide una apuesta adicional y paga 4x al ganar', () => {
    const r = nymfoBlackjack.action(state(['5S', '6H'], ['10S', '7D'], ['KC']), { type: 'double' }, ctx);
    expect(r.additionalBet).toBe(1);
    expect(r.done).toBe(true);
    expect(r.multiplier).toBe(4);
  });

  it('dividir crea dos manos y liquida cada una', () => {
    const s1 = nymfoBlackjack.action(state(['8S', '8H'], ['10S', '7D'], ['3C', 'KD']), { type: 'split' }, ctx);
    expect(s1.additionalBet).toBe(1);
    expect(s1.state.hands).toHaveLength(2);
    const s2 = nymfoBlackjack.action(s1.state, { type: 'stand' }, ctx);
    const s3 = nymfoBlackjack.action(s2.state, { type: 'stand' }, ctx);
    expect(s3.done).toBe(true);
    // 8+3=11 pierde contra 17; 8+K=18 gana → 2x
    expect(s3.multiplier).toBe(2);
    expect(() => nymfoBlackjack.action(s1.state, { type: 'split' }, ctx)).toThrow();
  });

  it('blackjack natural paga 2.5x y las acciones no permitidas fallan', () => {
    let found = false;
    for (let n = 0; n < 400 && !found; n++) {
      const s = nymfoBlackjack.start(rngAt(1000 + n), {}, ctx);
      const h = s.state.hands[0];
      if (s.done && h.result === 'blackjack') {
        expect(s.multiplier).toBe(2.5);
        expect(() => nymfoBlackjack.action(s.state, { type: 'hit' }, ctx)).toThrow();
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});
