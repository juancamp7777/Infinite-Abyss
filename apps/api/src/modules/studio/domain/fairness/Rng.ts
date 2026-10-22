/** Fuente de aleatoriedad que consumen las matemáticas de los juegos (GameMath.play). */
export interface Rng {
  /** Float uniforme en [0, 1). */
  nextFloat(): number;
  /** Entero uniforme en [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Índice elegido con probabilidad proporcional a su peso (pesos ≥ 0, suma > 0). */
  pickWeighted(weights: number[] | Uint32Array): number;
}

/** Implementación común de nextInt/pickWeighted sobre nextFloat. */
export abstract class BaseRng implements Rng {
  abstract nextFloat(): number;

  nextInt(maxExclusive: number): number {
    if (!(maxExclusive >= 1)) throw new RangeError('maxExclusive debe ser ≥ 1');
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  pickWeighted(weights: number[] | Uint32Array): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    if (!(total > 0)) throw new RangeError('La suma de pesos debe ser > 0');
    let r = this.nextFloat() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    // Redondeo flotante: devolver el último índice con peso > 0.
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
    return weights.length - 1;
  }
}

/**
 * PRNG sfc32 sembrado (rápido, NO criptográfico): solo para simulaciones de RTP y pruebas.
 * Las rondas reales usan createFairRng (ProvablyFair.ts).
 */
export class SeededRng extends BaseRng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number = Date.now()) {
    super();
    // splitmix32 para expandir la semilla a 128 bits.
    let s = seed >>> 0;
    const next = () => {
      s = (s + 0x9e3779b9) | 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }
}
