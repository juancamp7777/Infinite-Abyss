import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../shared/module';
import type { ExternalDepositPort, ExternalDepositRequest } from '../../shared/ports/ExternalDepositPort';
import { PearlService } from '../application/PearlService';
import { accountCurrency, convertMinor, rateFor } from '../domain/fx';
import { InMemoryPearlRepository } from '../infrastructure/InMemoryPearlRepository';

const OP = 'op-fx';
const CVU = '0000003100012345678901';

describe('multimoneda: reglas', () => {
  it('moneda por cuenta y conversión hacia abajo', () => {
    expect(accountCurrency({ bank: 'cvu', country: 'AR' }, 'COP')).toBe('ARS');
    expect(accountCurrency({ bank: 'binance_wallet', country: 'CO' }, 'COP')).toBe('USDT');
    expect(accountCurrency({ bank: 'nequi', country: 'CO' }, 'COP')).toBe('COP');
    expect(accountCurrency({}, 'COP')).toBe('COP');
    expect(rateFor({ usdtRate: '3950', fxRates: { ARS: '4.2' } }, 'ARS')).toBe('4.2');
    expect(rateFor({ usdtRate: '3950', fxRates: null }, 'USDT')).toBe('3950');
    expect(rateFor({ fxRates: {} }, 'MXN')).toBeNull();
    // 10.000,00 ARS × 4,2 = 42.000,00 COP
    expect(convertMinor(1_000_000n, 2, '4.2', 2)).toBe(4_200_000n);
    expect(convertMinor(1n, 2, '0.333', 2)).toBe(0n);
    expect(convertMinor(100n, 2, '0', 2)).toBeNull();
  });
});

describe('Pearl: pago en ARS en un casino en COP', () => {
  const setup = async (fxRates: Record<string, string> | undefined) => {
    const credited: ExternalDepositRequest[] = [];
    const port: ExternalDepositPort = { async credit(req) { credited.push(req); return { depositId: `dep-${req.reference}`, txId: 'tx', duplicate: false }; } };
    const now = new Date('2026-10-23T15:00:00Z');
    const pearl = new PearlService(new InMemoryPearlRepository(), { deposits: port, logger: silentLogger, defaultCurrency: 'COP', now: () => now });
    await pearl.updateSettings(OP, { mode: 'auto', autoMaxAmount: 10_000_000_00n, minAmount: 1_000_00n, utcOffsetMinutes: -180, ...(fxRates ? { fxRates } : {}) });
    await pearl.saveAccount(OP, { holderName: 'Abyss SRL', accountNumber: CVU, alias: 'abyss.mp', bank: 'cvu', country: 'AR' });
    const { feed, token } = await pearl.createFeed(OP, 'quikipay', 'Quikipay');
    // Quikipay (Argentina) informa el pago en ARS.
    await pearl.ingest(feed.id, token, { coelsa_id: 'q-1', monto: '10000.00', status: 'APROBADA', fecha: '2026-10-23 11:55:00', origen: { titular: 'Juan Perez', cuit: '20123456789', cvu: '0000003100099999999999' }, cvu: { cvu: CVU } });
    const submit = () => pearl.submit({ operatorId: OP, playerId: 'p1', extracted: { amount: '$ 10.000,00', senderName: 'Juan Perez', receiverAccount: CVU, date: '2026-10-23', time: '11:56' }, source: 'ai' });
    return { pearl, credited, submit };
  };

  it('detecta ARS por la cuenta destino, cruza en ARS y acredita el equivalente en COP', async () => {
    const { pearl, credited, submit } = await setup({ ARS: '4.2' });
    const txs = await pearl.listBankTxs(OP);
    expect(txs[0]).toMatchObject({ currency: 'ARS', amount: 1_000_000n });
    const r = await submit();
    expect(r.extracted.currency).toBe('ARS');
    expect(r.status).toBe('credited');
    expect(credited[0]).toMatchObject({ currency: 'COP', amount: 4_200_000n });
  });

  it('sin tasa ARS no acredita: queda en revisión pidiendo la tasa', async () => {
    const { credited, submit } = await setup(undefined);
    const r = await submit();
    expect(r.status).toBe('pending_review');
    expect(r.reason).toContain('tasa_cambio');
    expect(credited).toHaveLength(0);
  });
});
