import { describe, expect, it } from 'vitest';
import { betReturn, curveWeights, divideLargestRemainder, isRoomCode, roomCode, settle, splitPot } from '../domain/rules';
import { oddsFor, simFixture, simResult } from '../domain/sim';

describe('Leviathan: reglas puras', () => {
  it('comisión del 5 % que conserva el pozo exacto', () => {
    expect(splitPot(3_000_000n)).toEqual({ rake: 150_000n, pool: 2_850_000n, residue: 0n });
    const odd = splitPot(1_001n);
    expect(odd.rake + odd.pool + odd.residue).toBe(1_001n);
  });

  it('curvas: top 3 y lineal del 20 %', () => {
    expect(curveWeights('TOP_3_60_25_15', 10)).toEqual([60n, 25n, 15n]);
    expect(curveWeights('TOP_3_60_25_15', 2)).toEqual([60n, 25n]);
    expect(curveWeights('TOP_20_PCT_LINEAR', 247)).toHaveLength(49);
    expect(curveWeights('TOP_20_PCT_LINEAR', 3)).toEqual([1n]);
    expect(curveWeights('NONE', 10)).toEqual([]);
  });

  it('resto mayor: reparte el pool exacto y desempata hacia la mejor posición', () => {
    const shares = divideLargestRemainder(100n, [1n, 1n, 1n]);
    expect(shares).toEqual([34n, 33n, 33n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
    const big = divideLargestRemainder(2_850_001n, [60n, 25n, 15n]);
    expect(big.reduce((a, b) => a + b, 0n)).toBe(2_850_001n);
  });

  it('retorno de apuesta con redondeo half-up', () => {
    expect(betReturn(100n, 185)).toBe(185n);
    expect(betReturn(3n, 150)).toBe(5n); // 4.5 → 5
  });

  it('reparto: solo cobran los que califican; empate gana quien entró antes', () => {
    const t = (m: number) => new Date(2026, 0, 1, 0, m);
    const out = settle([
      { entryId: 'a', playerId: 'A', chips: 1500n, bets: 3, joinedAt: t(2) },
      { entryId: 'b', playerId: 'B', chips: 1500n, bets: 4, joinedAt: t(1) },
      { entryId: 'c', playerId: 'C', chips: 9000n, bets: 1, joinedAt: t(0) }, // no califica (mínimo 3 apuestas)
    ], { pot: 3_000_000n, rakePpm: 50_000, curve: 'TOP_3_60_25_15', minBets: 3, maxBets: 15 });
    expect(out.results.map((r) => [r.playerId, r.rank, r.qualified, r.prize])).toEqual([
      ['C', 1, false, 0n],
      ['B', 2, true, 2_011_765n],
      ['A', 3, true, 838_235n],
    ]);
    expect(out.results.reduce((a, r) => a + r.prize, 0n) + out.rake + out.residue + out.curveResidue).toBe(3_000_000n);
  });

  it('códigos de sala y feed simulado coherentes', () => {
    expect(isRoomCode(roomCode())).toBe(true);
    expect(isRoomCode('AB0O1')).toBe(false);
    expect(oddsFor(0.5)).toBe(189);
    for (const sport of ['football', 'basketball', 'baseball'] as const) {
      const f = simFixture(sport);
      const r = simResult(sport, f.selections);
      expect([...r.winners].filter((w) => w.startsWith('MATCH_RESULT')).length).toBe(1);
      const over = Number(f.selections.find((s) => s.market === 'TOTAL')!.line) < r.home + r.away;
      expect(r.winners.has(over ? 'TOTAL:OVER' : 'TOTAL:UNDER')).toBe(true);
    }
  });
});
