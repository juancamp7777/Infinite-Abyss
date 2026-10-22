import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { BaseRng, Rng } from './Rng';

/**
 * Provably fair estándar de la industria:
 *  - El servidor genera serverSeed (32 bytes hex) y publica antes de jugar sha256(serverSeed).
 *  - El jugador aporta clientSeed; cada ronda usa un nonce incremental.
 *  - Bytes = HMAC_SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}:${round}`), round = 0,1,2…
 *  - Cada float en [0,1) usa 4 bytes big-endian: b0/256 + b1/256² + b2/256³ + b3/256⁴.
 *    Un HMAC da 8 floats; al agotarse se incrementa round.
 *  - Al rotar la semilla se revela serverSeed y cualquiera puede verificar con verifyRound.
 */

export function generateServerSeed(): string {
  return randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed: string): string {
  return createHash('sha256').update(serverSeed).digest('hex');
}

export function createSeedPair(): { serverSeed: string; serverSeedHash: string } {
  const serverSeed = generateServerSeed();
  return { serverSeed, serverSeedHash: hashServerSeed(serverSeed) };
}

/** Client seed aleatorio por defecto (el jugador puede cambiarlo). */
export function generateClientSeed(): string {
  return randomBytes(16).toString('hex');
}

export class FairRng extends BaseRng {
  private round = 0;
  private buffer: Buffer;
  private offset = 0;

  constructor(
    private readonly serverSeed: string,
    private readonly clientSeed: string,
    private readonly nonce: number,
  ) {
    super();
    if (!serverSeed) throw new Error('serverSeed requerido');
    if (typeof clientSeed !== 'string') throw new Error('clientSeed inválido');
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('nonce debe ser entero ≥ 0');
    this.buffer = this.block(0);
  }

  /** Cantidad de floats consumidos (útil para auditar la ronda). */
  get consumed(): number {
    return this.round * 8 + this.offset / 4;
  }

  nextFloat(): number {
    if (this.offset >= this.buffer.length) {
      this.round += 1;
      this.buffer = this.block(this.round);
      this.offset = 0;
    }
    const b = this.buffer;
    const o = this.offset;
    this.offset += 4;
    return b[o] / 256 + b[o + 1] / 65536 + b[o + 2] / 16777216 + b[o + 3] / 4294967296;
  }

  private block(round: number): Buffer {
    return createHmac('sha256', this.serverSeed).update(`${this.clientSeed}:${this.nonce}:${round}`).digest();
  }
}

export function createFairRng(serverSeed: string, clientSeed: string, nonce: number): Rng {
  return new FairRng(serverSeed, clientSeed, nonce);
}

/** Primeros `count` floats de una ronda (para mostrar en la verificación pública). */
export function fairFloats(serverSeed: string, clientSeed: string, nonce: number, count: number): number[] {
  const rng = new FairRng(serverSeed, clientSeed, nonce);
  return Array.from({ length: count }, () => rng.nextFloat());
}

export interface VerifyRoundInput {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface VerifyRoundResult {
  /** true si sha256(serverSeed) coincide con el hash publicado. */
  valid: boolean;
  computedHash: string;
  /** RNG recomputado: pásalo a GameMath.play para reproducir el resultado de la ronda. */
  rng: Rng;
  /** Primeros 8 floats del stream (diagnóstico). */
  floats: number[];
}

export function verifyRound(input: VerifyRoundInput): VerifyRoundResult {
  const computedHash = hashServerSeed(input.serverSeed);
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(/^[0-9a-fA-F]{64}$/.test(input.serverSeedHash) ? input.serverSeedHash : '', 'hex');
  const valid = a.length === b.length && timingSafeEqual(a, b);
  return {
    valid,
    computedHash,
    rng: createFairRng(input.serverSeed, input.clientSeed, input.nonce),
    floats: fairFloats(input.serverSeed, input.clientSeed, input.nonce, 8),
  };
}
