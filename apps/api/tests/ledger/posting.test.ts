import { describe, expect, it } from 'vitest';
import { assertBalancedPosting, postings, reverseEntries } from '../../src/domain/ledger';

describe('LedgerPosting (dominio puro)', () => {
  it('todas las plantillas suman 0 y tienen montos distintos de 0', () => {
    const all = [
      postings.deposit(500n),
      postings.bet(100n),
      postings.win(250n),
      postings.withdrawalReserve(70n),
      postings.withdrawalRelease(70n),
      postings.withdrawalPayout(70n),
      postings.manualAdjustment(-30n),
      postings.manualAdjustment(30n),
      postings.demoCredit(1000n),
    ];
    for (const p of all) {
      expect(() => assertBalancedPosting(p)).not.toThrow();
      expect(p.reduce((s, l) => s + l.amount, 0n)).toBe(0n);
    }
  });

  it('rechaza asientos descuadrados, de una línea o con montos 0', () => {
    expect(() => assertBalancedPosting([{ account: { type: 'HOUSE' }, amount: 1n }, { account: { type: 'PLAYER_CASH' }, amount: -2n }])).toThrow();
    expect(() => assertBalancedPosting([{ account: { type: 'HOUSE' }, amount: 0n }])).toThrow();
    expect(() => assertBalancedPosting([{ account: { type: 'HOUSE' }, amount: 0n }, { account: { type: 'PLAYER_CASH' }, amount: 0n }])).toThrow();
  });

  it('rechaza montos no positivos en plantillas', () => {
    expect(() => postings.bet(0n)).toThrow();
    expect(() => postings.deposit(-5n)).toThrow();
    expect(() => postings.manualAdjustment(0n)).toThrow();
  });

  it('reverseEntries invierte cada línea', () => {
    const r = reverseEntries([{ accountId: 'a', amount: -5n }, { accountId: 'b', amount: 5n }]);
    expect(r).toEqual([{ accountId: 'a', amount: 5n }, { accountId: 'b', amount: -5n }]);
  });
});
