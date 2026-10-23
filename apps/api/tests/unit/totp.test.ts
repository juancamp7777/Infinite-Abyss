import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, openTotpSecret, otpauthUrl,
  sealTotpSecret, totpAt, totpStep, verifyTotp,
} from '../../src/domain/auth/totp';

// Vector oficial de RFC 6238 (SHA1): secreto ASCII "12345678901234567890"; T=59 s → 94287082 (8 dígitos) → 287082.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('base32 ida y vuelta, y el vector del RFC', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(totpAt(RFC_SECRET, totpStep(59_000))).toBe('287082');
    expect(totpAt(RFC_SECRET, totpStep(1_111_111_109_000))).toBe('081804');
  });

  it('acepta ±30 s, rechaza fuera de ventana, formatos raros y códigos ya usados', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(s, totpAt(s, step), now)).toBe(step);
    expect(verifyTotp(s, totpAt(s, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(s, totpAt(s, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(s, totpAt(s, step + 2), now)).toBeNull();
    expect(verifyTotp(s, '12345', now)).toBeNull();
    expect(verifyTotp(s, 'abcdef', now)).toBeNull();
    expect(verifyTotp(s, totpAt(s, step), now, step)).toBeNull(); // ya usado
    expect(verifyTotp(s, ` ${totpAt(s, step).slice(0, 3)} ${totpAt(s, step).slice(3)} `, now)).toBe(step);
  });

  it('secreto cifrado: se recupera solo con la llave correcta', () => {
    const s = generateTotpSecret();
    const sealed = sealTotpSecret(s, 'k'.repeat(40));
    expect(sealed).not.toContain(s);
    expect(openTotpSecret(sealed, 'k'.repeat(40))).toBe(s);
    expect(() => openTotpSecret(sealed, 'x'.repeat(40))).toThrow();
  });

  it('códigos de respaldo legibles, únicos y comparables sin importar formato', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0].toLowerCase().replace('-', ' '))).toBe(hashRecoveryCode(codes[0]));
    expect(otpauthUrl('ABC', 'ana@x.com')).toBe('otpauth://totp/Infinite%20Abyss%3Aana%40x.com?secret=ABC&issuer=Infinite%20Abyss&algorithm=SHA1&digits=6&period=30');
  });
});
