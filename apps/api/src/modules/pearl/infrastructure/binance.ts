import { createHmac } from 'node:crypto';

/** Llave de API de Binance de SOLO LECTURA (se guarda cifrada en el feed). */
export interface BinanceCreds {
  apiKey: string;
  apiSecret: string;
}

export interface CryptoDeposit {
  /** TxID en la red, o "Internal transfer …" si fue de Binance a Binance. */
  externalId: string;
  /** Monto en USDT tal como lo reporta Binance ("25.37"). */
  amount: string;
  address?: string;
  network?: string;
  occurredAt: Date;
}

interface RawDeposit {
  id?: string;
  amount: string;
  coin: string;
  network?: string;
  status: number;
  address?: string;
  txId?: string;
  insertTime: number;
}

type FetchFn = typeof fetch;

/**
 * Depósitos USDT acreditados (status 1) desde `since`, vía GET /sapi/v1/capital/deposit/hisrec.
 * Incluye las transferencias internas de Binance a Binance, que no aparecen en la red TRON.
 */
export async function fetchBinanceDeposits(creds: BinanceCreds, since: Date, fetchFn: FetchFn = fetch, now = () => Date.now()): Promise<CryptoDeposit[]> {
  const params = new URLSearchParams({ coin: 'USDT', status: '1', startTime: String(since.getTime()), timestamp: String(now()), recvWindow: '10000' });
  params.set('signature', createHmac('sha256', creds.apiSecret).update(params.toString()).digest('hex'));
  const res = await fetchFn(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${params.toString()}`, {
    headers: { 'X-MBX-APIKEY': creds.apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Binance respondió ${res.status}: ${body.slice(0, 160)}`);
  }
  const rows = (await res.json()) as RawDeposit[];
  return rows
    .filter((d) => d.coin === 'USDT' && d.status === 1 && Number(d.amount) > 0)
    .map((d) => ({
      externalId: (d.txId || d.id || `${d.insertTime}:${d.amount}`).slice(0, 120),
      amount: d.amount,
      ...(d.address ? { address: d.address } : {}),
      ...(d.network ? { network: d.network } : {}),
      occurredAt: new Date(d.insertTime),
    }));
}
