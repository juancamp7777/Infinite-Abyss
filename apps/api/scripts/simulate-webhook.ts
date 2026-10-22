/**
 * Utilidad de DESARROLLO: firma un webhook con los secretos del .env local y lo envía a la API local.
 * No es un endpoint. Uso:
 *   npm run simulate:webhook -- passimpay <providerReference> [paid|error]
 *   npm run simulate:webhook -- wompi <providerReference> <transactionId> <amountInCents> [APPROVED|DECLINED] [currency]
 * El providerReference sale de POST /api/cashier/deposits (o de la tabla Deposit).
 * Variables: API_URL (por defecto http://localhost:4000), PASSIMPAY_PLATFORM_ID/API_KEY, WOMPI_EVENTS_SECRET.
 */
import { passimpaySignature, sha256Hex } from '../src/domain/payments/signature';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production');
  const [provider, reference, ...rest] = process.argv.slice(2);
  const base = process.env.API_URL ?? 'http://localhost:4000';
  if (!provider || !reference) throw new Error('Usage: simulate-webhook <passimpay|wompi> <providerReference> ...');

  let body: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider === 'passimpay') {
    const platformId = process.env.PASSIMPAY_PLATFORM_ID;
    const apiKey = process.env.PASSIMPAY_API_KEY;
    if (!platformId || !apiKey) throw new Error('PASSIMPAY_PLATFORM_ID / PASSIMPAY_API_KEY not set');
    body = JSON.stringify({
      platform_id: Number.isNaN(Number(platformId)) ? platformId : Number(platformId),
      order_id: reference,
      txhash: `sim-${Date.now()}`,
      status: rest[0] ?? 'paid',
    });
    headers['x-signature'] = passimpaySignature(platformId, body, apiKey);
  } else if (provider === 'wompi') {
    const secret = process.env.WOMPI_EVENTS_SECRET;
    if (!secret) throw new Error('WOMPI_EVENTS_SECRET not set');
    const [txId, cents, status = 'APPROVED', currency = 'COP'] = rest;
    if (!txId || !cents) throw new Error('wompi needs <transactionId> <amountInCents>');
    const timestamp = Math.floor(Date.now() / 1000);
    const transaction = { id: txId, reference, status, amount_in_cents: Number(cents), currency };
    const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const checksum = sha256Hex(`${txId}${status}${cents}${timestamp}${secret}`);
    body = JSON.stringify({
      event: 'transaction.updated',
      data: { transaction },
      timestamp,
      signature: { properties, checksum },
      sent_at: new Date().toISOString(),
    });
    headers['x-event-checksum'] = checksum;
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const res = await fetch(`${base}/api/webhooks/${provider}`, { method: 'POST', headers, body });
  console.log(res.status, await res.text());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
