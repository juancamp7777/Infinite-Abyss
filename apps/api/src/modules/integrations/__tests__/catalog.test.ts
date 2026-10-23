import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, integrationDef, maskSecret, mergeValues, scopeAllowed } from '../domain/catalog';
import { testHttpIntegration } from '../infrastructure/testers';

const def = (key: string) => integrationDef(key)!;

describe('Integraciones: catálogo y validación', () => {
  it('cada integración tiene clave única, campos únicos y los proveedores del Hub mapean a su variable de entorno', () => {
    expect(new Set(INTEGRATIONS.map((d) => d.key)).size).toBe(INTEGRATIONS.length);
    for (const d of INTEGRATIONS) {
      expect(new Set(d.fields.map((f) => f.name)).size).toBe(d.fields.length);
      if (d.category === 'games') {
        expect(d.scope).toBe('platform');
        for (const f of d.fields) expect(f.env, `${d.key}.${f.name}`).toMatch(/^HUB_[A-Z_]+$/);
      }
    }
  });

  it('alcances: los juegos son de la plataforma, los pagos de cada casino, la IA de ambos', () => {
    expect(scopeAllowed(def('api-matic'), 'operator')).toBe(false);
    expect(scopeAllowed(def('binance-pay'), 'platform')).toBe(false);
    expect(scopeAllowed(def('anthropic'), 'platform') && scopeAllowed(def('anthropic'), 'operator')).toBe(true);
  });

  it('valida obligatorios, https, saltos de línea y campos desconocidos', () => {
    const r = mergeValues(def('pragmatic-play'), {}, { apiUrl: 'http://inseguro.example', secureLogin: 'x\ny', extra: '1' });
    expect(r.errors.join(' | ')).toMatch(/https/);
    expect(r.errors.join(' | ')).toMatch(/saltos de línea/);
    expect(r.errors.join(' | ')).toMatch(/Secret key: obligatorio/);
    expect(r.errors.join(' | ')).toMatch(/Campo desconocido: extra/);
  });

  it('un secreto vacío conserva el guardado (el navegador nunca lo tuvo); null lo borra', () => {
    const cur = { partnerId: 'P1', apiKey: 'sk-live-123456789' };
    expect(mergeValues(def('api-slots'), cur, { partnerId: 'P2', apiKey: '' }).values).toEqual({ partnerId: 'P2', apiKey: 'sk-live-123456789' });
    expect(mergeValues(def('api-slots'), cur, { apiKey: null }).errors).toEqual(['API key: obligatorio']);
    expect(mergeValues(def('api-slots'), cur, { apiUrl: '' }).values.apiUrl).toBeUndefined();
  });

  it('enmascara secretos mostrando solo el final', () => {
    expect(maskSecret('sk-ant-api03-abcdefghijkl')).toBe('••••ijkl');
    expect(maskSecret('corta')).toBe('••••');
  });
});

describe('Integraciones: pruebas de conexión', () => {
  const fake = (handler: (url: string, init?: RequestInit) => Response) => async (url: string, init?: RequestInit) => handler(url, init);

  it('Claude: llave válida, rechazada o sin saldo, sin exponer la llave', async () => {
    let seen: Headers | undefined;
    const ok = await testHttpIntegration('anthropic', { apiKey: 'sk-ant-secreta' }, fake((url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
      seen = new Headers(init?.headers);
      return new Response('{"data":[]}', { status: 200 });
    }));
    expect(ok).toEqual({ ok: true, message: 'Claude: llave válida' });
    expect(seen?.get('x-api-key')).toBe('sk-ant-secreta');
    const bad = await testHttpIntegration('anthropic', { apiKey: 'sk-ant-secreta' }, fake(() => new Response('', { status: 401 })));
    expect(bad.ok).toBe(false);
    expect(bad.message).not.toContain('sk-ant-secreta');
    expect((await testHttpIntegration('deepseek', { apiKey: 'k' }, fake(() => new Response('', { status: 429 })))).message).toMatch(/saldo/);
  });

  it('red caída o lenta: mensaje claro', async () => {
    const r = await testHttpIntegration('gemini', { apiKey: 'k' }, async () => { throw new TypeError('fetch failed'); });
    expect(r).toEqual({ ok: false, message: 'No se pudo conectar con el servicio' });
  });

  it('Telegram: valida el token, comprueba el bot y envía el mensaje de prueba al chat', async () => {
    expect((await testHttpIntegration('telegram-alerts', { botToken: 'no-es-token', chatId: '1' })).message).toMatch(/formato/);
    const token = '123456789:AAFabcdefghijklmnopqrstuvwxyz012345';
    const calls: string[] = [];
    const r = await testHttpIntegration('telegram-alerts', { botToken: token, chatId: '-100123' }, fake((url, init) => {
      calls.push(url.replace(token, '<t>'));
      if (url.endsWith('/getMe')) return new Response('{"ok":true,"result":{"username":"abyss_alertas_bot"}}', { status: 200 });
      expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: '-100123' });
      return new Response('{"ok":true}', { status: 200 });
    }));
    expect(calls).toEqual(['https://api.telegram.org/bot<t>/getMe', 'https://api.telegram.org/bot<t>/sendMessage']);
    expect(r).toEqual({ ok: true, message: 'Bot @abyss_alertas_bot conectado: se envió un mensaje de prueba al chat' });
    const noChat = await testHttpIntegration('telegram-alerts', { botToken: token, chatId: '-1' }, fake((url) => (url.endsWith('/getMe') ? new Response('{"ok":true,"result":{"username":"b"}}') : new Response('', { status: 400 }))));
    expect(noChat.message).toMatch(/agrégalo al grupo/);
  });
});
