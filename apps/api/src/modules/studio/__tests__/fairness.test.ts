import { describe, expect, it } from 'vitest';
import {
  createFairRng,
  createSeedPair,
  fairFloats,
  hashServerSeed,
  verifyRound,
} from '../domain/fairness/ProvablyFair';
import { SeededRng } from '../domain/fairness/Rng';
import { simulate } from '../domain/simulator';
import { dummyBonus, dummyCoin } from '../scripts/dummyGames';
import { createHmac } from 'crypto';

describe('Provably fair', () => {
  it('es determinista para (serverSeed, clientSeed, nonce)', () => {
    const { serverSeed } = createSeedPair();
    const a = fairFloats(serverSeed, 'cliente', 7, 20);
    const b = fairFloats(serverSeed, 'cliente', 7, 20);
    expect(a).toEqual(b);
    expect(fairFloats(serverSeed, 'cliente', 8, 20)).not.toEqual(a);
    expect(fairFloats(serverSeed, 'otro', 7, 20)).not.toEqual(a);
  });

  it('sigue el estándar HMAC(serverSeed, clientSeed:nonce:round) con 4 bytes por float', () => {
    const serverSeed = 'a'.repeat(64);
    const block0 = createHmac('sha256', serverSeed).update('c:1:0').digest();
    const block1 = createHmac('sha256', serverSeed).update('c:1:1').digest();
    const f = (b: Buffer, o: number) => b[o] / 256 + b[o + 1] / 256 ** 2 + b[o + 2] / 256 ** 3 + b[o + 3] / 256 ** 4;
    const floats = fairFloats(serverSeed, 'c', 1, 9);
    expect(floats[0]).toBe(f(block0, 0));
    expect(floats[7]).toBe(f(block0, 28));
    expect(floats[8]).toBe(f(block1, 0));
  });

  it('verifyRound valida el hash y reproduce el stream', () => {
    const { serverSeed, serverSeedHash } = createSeedPair();
    expect(serverSeedHash).toBe(hashServerSeed(serverSeed));
    const rng = createFairRng(serverSeed, 'x', 3);
    const original = [rng.nextFloat(), rng.nextFloat(), rng.nextInt(52)];
    const v = verifyRound({ serverSeed, serverSeedHash, clientSeed: 'x', nonce: 3 });
    expect(v.valid).toBe(true);
    expect([v.rng.nextFloat(), v.rng.nextFloat(), v.rng.nextInt(52)]).toEqual(original);
  });

  it('detecta una server seed alterada', () => {
    const { serverSeed, serverSeedHash } = createSeedPair();
    const tampered = (serverSeed[0] === 'a' ? 'b' : 'a') + serverSeed.slice(1);
    expect(verifyRound({ serverSeed: tampered, serverSeedHash, clientSeed: 'x', nonce: 0 }).valid).toBe(false);
    expect(verifyRound({ serverSeed, serverSeedHash: 'no-hex', clientSeed: 'x', nonce: 0 }).valid).toBe(false);
  });

  it('distribución aproximadamente uniforme (chi-cuadrado en 10 buckets)', () => {
    const rng = createFairRng(createSeedPair().serverSeed, 'uniform', 0);
    const N = 50000;
    const buckets = new Array(10).fill(0);
    let outOfRange = 0;
    for (let i = 0; i < N; i++) {
      const x = rng.nextFloat();
      if (x < 0 || x >= 1) outOfRange++;
      else buckets[Math.floor(x * 10)]++;
    }
    expect(outOfRange).toBe(0);
    const exp = N / 10;
    const chi2 = buckets.reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    // gl = 9; p = 0.001 → 27.88
    expect(chi2).toBeLessThan(27.88);
  });

  it('pickWeighted respeta los pesos', () => {
    const rng = new SeededRng(42);
    const counts = [0, 0, 0];
    for (let i = 0; i < 100000; i++) counts[rng.pickWeighted([1, 0, 3])]++;
    expect(counts[1]).toBe(0);
    expect(counts[2] / counts[0]).toBeGreaterThan(2.85);
    expect(counts[2] / counts[0]).toBeLessThan(3.15);
  });
});

describe('simulate', () => {
  it('mide el RTP de un juego trivial conocido', () => {
    const r = simulate(dummyCoin, { spins: 400000, seed: 1 });
    expect(r.spins).toBe(400000);
    expect(Math.abs(r.rtp - 0.96)).toBeLessThan(0.006);
    expect(r.ci95[0]).toBeLessThan(0.96);
    expect(r.ci95[1]).toBeGreaterThan(0.96);
    expect(Math.abs(r.hitRate - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(r.stdDev - 0.96)).toBeLessThan(0.01);
    expect(r.maxMultiplier).toBe(1.92);
    expect(r.distribution.find((b) => b.label === '0')!.share).toBeCloseTo(0.5, 2);
    expect(r.distribution.find((b) => b.label === '[1,2)')!.rtpShare).toBe(1);
    // Determinista por semilla.
    expect(simulate(dummyCoin, { spins: 1000, seed: 5 }).rtp).toBe(simulate(dummyCoin, { spins: 1000, seed: 5 }).rtp);
  });

  it('reporta frecuencia de bonus y RTP de bonus buy sobre el coste', () => {
    const r = simulate(dummyBonus, { spins: 200000, seed: 2 });
    expect(Math.abs(r.bonusFrequency - 0.01)).toBeLessThan(0.002);
    const bb = simulate(dummyBonus, { spins: 1000, seed: 3, bonusBuy: true });
    expect(bb.rtp).toBe(1);
    expect(() => simulate(dummyCoin, { spins: 10, seed: 1, bonusBuy: true })).toThrow();
  });
});
