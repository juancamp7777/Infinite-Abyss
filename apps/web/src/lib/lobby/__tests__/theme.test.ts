import { describe, expect, it } from 'vitest';
import { contrastRatio, DEFAULT_SKIN, hexToRgb, readableOn, skinStyle } from '../theme';

describe('tema', () => {
  it('hexToRgb acepta #rgb, #rrggbb y #rrggbbaa y rechaza lo demás', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#f4b73f')).toEqual([244, 183, 63]);
    expect(hexToRgb('#f4b73fcc')).toEqual([244, 183, 63]);
    for (const bad of ['f4b73f', '#ggg', 'red', '#12345', 'url(x)']) expect(hexToRgb(bad), bad).toBeNull();
  });

  it('contrastRatio sigue la fórmula WCAG (negro/blanco = 21)', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('readableOn elige siempre el texto de mayor contraste y llega a AA (4.5) con la paleta de la marca', () => {
    for (const bg of [DEFAULT_SKIN.colors.primary, DEFAULT_SKIN.colors.secondary, DEFAULT_SKIN.colors.accent]) {
      expect(contrastRatio(bg, readableOn(bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
    // Colores arbitrarios de un operador: nunca peor que la alternativa.
    for (const bg of ['#7c3aed', '#db2777', '#0ea5e9', '#22c55e', '#111111', '#fafafa', '#ff0000']) {
      const other = readableOn(bg) === '#ffffff' ? '#0a0f1a' : '#ffffff';
      expect(contrastRatio(bg, readableOn(bg)), bg).toBeGreaterThanOrEqual(contrastRatio(bg, other));
    }
  });

  it('skinStyle ignora colores inválidos (no inyecta CSS) y calcula el texto sobre primario', () => {
    const s = skinStyle({ ...DEFAULT_SKIN.colors, primary: 'red;background:url(evil)', text: '#ffffff' });
    expect(s['--nf-primary']).toBe(DEFAULT_SKIN.colors.primary);
    expect(s['--nf-text']).toBe('#ffffff');
    expect(s['--nf-on-primary']).toBe(readableOn(DEFAULT_SKIN.colors.primary));
    expect(Object.values(s).every((v) => /^#[0-9a-f]{3,8}$/i.test(v))).toBe(true);
  });
});
