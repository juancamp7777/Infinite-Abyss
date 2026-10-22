import { afterEach, describe, expect, it } from 'vitest';
import { devToken } from '../../shared/adapters/MockAuth';
import { InMemoryOperators } from '../../shared/adapters/InMemoryOperators';
import { resolveHubUrls } from '../index';
import { api, OP, PLAYER, startHub, type HubHarness } from './helpers';

// URLs de launch: relativas sin WEB_URL/PUBLIC_WEB_URL (el iframe de la web las resuelve contra su origen),
// absolutas si hay base, y el MockProvider con el prefijo público del navegador (no localhost).

let h: HubHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const player = () => devToken('PLAYER', OP, PLAYER);

describe('resolveHubUrls', () => {
  it('sin variables: web relativa, API pública /api-proxy e interna 127.0.0.1:PORT', () => {
    expect(resolveHubUrls({})).toEqual({ webUrl: '', publicApiUrl: '/api-proxy', internalApiUrl: 'http://127.0.0.1:4000' });
    expect(resolveHubUrls({ PORT: '4100' }).internalApiUrl).toBe('http://127.0.0.1:4100');
  });

  it('prioridades y barra final', () => {
    const u = resolveHubUrls({
      WEB_URL: '',
      PUBLIC_WEB_URL: 'https://casino.example.com/',
      PUBLIC_API_URL: 'https://api.example.com',
      HUB_PUBLIC_API_URL: '/_svc/api/',
      HUB_INTERNAL_API_URL: 'http://api:4000/',
    });
    expect(u).toEqual({ webUrl: 'https://casino.example.com', publicApiUrl: '/_svc/api', internalApiUrl: 'http://api:4000' });
    expect(resolveHubUrls({ WEB_URL: 'https://w.example', PUBLIC_WEB_URL: 'https://x.example' }).webUrl).toBe('https://w.example');
    expect(resolveHubUrls({ PUBLIC_API_URL: 'https://api.example.com' }).publicApiUrl).toBe('https://api.example.com');
  });

  it('ningún default apunta a localhost', () => {
    const u = resolveHubUrls({});
    expect(u.webUrl).not.toMatch(/localhost/);
    expect(u.publicApiUrl).not.toMatch(/localhost/);
  });
});

describe('launch de juegos', () => {
  it('Studios sin WEB_URL ni PUBLIC_WEB_URL → URL relativa /studio/<id>?mode=&session=', async () => {
    h = await startHub({ env: { WEB_URL: '', PUBLIC_WEB_URL: '' } });
    const r = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'real', currency: 'COP' }, player());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const url = r.body.url as string;
    expect(url.startsWith('/studio/nymfo-starfall?')).toBe(true);
    const q = new URL(url, 'https://cualquier-host.example').searchParams;
    expect(q.get('mode')).toBe('real');
    expect(q.get('session')).toBeTruthy();
  });

  it('Studios con PUBLIC_WEB_URL → URL absoluta', async () => {
    h = await startHub({ env: { WEB_URL: '', PUBLIC_WEB_URL: 'https://casino.example.com/' } });
    const r = await api(h.base, 'POST', '/hub/v1/games/nymfo-starfall/launch', { mode: 'real', currency: 'COP' }, player());
    expect(r.status).toBe(201);
    expect((r.body.url as string).startsWith('https://casino.example.com/studio/nymfo-starfall?')).toBe(true);
  });

  it("MockProvider con HUB_PUBLIC_API_URL='/_svc/api' → '/_svc/api/hub/mock-provider/game/...' con la moneda de la sesión", async () => {
    h = await startHub({ env: { HUB_PUBLIC_API_URL: '/_svc/api' } });
    const r = await api(h.base, 'POST', '/hub/v1/games/mock-provider-mp-golden-oasis/launch', { mode: 'real', currency: 'COP' }, player());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const url = r.body.url as string;
    expect(url.startsWith('/_svc/api/hub/mock-provider/game/mp-golden-oasis?')).toBe(true);
    expect(new URL(url, 'https://x.example').searchParams.get('currency')).toBe('COP');
  });

  it('el servidor mock cobra por la URL interna aunque la pública sea relativa', async () => {
    h = await startHub({ env: { HUB_PUBLIC_API_URL: '/_svc/api', HUB_MOCK_PROVIDER: '1' } });
    h.wallet.seed(OP, PLAYER, 'COP', 1_000_000n);
    const r = await api(h.base, 'POST', '/hub/v1/games/mock-provider-mp-golden-oasis/launch', { mode: 'real', currency: 'COP' }, player());
    const session = new URL(r.body.url, 'https://x.example').searchParams.get('session')!;
    const page = await fetch(`${h.base}/hub/mock-provider/game/mp-golden-oasis?session=${session}&currency=COP&mode=real`);
    const html = await page.text();
    expect(html).toContain('COP');
    expect(html).not.toContain('localhost');
    const bal = await api(h.base, 'POST', '/hub/mock-provider/game/mp-golden-oasis/balance', { session });
    expect(bal.status, JSON.stringify(bal.body)).toBe(200);
    expect(bal.body.currency).toBe('COP');
    expect(String(bal.body.balance)).toBe('1000000');
  });

  it('la página del juego mock sin moneda válida no inventa USD', async () => {
    h = await startHub({ env: { HUB_MOCK_PROVIDER: '1' } });
    const html = await (await fetch(`${h.base}/hub/mock-provider/game/mp-golden-oasis?mode=demo&currency=<x>`)).text();
    expect(html).not.toMatch(/>USD</);
    expect(html).not.toContain('<x>');
  });

  it('la página del juego mock tiene el nodo #balance que usa su script (regresión F1)', async () => {
    h = await startHub({ env: { HUB_MOCK_PROVIDER: '1' } });
    const html = await (await fetch(`${h.base}/hub/mock-provider/game/mp-golden-oasis?mode=demo&currency=COP`)).text();
    expect(html).toMatch(/id="balance"/);
    for (const id of ['cur', 'msg', 'bet', 'spin', 'reel']) expect(html).toContain(`id="${id}"`);
  });

  it('launch sin currency usa la moneda del operador, real y demo (regresión F2: recarga directa del juego)', async () => {
    h = await startHub({ operators: new InMemoryOperators().set(OP, { defaultCurrency: 'COP' }) });
    const real = await api(h.base, 'POST', '/hub/v1/games/mock-provider-mp-golden-oasis/launch', { mode: 'real' }, player());
    expect(real.status, JSON.stringify(real.body)).toBe(201);
    expect(new URL(real.body.url, 'https://x.example').searchParams.get('currency')).toBe('COP');
    const demo = await api(h.base, 'POST', '/hub/v1/games/mock-provider-mp-golden-oasis/launch', { mode: 'demo', operatorId: OP });
    expect(demo.status, JSON.stringify(demo.body)).toBe(201);
    expect(new URL(demo.body.url, 'https://x.example').searchParams.get('currency')).toBe('COP');
  });
});
