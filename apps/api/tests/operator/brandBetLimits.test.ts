import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PrismaOperatorCurrency } from '../../src/infrastructure/modules';
import { prisma } from '../../src/infrastructure/database/prisma';
import { createTestOperator } from '../setup/factories';
import { buildApp } from '../auth/helpers';

const { app } = buildApp();
const brand = (slug: string) => request(app).get('/api/operator/brand').set('X-Operator-Slug', slug);

const COP_DEFAULTS = ['50000', '100000', '200000', '500000', '1000000', '5000000'];

describe('GET /api/operator/brand → operator.betLimits', () => {
  it('expone minBet, maxBet y betPresets del operador y nada más de Operator.limits', async () => {
    const op = await createTestOperator({
      defaultCurrency: 'COP',
      currencies: ['COP', 'USD'],
      limits: {
        minBet: '50000',
        maxBet: '5000000',
        betPresets: { COP: ['50000', '100000', '500000'] },
        minDeposit: '2000000',
        maxDeposit: '900000000',
        maxWithdrawal: '500000000',
        dailyLossLimit: '1',
      },
    });
    const r = await brand(op.slug);
    expect(r.status).toBe(200);
    expect(r.body.operator.defaultCurrency).toBe('COP');
    expect(r.body.operator.betLimits).toEqual({
      minBet: '50000',
      maxBet: '5000000',
      presets: { COP: ['50000', '100000', '500000'], USD: ['10', '50', '100', '200', '500', '1000'] },
    });
    const body = JSON.stringify(r.body);
    for (const k of ['minDeposit', 'maxDeposit', 'maxWithdrawal', 'dailyLossLimit', '2000000', '900000000']) expect(body).not.toContain(k);
    expect(r.body.operator.limits).toBeUndefined();
  });

  it('sin límites configurados devuelve los presets por defecto de cada moneda (COP en centavos)', async () => {
    const op = await createTestOperator({ defaultCurrency: 'COP', currencies: ['COP'] });
    const r = await brand(op.slug);
    expect(r.status).toBe(200);
    expect(r.body.operator.betLimits).toEqual({ presets: { COP: COP_DEFAULTS } });
  });

  it('USDT (6 decimales) escala los presets de USD', async () => {
    const op = await createTestOperator({ defaultCurrency: 'USDT', currencies: ['USDT'] });
    const r = await brand(op.slug);
    expect(r.body.operator.betLimits.presets.USDT).toEqual(['100000', '500000', '1000000', '2000000', '5000000', '10000000']);
  });
});

describe('PrismaOperatorCurrency (puerto de moneda de los módulos)', () => {
  it('lee defaultCurrency, monedas y límites de apuesta por id o slug; null para ids desconocidos', async () => {
    const op = await createTestOperator({ defaultCurrency: 'COP', currencies: ['USD'], limits: { minBet: '50000', maxBet: 5000000, minDeposit: '1' } });
    const port = new PrismaOperatorCurrency(prisma);
    const info = await port.getCurrencyInfo(op.id);
    expect(info).toEqual({ defaultCurrency: 'COP', currencies: ['COP', 'USD'], limits: { minBet: 50_000n, maxBet: 5_000_000n } });
    expect(await port.getCurrencyInfo(op.slug)).toEqual(info);
    expect(await port.getCurrencyInfo('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await port.getCurrencyInfo('demo|x')).toBeNull();
  });
});
