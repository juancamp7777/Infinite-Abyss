import { describe, expect, it } from 'vitest';
import { InMemoryEventBus } from '../events/EventBus';
import { signHmacSha256, verifyHmac } from '../crypto/hmac';
import { applyMultiplier, bigintReplacer, parseAmount } from '../money';
import { MockAuth } from '../adapters/MockAuth';

describe('InMemoryEventBus', () => {
  it('aísla los errores de cada handler y entrega al resto', async () => {
    const bus = new InMemoryEventBus();
    const got: string[] = [];
    bus.subscribe('login', () => {
      throw new Error('boom');
    });
    bus.subscribe('login', async (e) => {
      got.push(e.playerId);
    });
    await expect(bus.publish('login', { operatorId: 'o', playerId: 'p', at: new Date().toISOString() })).resolves.toBeUndefined();
    await bus.drain();
    expect(got).toEqual(['p']);
    expect(bus.errors).toHaveLength(1);
  });

  it('desuscribir deja de entregar', async () => {
    const bus = new InMemoryEventBus();
    let n = 0;
    const off = bus.subscribe('login', () => {
      n++;
    });
    await bus.publish('login', { operatorId: 'o', playerId: 'p', at: '' });
    off();
    await bus.publish('login', { operatorId: 'o', playerId: 'p', at: '' });
    expect(n).toBe(1);
  });
});

describe('HMAC', () => {
  it('firma y verifica; rechaza firmas alteradas', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signHmacSha256('secret', body);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyHmac('secret', body, sig)).toBe(true);
    expect(verifyHmac('secret', body, `sha256=${sig}`)).toBe(true);
    expect(verifyHmac('otro', body, sig)).toBe(false);
    expect(verifyHmac('secret', body + ' ', sig)).toBe(false);
    expect(verifyHmac('secret', body, 'zz')).toBe(false);
    expect(verifyHmac('secret', body, undefined)).toBe(false);
  });
});

describe('money', () => {
  it('parseAmount valida enteros', () => {
    expect(parseAmount('1500')).toBe(1500n);
    expect(parseAmount(7)).toBe(7n);
    expect(() => parseAmount('1.5')).toThrow();
    expect(() => parseAmount('-1')).toThrow();
    expect(() => parseAmount('1e3')).toThrow();
    expect(() => parseAmount('0')).toThrow();
    expect(parseAmount('0', { allowZero: true })).toBe(0n);
  });

  it('applyMultiplier hace floor con precisión 1e-4', () => {
    expect(applyMultiplier(100n, 1.5)).toBe(150n);
    expect(applyMultiplier(3n, 0.5)).toBe(1n);
    expect(applyMultiplier(10000n, 1.23456)).toBe(12346n);
    expect(applyMultiplier(1n, 0)).toBe(0n);
  });

  it('bigintReplacer serializa bigint', () => {
    expect(JSON.stringify({ a: 10n }, bigintReplacer)).toBe('{"a":"10"}');
  });
});

describe('MockAuth', () => {
  it('acepta tokens dev fuera de producción', async () => {
    const auth = new MockAuth({ NODE_ENV: 'test' });
    expect(await auth.verify('dev:PLAYER:op-1:p-1')).toEqual({ userId: 'p-1', role: 'PLAYER', operatorId: 'op-1', playerId: 'p-1' });
    expect(await auth.verify('dev:PLATFORM_ADMIN:*:root')).toEqual({ userId: 'root', role: 'PLATFORM_ADMIN' });
    expect(await auth.verify('dev:HACKER:op:x')).toBeNull();
    expect(await new MockAuth({ NODE_ENV: 'production' }).verify('dev:PLAYER:op-1:p-1')).toBeNull();
  });
});
