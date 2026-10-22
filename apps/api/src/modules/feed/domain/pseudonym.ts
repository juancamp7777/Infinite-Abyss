import { createHmac } from 'crypto';

/** Sin 0/O/1/I/L para que el código se lea sin ambigüedad. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Alias estable y no reversible de un jugador: `<prefijo>·<6 caracteres>` derivado con HMAC-SHA256
 * del secreto del servidor. Mismo jugador → mismo alias; sin el secreto no se puede volver al id.
 */
export function pseudonym(secret: string, operatorId: string, playerId: string, prefix = 'Jugador'): string {
  const digest = createHmac('sha256', secret).update(`${operatorId}:${playerId}`).digest();
  let code = '';
  for (let i = 0; i < 6; i++) code += ALPHABET[digest[i] % ALPHABET.length];
  return `${prefix}·${code}`;
}
