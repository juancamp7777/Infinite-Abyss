import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../shared/module';
import type { ExternalDepositPort, ExternalDepositRequest } from '../../shared/ports/ExternalDepositPort';
import { PearlService } from '../application/PearlService';
import { matchCryptoTx, usdtMicro, usdtToMinor } from '../domain/crypto';
import type { ExtractedReceipt } from '../domain/types';
import { fetchBinanceDeposits, type CryptoDeposit } from '../infrastructure/binance';
import { InMemoryPearlRepository } from '../infrastructure/InMemoryPearlRepository';

const OP = 'op-usdt';
const WALLET = 'T' + 'R'.repeat(33);

describe('USDT: montos y tasa', () => {
  it('lee montos USDT en formatos comunes', () => {
    expect(usdtMicro('25.37')).toBe(25_370_000n);
    expect(usdtMicro('25,5 USDT')).toBe(25_500_000n);
    expect(usdtMicro('10.500')).toBe(10_500_000n);
    expect(usdtMicro('1,000')).toBe(1_000_000_000n);
    expect(usdtMicro('1.234,56')).toBe(1_234_560_000n);
    expect(usdtMicro('abc')).toBeNull();
  });
  it('convierte a la moneda del casino redondeando hacia abajo', () => {
    expect(usdtToMinor(25_370_000n, '3950', 2)).toBe(10_021_150n); // 25,37 × 3.950 = 100.211,50 COP
    expect(usdtToMinor(1_000_000n, '3950.55', 0)).toBe(3950n);
    expect(usdtToMinor(1_000_000n, '0', 2)).toBeNull();
  });
  it('cruza por TxID, o por monto y hora más cercana', () => {
    const feed = [
      { externalId: 'Internal transfer 555111222', assetAmount: '20', occurredAt: new Date('2026-10-23T10:00:00Z') },
      { externalId: 'abc123def456', assetAmount: '20', occurredAt: new Date('2026-10-23T12:00:00Z') },
    ];
    expect(matchCryptoTx({ micro: 20_000_000n, txId: '555111222' }, feed)).toMatchObject({ kind: 'unique', by: 'txid', tx: feed[0] });
    expect(matchCryptoTx({ micro: 20_000_000n }, feed).kind).toBe('ambiguous');
    expect(matchCryptoTx({ micro: 20_000_000n, at: new Date('2026-10-23T11:50:00Z') }, feed)).toMatchObject({ kind: 'unique', by: 'amount', tx: feed[1] });
    expect(matchCryptoTx({ micro: 7_000_000n }, feed).kind).toBe('none');
  });
});

describe('Binance: consulta de depósitos', () => {
  it('firma la consulta y devuelve solo depósitos USDT acreditados', async () => {
    let url = '';
    let key = '';
    const fake = (async (u: string, init: RequestInit) => {
      url = u;
      key = (init.headers as Record<string, string>)['X-MBX-APIKEY'];
      return new Response(JSON.stringify([
        { amount: '30', coin: 'USDT', network: 'TRX', status: 1, address: WALLET, txId: 'Internal transfer 99', insertTime: 1_792_000_000_000 },
        { amount: '5', coin: 'USDT', status: 0, txId: 'pendiente', insertTime: 1_792_000_000_000 },
        { amount: '1', coin: 'BTC', status: 1, txId: 'otro', insertTime: 1_792_000_000_000 },
      ]), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchBinanceDeposits({ apiKey: 'k'.repeat(30), apiSecret: 's'.repeat(30) }, new Date(0), fake, () => 1_792_000_000_000);
    expect(out).toEqual([{ externalId: 'Internal transfer 99', amount: '30', address: WALLET, network: 'TRX', occurredAt: new Date(1_792_000_000_000) }]);
    expect(url).toContain('/sapi/v1/capital/deposit/hisrec?coin=USDT&status=1');
    expect(url).toMatch(/&signature=[0-9a-f]{64}$/);
    expect(key).toBe('k'.repeat(30));
  });
});

describe('Pearl con depósitos USDT de Binance', () => {
  const setup = async (deposits: CryptoDeposit[], rate: string | null = '4000') => {
    const credited: ExternalDepositRequest[] = [];
    const port: ExternalDepositPort = { async credit(req) { credited.push(req); return { depositId: `dep-${req.reference}`, txId: 'tx', duplicate: false }; } };
    const now = new Date('2026-10-23T15:00:00Z');
    const pearl = new PearlService(new InMemoryPearlRepository(), { deposits: port, logger: silentLogger, defaultCurrency: 'COP', now: () => now, cryptoSource: async () => deposits });
    await pearl.updateSettings(OP, { mode: 'auto', autoMaxAmount: 10_000_000_00n, minAmount: 10_000_00n, usdtRate: rate, utcOffsetMinutes: -300 });
    await pearl.saveAccount(OP, { holderName: 'Binance · USDT (TRC20)', accountNumber: WALLET, alias: WALLET, bank: 'binance_wallet' });
    await pearl.createFeed(OP, 'binance', 'Binance USDT', 'cifrado');
    const receipt = (x: Partial<ExtractedReceipt>) => pearl.submit({ operatorId: OP, playerId: 'p1', extracted: { amount: '25', senderName: '', asset: 'USDT', receiverAccount: WALLET, date: '2026-10-23', time: '09:58', ...x }, source: 'ai' });
    return { pearl, credited, receipt };
  };
  const at = new Date('2026-10-23T14:59:00Z');

  it('transferencia interna con TxID y monto iguales: se acredita sola a la tasa', async () => {
    const { pearl, credited, receipt } = await setup([{ externalId: 'Internal transfer 4455667788', amount: '25', occurredAt: at }]);
    expect(await pearl.pollCrypto()).toBe(1);
    expect(await pearl.pollCrypto()).toBe(0); // idempotente
    const r = await receipt({ txId: '4455667788' });
    expect(r.status).toBe('credited');
    expect(credited[0]).toMatchObject({ amount: 100_000_00n, currency: 'COP' }); // 25 × 4.000
  });

  it('por la red TRON (TxID público), sin TxID o sin tasa: a revisión, con el depósito ya identificado', async () => {
    const onchain = await setup([{ externalId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', amount: '25', occurredAt: at }]);
    await onchain.pearl.pollCrypto();
    expect(await onchain.receipt({ txId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })).toMatchObject({ status: 'pending_review', reason: 'usdt_por_red' });

    const noTx = await setup([{ externalId: 'Internal transfer 1', amount: '25', occurredAt: at }]);
    await noTx.pearl.pollCrypto();
    expect(await noTx.receipt({})).toMatchObject({ status: 'pending_review', reason: 'usdt_sin_txid' });

    const noRate = await setup([{ externalId: 'Internal transfer 2', amount: '25', occurredAt: at }], null);
    await noRate.pearl.pollCrypto();
    expect((await noRate.receipt({ txId: 'Internal transfer 2' })).reason).toContain('tasa_usdt');
    expect(noTx.credited.length + onchain.credited.length + noRate.credited.length).toBe(0);
  });

  it('un comprobante en pesos nunca se cruza con un depósito USDT', async () => {
    const { pearl, receipt, credited } = await setup([{ externalId: 'Internal transfer 3', amount: '25', occurredAt: at }]);
    await pearl.pollCrypto();
    const pesos = await receipt({ asset: undefined, amount: '100.000', senderName: 'Juan Perez' });
    expect(pesos.status).not.toBe('credited');
    expect(credited).toHaveLength(0);
  });
});
