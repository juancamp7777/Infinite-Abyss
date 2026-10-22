import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Firma de API-Matic (pedidos salientes y postbacks entrantes):
 *   X-Sign = hex(HMAC-SHA256(key = hexDecode(secret), "<ts>\n<nonce>\n<MÉTODO>\n<ruta sin query>\n<hex(sha256(cuerpo))>"))
 * en minúsculas. La query no se firma; el secreto es hex (32 bytes) y se usa decodificado, nunca como texto.
 */

const HEX = /^(?:[0-9a-f]{2})+$/i;

export function apiMaticKey(secretHex: string): Buffer {
  if (!secretHex || !HEX.test(secretHex)) throw new Error('El secreto de API-Matic debe ser hexadecimal (p. ej. 64 caracteres)');
  return Buffer.from(secretHex, 'hex');
}

export const sha256Hex = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');

export function apiMaticCanonical(ts: string, nonce: string, method: string, path: string, bodyHashHex: string): string {
  return `${ts}\n${nonce}\n${method}\n${path}\n${bodyHashHex}`;
}

export function apiMaticSign(key: Buffer, ts: string, nonce: string, method: string, path: string, body: Buffer | string): string {
  return createHmac('sha256', key).update(apiMaticCanonical(ts, nonce, method, path, sha256Hex(body))).digest('hex');
}

/** Compara en tiempo constante; solo acepta la firma en hex minúscula de 64 caracteres. */
export function apiMaticVerify(key: Buffer, sign: string | undefined, ts: string, nonce: string, method: string, path: string, body: Buffer): boolean {
  if (!sign || !/^[0-9a-f]{64}$/.test(sign)) return false;
  const expected = Buffer.from(apiMaticSign(key, ts, nonce, method, path, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(sign, 'hex'));
}
