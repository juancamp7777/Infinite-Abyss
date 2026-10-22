import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  jsonEscapeSlash,
  passimpaySignature,
  safeEqual,
  safeEqualHex,
  sha256Hex,
  wompiIntegritySignature,
} from '../../src/domain/payments/signature';
import { PassimpayProvider } from '../../src/infrastructure/payments/PassimpayProvider';
import { WompiProvider } from '../../src/infrastructure/payments/WompiProvider';
import { PASSIMPAY, WOMPI } from './harness';

describe('safeEqual', () => {
  it('compara en tiempo constante y no lanza con longitudes distintas', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqualHex('ABCD', 'abcd')).toBe(true);
  });
});

describe('Firma Passimpay (vectores calculados en el test)', () => {
  const body = '{"platformId":4242,"orderId":"a/b"}';
  const expected = createHmac('sha256', PASSIMPAY.apiKey).update(`${PASSIMPAY.platformId};${body};${PASSIMPAY.apiKey}`).digest('hex');

  it('HMAC-SHA256 hex con clave = apiKey sobre platformId;body;apiKey', () => {
    expect(passimpaySignature(PASSIMPAY.platformId, body, PASSIMPAY.apiKey)).toBe(expected);
  });

  it('acepta el callback firmado sobre el body crudo y sobre la variante con "/" escapado', () => {
    const provider = new PassimpayProvider(PASSIMPAY);
    const raw = '{"order_id":"a/b","status":"paid","txhash":"t"}';
    for (const signed of [raw, jsonEscapeSlash(raw)]) {
      const r = provider.verifyWebhook({
        rawBody: raw,
        headers: { 'x-signature': passimpaySignature(PASSIMPAY.platformId, signed, PASSIMPAY.apiKey) },
      });
      expect(r.valid).toBe(true);
    }
  });

  it('acepta la serialización canónica aunque el body crudo tenga espacios', () => {
    const provider = new PassimpayProvider(PASSIMPAY);
    const raw = '{ "order_id": "x1", "status": "paid" }';
    const canonical = JSON.stringify(JSON.parse(raw));
    const r = provider.verifyWebhook({
      rawBody: raw,
      headers: { 'X-Signature': passimpaySignature(PASSIMPAY.platformId, canonical, PASSIMPAY.apiKey) },
    });
    expect(r.valid).toBe(true);
  });

  it('rechaza firmas alteradas, body alterado y body no JSON', () => {
    const provider = new PassimpayProvider(PASSIMPAY);
    const raw = '{"order_id":"x1","status":"paid"}';
    const sig = passimpaySignature(PASSIMPAY.platformId, raw, PASSIMPAY.apiKey);
    expect(provider.verifyWebhook({ rawBody: raw, headers: { 'x-signature': sig.replace(/.$/, '0') === sig ? 'z' : sig.replace(/.$/, '0') } }).valid).toBe(false);
    expect(provider.verifyWebhook({ rawBody: raw.replace('x1', 'x2'), headers: { 'x-signature': sig } }).valid).toBe(false);
    expect(provider.verifyWebhook({ rawBody: 'no-json', headers: { 'x-signature': sig } }).valid).toBe(false);
  });
});

describe('Firma Wompi (vectores calculados en el test)', () => {
  it('integridad: SHA-256(reference + cents + currency + secret)', () => {
    expect(wompiIntegritySignature('ref1', '150000', 'COP', 'sec')).toBe(sha256Hex('ref1150000COPsec'));
  });

  it('checksum de eventos: valores de properties + timestamp + secret', () => {
    const provider = new WompiProvider(WOMPI);
    const timestamp = 1_530_291_411;
    const checksum = sha256Hex(`1234APPROVED4490000${timestamp}${WOMPI.eventsSecret}`);
    const body = {
      event: 'transaction.updated',
      data: { transaction: { id: '1234', status: 'APPROVED', amount_in_cents: 4490000, reference: 'r', currency: 'COP' } },
      timestamp,
      signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum },
    };
    const ok = provider.verifyWebhook({ rawBody: JSON.stringify(body), headers: {} });
    expect(ok.valid).toBe(true);
    expect(ok.dedupeKey).toBe('1234:APPROVED');
    expect(ok.event).toMatchObject({ kind: 'DEPOSIT', status: 'CONFIRMED', providerReference: 'r', amount: 4490000n });

    const tampered = { ...body, data: { transaction: { ...body.data.transaction, amount_in_cents: 1 } } };
    expect(provider.verifyWebhook({ rawBody: JSON.stringify(tampered), headers: {} }).valid).toBe(false);
    expect(provider.verifyWebhook({ rawBody: JSON.stringify(body), headers: { 'x-event-checksum': 'deadbeef' } }).valid).toBe(false);
  });

  it('sin credenciales no verifica nada', () => {
    const provider = new WompiProvider({ baseUrl: WOMPI.baseUrl });
    expect(provider.isEnabled()).toBe(false);
    expect(provider.verifyWebhook({ rawBody: '{}', headers: {} }).valid).toBe(false);
  });
});
