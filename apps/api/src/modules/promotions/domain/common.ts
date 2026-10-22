import { randomInt } from 'crypto';
import { HttpError } from '../../shared/http/errors';

/** Reloj inyectable (pruebas deterministas). */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Fuente de aleatoriedad entera inyectable: devuelve un entero uniforme en [0, maxExclusive). */
export interface RandomSource {
  int(maxExclusive: number): number;
}

/** RNG criptográfico por defecto. */
export const cryptoRandom: RandomSource = {
  int: (maxExclusive: number) => randomInt(0, maxExclusive),
};

/** Las probabilidades se expresan en partes por millón (1 ppm = 0,0001 %). */
export const PPM = 1_000_000;

/** Entero uniforme en [0, maxExclusive) para bigint (rangos de dinero). */
export function randomBigint(maxExclusive: bigint, rng: RandomSource): bigint {
  if (maxExclusive <= 0n) return 0n;
  // crypto.randomInt admite rangos < 2^48; los montos de jackpot caben holgadamente.
  const LIMIT = 2n ** 47n;
  if (maxExclusive <= LIMIT) return BigInt(rng.int(Number(maxExclusive)));
  // Rango mayor: se compone en dos bloques (sesgo despreciable para el uso de "must drop by").
  const hi = BigInt(rng.int(Number(LIMIT)));
  const lo = BigInt(rng.int(Number(LIMIT)));
  return (hi * LIMIT + lo) % maxExclusive;
}

/** Error de dominio de promociones (se traduce a respuesta HTTP estándar). */
export class PromoError extends HttpError {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'PromoError';
  }
}

/** Proveedor con el que el módulo etiqueta sus movimientos de billetera. */
export const PROMO_PROVIDER = 'nymfo-promotions';
