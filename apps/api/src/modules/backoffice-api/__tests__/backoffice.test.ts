import express from 'express';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { silentLogger, type ModuleDeps } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { csvCell, neutralizeFormula, toCsv } from '../application/csv';
import { sanitizeSvg } from '../application/skins';
import type { CostSource } from '../domain/types';
import { BACKOFFICE_PREFIX, createBackoffice } from '../index';

const NOW = new Date('2026-02-15T12:00:00Z');
const costs: CostSource = {
  missing: () => [],
  bonusGrants: async (op) => (!op || op === 'op-1' ? [{ operatorId: 'op-1', day: '2026-01-01', amount: 500n }] : []),
  jackpotFunding: async (op) => (!op || op === 'op-1' ? [{ operatorId: 'op-1', day: '2026-01-01', amount: 200n }] : []),
};

interface H {
  base: string;
  bus: InMemoryEventBus;
  close(): Promise<void>;
  call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any; text: string; headers: Headers }>;
}

async function start(env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }): Promise<H> {
  const app = express();
  const bus = new InMemoryEventBus();
  const deps: ModuleDeps = { wallet: new InMemoryWallet(), bus, auth: new MockAuth(env), compliance: new InMemoryPlayerCompliance(), logger: silentLogger, env, services: {} };
  const rt = createBackoffice(deps, { costs, clock: () => NOW });
  app.use(BACKOFFICE_PREFIX, rt.router);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BACKOFFICE_PREFIX}`;
  return {
    base,
    bus,
    close: () => new Promise<void>((r) => server.close(() => r())),
    async call(method, path, token, body) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* csv */ }
      return { status: res.status, json, text, headers: res.headers };
    },
  };
}

const at = (d: string) => `${d}T10:00:00.000Z`;
const base = (op: string, p: string, d: string) => ({ operatorId: op, playerId: p, at: at(d) });

async function seed(bus: InMemoryEventBus) {
  const reg = (op: string, p: string, d: string) => bus.publish('player.registered', { ...base(op, p, d), currency: 'USD' });
  await reg('op-1', 'p1', '2026-01-01');
  await reg('op-1', 'p2', '2026-01-01');
  await reg('op-1', 'p3', '2026-01-08');
  await reg('op-2', 'p9', '2026-01-01');
  const dep = { ...base('op-1', 'p1', '2026-01-01'), amount: 10000n, currency: 'USD', isFirst: true, txId: 'tx1' };
  await bus.publish('deposit.completed', dep);
  await bus.publish('deposit.completed', dep); // reintento: no debe duplicar
  await bus.publish('deposit.completed', { ...base('op-1', 'p2', '2026-01-02'), amount: 5000n, currency: 'USD', isFirst: false, txId: 'tx2' });
  await bus.publish('deposit.completed', { ...base('op-2', 'p9', '2026-01-01'), amount: 7000n, currency: 'USD', isFirst: true, txId: 'tx9' });
  await bus.publish('withdrawal.completed', { ...base('op-1', 'p1', '2026-01-03'), amount: 1000n, currency: 'USD', txId: 'w1' });
  const bet = (op: string, p: string, d: string, round: string, amount: bigint, win: bigint) => ({ ...base(op, p, d), amount, win, currency: 'USD', gameId: 'g', provider: 'x', category: 'slots', roundId: round, multiplier: 0 });
  await bus.publish('bet.placed', { ...bet('op-1', 'p1', '2026-01-01', 'r1', 1000n, 0n) });
  await bus.publish('bet.settled', bet('op-1', 'p1', '2026-01-01', 'r1', 1000n, 300n));
  await bus.publish('bet.placed', { ...bet('op-1', 'p2', '2026-01-01', 'r2', 2000n, 0n) });
  await bus.publish('bet.settled', bet('op-1', 'p2', '2026-01-01', 'r2', 2000n, 0n));
  await bus.publish('bet.settled', bet('op-1', 'p2', '2026-01-01', 'r2', 2000n, 0n)); // duplicado
  await bus.publish('bet.placed', bet('op-1', 'p1', '2026-01-08', 'r3', 100n, 0n)); // p1 activo D7
  await bus.publish('login', base('op-1', 'p1', '2026-01-02'));
  await bus.publish('login', base('op-1', 'p2', '2026-01-31')); // p2 activo D30
  await bus.publish('bet.settled', bet('op-2', 'p9', '2026-01-01', 'r9', 4000n, 1000n));
  await bus.drain();
}

describe('backoffice-api: KPIs', () => {
  let h: H;
  beforeEach(async () => { h = await start(); await seed(h.bus); });
  afterEach(async () => { await h.close(); });

  it('calcula GGR, NGR, depositantes, FTD y registros desde eventos (idempotente)', async () => {
    const r = await h.call('GET', '/dashboard?from=2026-01-01&to=2026-01-31', devToken('OPERATOR_ADMIN', 'op-1', 'u1'));
    expect(r.status).toBe(200);
    const t = r.json.totals;
    expect(t.bets).toBe('3000');
    expect(t.wins).toBe('300');
    expect(t.ggr).toBe('2700');
    expect(t.bonusCost).toBe('500');
    expect(t.jackpotFunding).toBe('200');
    expect(t.ngr).toBe('2000'); // 2700 − 500 − 200
    expect(t.depositors).toBe(2);
    expect(t.ftdCount).toBe(1);
    expect(t.ftdAmount).toBe('10000');
    expect(t.depositsAmount).toBe('15000');
    expect(t.withdrawalsAmount).toBe('1000');
    expect(t.registrations).toBe(3);
    expect(t.bettors).toBe(2);
    expect(t.activePlayers).toBe(3);
    const d1 = r.json.days.find((d: any) => d.day === '2026-01-01');
    expect(d1.ggr).toBe('2700');
    expect(d1.activePlayers).toBe(2);
    expect(d1.ngr).toBe('2000');
    expect(r.json.days).toHaveLength(31);
  });

  it('calcula retención D1/D7/D30 por cohorte madura', async () => {
    const r = await h.call('GET', '/dashboard?from=2026-01-01&to=2026-01-31', devToken('OPERATOR_ADMIN', 'op-1', 'u1'));
    const { d1, d7, d30 } = r.json.retention;
    expect(d1).toEqual({ eligible: 3, retained: 2, rate: 66.67 }); // p1 (login d2), p2 (depósito d2)
    expect(d7).toEqual({ eligible: 3, retained: 1, rate: 33.33 }); // p1 (apuesta 8 ene)
    expect(d30).toEqual({ eligible: 3, retained: 1, rate: 33.33 }); // p2 (login 31 ene)
  });

  it('las cohortes inmaduras no cuentan en el denominador', async () => {
    const r = await h.call('GET', '/dashboard?from=2026-02-01&to=2026-02-15', devToken('PLATFORM_ADMIN', '*', 'root'));
    expect(r.json.retention.d1.rate).toBeNull();
  });

  it('scoping: el operador solo ve el suyo; la plataforma ve todos o filtra', async () => {
    const op1 = devToken('OPERATOR_ADMIN', 'op-1', 'u1');
    expect((await h.call('GET', '/dashboard?operatorId=op-2&from=2026-01-01&to=2026-01-31', op1)).status).toBe(403);
    const all = await h.call('GET', '/dashboard?from=2026-01-01&to=2026-01-31', devToken('PLATFORM_ADMIN', '*', 'root'));
    expect(all.json.totals.ggr).toBe('5700'); // 2700 + 3000
    expect(all.json.totals.registrations).toBe(4);
    const only2 = await h.call('GET', '/dashboard?operatorId=op-2&from=2026-01-01&to=2026-01-31', devToken('PLATFORM_ADMIN', '*', 'root'));
    expect(only2.json.totals.ggr).toBe('3000');
    expect(only2.json.totals.ngr).toBe('3000');
  });

  it('exige autenticación y rol (el agente no ve el dashboard)', async () => {
    expect((await h.call('GET', '/dashboard')).status).toBe(401);
    expect((await h.call('GET', '/dashboard', devToken('OPERATOR_AGENT', 'op-1', 'a1'))).status).toBe(403);
    expect((await h.call('GET', '/dashboard?from=2026-02-01&to=2026-01-01', devToken('OPERATOR_ADMIN', 'op-1', 'u1'))).status).toBe(400);
  });
});

describe('backoffice-api: skins', () => {
  let h: H;
  const validSkin = {
    name: 'Casino Uno',
    logoUrl: 'https://cdn.example.com/logo.png',
    colors: { primary: '#123456', secondary: '#abc', background: '#000000', surface: '#111111', text: '#ffffff', accent: '#ff00ffaa' },
    banners: [{ title: 'Bienvenida', subtitle: '100% hasta $100', href: '/promos/welcome' }],
  };
  beforeEach(async () => { h = await start(); });
  afterEach(async () => { await h.close(); });

  it('GET público devuelve la skin por defecto y luego la guardada, con caché corta', async () => {
    const def = await h.call('GET', '/public/skin?operatorId=op-1');
    expect(def.status).toBe(200);
    expect(def.json.colors.primary).toMatch(/^#/);
    const tok = devToken('OPERATOR_ADMIN', 'op-1', 'u1');
    const put = await h.call('PUT', '/admin/skins/op-1', tok, validSkin);
    expect(put.status).toBe(200);
    const pub = await h.call('GET', '/public/skin?operatorId=op-1');
    expect(pub.json).toEqual(validSkin);
    expect(pub.headers.get('cache-control')).toContain('max-age');
    expect((await h.call('GET', '/public/skin')).status).toBe(400);
  });

  it('valida colores hex, URLs y scoping', async () => {
    const tok = devToken('OPERATOR_ADMIN', 'op-1', 'u1');
    const badColor = { ...validSkin, colors: { ...validSkin.colors, primary: 'red' } };
    expect((await h.call('PUT', '/admin/skins/op-1', tok, badColor)).status).toBe(400);
    const badHref = { ...validSkin, banners: [{ title: 'x', subtitle: '', href: 'javascript:alert(1)' }] };
    expect((await h.call('PUT', '/admin/skins/op-1', tok, badHref)).status).toBe(400);
    expect((await h.call('PUT', '/admin/skins/op-2', tok, validSkin)).status).toBe(403);
    expect((await h.call('PUT', '/admin/skins/op-1', devToken('OPERATOR_AGENT', 'op-1', 'a'), validSkin)).status).toBe(403);
    expect((await h.call('PUT', '/admin/skins/op-2', devToken('PLATFORM_ADMIN', '*', 'root'), validSkin)).status).toBe(200);
  });

  it('sanea el logo SVG y lo guarda como data URI', async () => {
    const tok = devToken('OPERATOR_ADMIN', 'op-1', 'u1');
    const ok = await h.call('PUT', '/admin/skins/op-1', tok, { ...validSkin, logoUrl: undefined, logoSvg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>' });
    expect(ok.status).toBe(200);
    expect(ok.json.logoUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const evil = await h.call('PUT', '/admin/skins/op-1', tok, { ...validSkin, logoUrl: undefined, logoSvg: '<svg><script>alert(1)</script></svg>' });
    expect(evil.status).toBe(400);
  });

  it('sanitizeSvg rechaza scripts, handlers y referencias externas', () => {
    expect(() => sanitizeSvg('<svg><script>x</script></svg>')).toThrow();
    expect(() => sanitizeSvg('<svg onload="alert(1)"></svg>')).toThrow();
    expect(() => sanitizeSvg('<svg><foreignObject></foreignObject></svg>')).toThrow();
    expect(() => sanitizeSvg('<svg><rect fill="url(https://evil.test/x)"/></svg>')).toThrow();
    expect(() => sanitizeSvg('<svg><!-- x --></svg>')).toThrow();
    expect(() => sanitizeSvg('<svg><image href="http://x"/></svg>')).toThrow();
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><path d="M0 0L1 1" fill="url(#g)"/></svg>')).toContain('xmlns=');
  });
});

describe('backoffice-api: CSV', () => {
  it('escapa comillas, comas y saltos de línea', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('di"jo')).toBe('"di""jo"');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12345678901234567890n)).toBe('12345678901234567890');
  });

  it('neutraliza inyección de fórmulas en texto pero no en números', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x']) expect(neutralizeFormula(s).startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(-5n)).toBe('-5');
    expect(toCsv(['a', '=h'], [['=1', 2]])).toBe("a,'=h\r\n'=1,2\r\n");
  });

  it('endpoint kpis-daily devuelve CSV con cabeceras de descarga y respeta el scope', async () => {
    const h = await start();
    await seed(h.bus);
    const r = await h.call('GET', '/admin/reports/kpis-daily.csv?from=2026-01-01&to=2026-01-31', devToken('OPERATOR_ADMIN', 'op-1', 'u1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toContain('ggr');
    expect(lines.slice(1).every((l) => l.includes('op-1'))).toBe(true);
    expect(lines[1]!.split(',')[0]).toBe('2026-01-01');
    expect((await h.call('GET', '/admin/reports/kpis-daily.csv?operatorId=op-2', devToken('OPERATOR_ADMIN', 'op-1', 'u1'))).status).toBe(403);
    expect((await h.call('GET', '/admin/reports/nope.csv', devToken('OPERATOR_ADMIN', 'op-1', 'u1'))).status).toBe(400);
    expect((await h.call('GET', '/admin/reports/players.csv', devToken('OPERATOR_ADMIN', 'op-1', 'u1'))).status).toBe(501);
    await h.close();
  });
});

describe('backoffice-api: login de desarrollo', () => {
  it('emite un token válido para el MockAuth fuera de producción', async () => {
    const h = await start();
    const r = await h.call('POST', '/dev/login', undefined, { role: 'OPERATOR_ADMIN', operatorId: 'op-1' });
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^dev:OPERATOR_ADMIN:op-1:/);
    const d = await h.call('GET', '/dashboard', r.json.token);
    expect(d.status).toBe(200);
    const pa = await h.call('POST', '/dev/login', undefined, { role: 'PLATFORM_ADMIN' });
    expect(pa.json.token).toMatch(/^dev:PLATFORM_ADMIN:\*:/);
    expect((await h.call('POST', '/dev/login', undefined, { role: 'OPERATOR_ADMIN' })).status).toBe(400);
    expect((await h.call('POST', '/dev/login', undefined, { role: 'PLAYER', operatorId: 'op-1' })).status).toBe(400);
    await h.close();
  });

  it('no existe en producción', async () => {
    const h = await start({ NODE_ENV: 'production' });
    expect((await h.call('POST', '/dev/login', undefined, { role: 'PLATFORM_ADMIN' })).status).toBe(404);
    await h.close();
  });
});
