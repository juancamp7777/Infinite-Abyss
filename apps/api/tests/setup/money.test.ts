import { describe, expect, it } from 'vitest';
import { applyMultiplier, ChipConversion, formatMinor, parseMinorUnits } from '../../src/domain/money';

describe('money', () => {
  it('parseMinorUnits valida', () => {
    expect(parseMinorUnits('1500')).toBe(1500n);
    for (const bad of ['0', '-1', '1.5', '', 'abc', 15, '1e3', '9'.repeat(25)]) {
      expect(() => parseMinorUnits(bad)).toThrow();
    }
  });
  it('formatMinor', () => {
    expect(formatMinor(123456n, 'COP')).toBe('1234.56');
    expect(formatMinor(5n, 'USDT')).toBe('0.000005');
    expect(formatMinor(-150n, 'USD')).toBe('-1.50');
  });
  it('applyMultiplier redondea hacia abajo', () => {
    expect(applyMultiplier(100n, 1.5)).toBe(150n);
    expect(applyMultiplier(3n, 0.5)).toBe(1n);
    expect(applyMultiplier(10n ** 15n, 1.96)).toBe(1_960_000_000_000_000n);
  });
  it('ChipConversion', () => {
    const c = new ChipConversion(true, 100n);
    expect(c.chipsToMinor(7n)).toBe(700n);
    expect(c.minorToChips(799n)).toBe(7n);
    expect(() => new ChipConversion(true, null)).toThrow();
  });
});
