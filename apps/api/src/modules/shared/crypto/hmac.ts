import { createHmac, timingSafeEqual } from 'crypto';

/** HMAC-SHA256 en hex. */
export function signHmacSha256(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Verifica una firma hex en tiempo constante (acepta prefijo opcional "sha256="). */
export function verifyHmac(secret: string, payload: string | Buffer, signature: string | undefined | null): boolean {
  if (!signature || typeof signature !== 'string') return false;
  const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[0-9a-fA-F]+$/.test(sig) || sig.length % 2 !== 0) return false;
  const expected = Buffer.from(signHmacSha256(secret, payload), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}
