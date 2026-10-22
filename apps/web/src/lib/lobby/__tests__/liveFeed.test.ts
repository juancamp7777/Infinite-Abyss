import { describe, expect, it } from 'vitest';
import { EMPTY_LISTS, formatMultiplier, mergeBatch, prepend, profitOf, timeOf } from '../liveFeed';
import type { FeedBet, FeedKind } from '../types';

let n = 0;
const bet = (over: Partial<FeedBet> = {}): FeedBet => {
  n += 1;
  return {
    id: `s:${n}`, gameId: 'dice', gameTitle: 'Abyss Dice', provider: 's', category: 'originals', player: 'Jugador·AAAAAA',
    currency: 'USD', amount: '100', win: '0', multiplier: 0, at: '2026-10-22T12:00:00.000Z', ...over,
  };
};
const ids = (l: FeedBet[]) => l.map((b) => b.id);

describe('prepend', () => {
  it('pone lo más nuevo primero (el lote llega en orden de llegada)', () => {
    const old = [bet(), bet()];
    const batch = [bet(), bet()];
    expect(ids(prepend(old, batch))).toEqual([batch[1].id, batch[0].id, old[0].id, old[1].id]);
  });
  it('descarta duplicados conservando la versión más reciente y respeta el máximo', () => {
    const a = bet();
    const b = bet();
    const out = prepend([a, b], [{ ...a, win: '999' }], 2);
    expect(ids(out)).toEqual([a.id, b.id]);
    expect(out[0].win).toBe('999');
    expect(prepend([], Array.from({ length: 30 }, () => bet()), 20)).toHaveLength(20);
  });
  it('no muta la lista original', () => {
    const old = [bet()];
    const copy = [...old];
    prepend(old, [bet()]);
    expect(old).toEqual(copy);
  });
});

describe('mergeBatch', () => {
  it('reparte cada apuesta en las listas de sus kinds; sin kinds solo va a todas', () => {
    const high = bet({ kinds: ['all', 'high'] as FeedKind[] });
    const lucky = bet({ kinds: ['all', 'lucky'] as FeedKind[] });
    const plain = bet();
    const out = mergeBatch(EMPTY_LISTS, [high, lucky, plain]);
    expect(ids(out.all)).toEqual([plain.id, lucky.id, high.id]);
    expect(ids(out.high)).toEqual([high.id]);
    expect(ids(out.lucky)).toEqual([lucky.id]);
    expect(out.mine).toBe(EMPTY_LISTS.mine);
  });
  it('mantiene la identidad de las listas que no cambian (evita renders)', () => {
    const start = { ...EMPTY_LISTS, high: [bet()] };
    const out = mergeBatch(start, [bet({ kinds: ['all'] })]);
    expect(out.high).toBe(start.high);
  });
});

describe('formato', () => {
  it('profitOf usa bigint (sin pérdidas de precisión) y tolera basura', () => {
    expect(profitOf({ amount: '100', win: '250' })).toBe(BigInt(150));
    expect(profitOf({ amount: '100', win: '0' })).toBe(BigInt(-100));
    expect(profitOf({ amount: '9007199254740993', win: '9007199254740995' })).toBe(BigInt(2));
    expect(profitOf({ amount: 'x', win: '1' })).toBe(BigInt(0));
  });
  it('formatMultiplier', () => {
    expect(formatMultiplier(1.98)).toBe('1.98x');
    expect(formatMultiplier(0)).toBe('0.00x');
    expect(formatMultiplier(-3)).toBe('0.00x');
    expect(formatMultiplier(Number.NaN)).toBe('0.00x');
    expect(formatMultiplier(Number.POSITIVE_INFINITY)).toBe('0.00x');
    expect(formatMultiplier(12500)).toMatch(/^12[.,\s]?500x$/);
  });
  it('timeOf devuelve vacío con fechas inválidas', () => {
    expect(timeOf('no-es-fecha')).toBe('');
    expect(timeOf('2026-10-22T12:00:00.000Z')).not.toBe('');
  });
});
