import { describe, expect, it } from 'vitest';
import { InMemoryOperators } from '../adapters/InMemoryOperators';
import { defaultBetPresets, publicBetLimits } from '../betLimits';
import { DEV_FALLBACK_CURRENCY, resolveOperatorCurrency } from '../ports/OperatorCurrencyPort';

const dec = (c: string) => ({ COP: 2, USD: 2, EUR: 2, USDT: 6, BTC: 8, JPY: 0 } as Record<string, number>)[c] ?? null;

describe('betLimits públicos', () => {
  it('defaults por moneda en unidades mínimas', () => {
    expect(defaultBetPresets('COP', 2)).toEqual(['50000', '100000', '200000', '500000', '1000000', '5000000']);
    expect(defaultBetPresets('USD', 2)).toEqual(['10', '50', '100', '200', '500', '1000']);
    expect(defaultBetPresets('USDT', 6)).toEqual(['100000', '500000', '1000000', '2000000', '5000000', '10000000']);
    expect(defaultBetPresets('JPY', 0)).toEqual(['1', '2', '5', '10']);
  });

  it('usa minBet/maxBet/betPresets del operador, ignora inválidos y nunca copia depósitos ni retiros', () => {
    const out = publicBetLimits(
      { minBet: '50000', maxBet: 5000000, minDeposit: '1000', maxWithdrawal: '9', betPresets: { COP: ['100000', 'x', '-1', '0', '200000'], USD: [] } },
      ['COP', 'USD'],
      dec,
    );
    expect(out).toEqual({ minBet: '50000', maxBet: '5000000', presets: { COP: ['100000', '200000'], USD: ['10', '50', '100', '200', '500', '1000'] } });
    expect(Object.keys(out).sort()).toEqual(['maxBet', 'minBet', 'presets']);
  });

  it('sin límites configurados solo devuelve presets', () => {
    expect(publicBetLimits(null, ['COP'], dec)).toEqual({ presets: { COP: ['50000', '100000', '200000', '500000', '1000000', '5000000'] } });
  });
});

describe('OperatorCurrencyPort', () => {
  it('resuelve la defaultCurrency del operador y cae al respaldo si no existe o el puerto falla', async () => {
    const ops = new InMemoryOperators().set('op', { defaultCurrency: 'COP', currencies: ['USD'] });
    expect((await ops.getCurrencyInfo('op'))?.currencies).toEqual(['COP', 'USD']);
    expect(await resolveOperatorCurrency(ops, 'op')).toBe('COP');
    expect(await resolveOperatorCurrency(ops, 'otro', 'EUR')).toBe('EUR');
    const broken = { getCurrencyInfo: async () => { throw new Error('bd caída'); } };
    expect(await resolveOperatorCurrency(broken, 'op')).toBe(DEV_FALLBACK_CURRENCY);
  });
});
