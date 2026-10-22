import { describe, expect, it } from 'vitest';
import { contrast, contrastIssues, defaultConfig, siteConfigSchema, switchTemplate, TEMPLATES } from '../domain/site';

describe('Reef: configuración del sitio', () => {
  it('todas las plantillas generan configuraciones válidas y legibles', () => {
    for (const key of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const cfg = defaultConfig(key, 'Casino Demo');
      expect(siteConfigSchema.safeParse(cfg).success).toBe(true);
      expect(contrastIssues(cfg.colors)).toEqual([]);
    }
  });

  it('rechaza HTML, scripts y URLs peligrosas en cualquier campo', () => {
    const base = defaultConfig('abyss', 'X');
    const bad = [
      { ...base, brand: { siteName: '<script>alert(1)</script>' } },
      { ...base, brand: { siteName: 'X', logoUrl: 'javascript:alert(1)' } },
      { ...base, brand: { siteName: 'X', logoUrl: 'data:image/svg+xml,<svg onload=alert(1)>' } },
      { ...base, brand: { siteName: 'X', logoUrl: '//evil.example/logo.png' } },
      { ...base, banners: [{ title: 'Hola', href: 'http://inseguro.example' }] },
      { ...base, footer: { ...base.footer, legal: 'Texto <img src=x onerror=alert(1)>' } },
      { ...base, colors: { ...base.colors, primary: 'red; background:url(x)' } },
    ];
    for (const b of bad) expect(siteConfigSchema.safeParse(b).success).toBe(false);
    expect(siteConfigSchema.safeParse({ ...base, brand: { siteName: 'X', logoUrl: '/reef/v1/assets/abc' }, banners: [{ title: 'Promo', href: '/lobby/category/slots', imageUrl: 'https://cdn.example/b.webp' }] }).success).toBe(true);
  });

  it('las secciones de la home deben estar todas, una vez cada una', () => {
    const base = defaultConfig('abyss', 'X');
    const dup = { ...base, home: { sections: [...base.home.sections.slice(0, -1), base.home.sections[0]] } };
    expect(siteConfigSchema.safeParse(dup).success).toBe(false);
    expect(siteConfigSchema.safeParse({ ...base, home: { sections: base.home.sections.slice(1) } }).success).toBe(false);
  });

  it('contraste WCAG y avisos legibles', () => {
    expect(contrast('#ffffff', '#000000')).toBe(21);
    const base = defaultConfig('abyss', 'X');
    const issues = contrastIssues({ ...base.colors, text: '#1a2333' });
    expect(issues.join()).toMatch(/Texto sobre fondo/);
  });

  it('cambiar de plantilla cambia el diseño y conserva la marca y el contenido', () => {
    const cfg = { ...defaultConfig('abyss', 'Mi Casino'), banners: [{ title: 'Bono', href: '/lobby' }] };
    const golden = switchTemplate(cfg, 'golden');
    expect(golden).toMatchObject({ template: 'golden', layout: { nav: 'topbar', cards: 'portrait' }, fonts: { display: 'montserrat' }, brand: { siteName: 'Mi Casino' }, banners: [{ title: 'Bono' }] });
    expect(golden.colors.primary).toBe(TEMPLATES.golden.defaults.colors.primary);
  });
});
