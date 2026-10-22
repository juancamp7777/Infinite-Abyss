import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import type { ExternalDepositPort } from '../../shared/ports/ExternalDepositPort';
import { createInboxModule } from '../../inbox';
import { TelegramAdapter } from '../../inbox/infrastructure/channels/TelegramAdapter';
import { WhatsAppAdapter } from '../../inbox/infrastructure/channels/WhatsAppAdapter';
import { createTideModule } from '../../tide';
import type { FlowService } from '../../tide/application/FlowService';
import type { PearlAi } from '../application/PearlAi';
import type { PearlService } from '../application/PearlService';
import type { ExtractedReceipt } from '../domain/types';
import { createPearlModule } from '../index';

const OP = 'op-pearl-ai';
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed.padEnd(64, '.'))]);

describe('Pearl IA de punta a punta (webchat → lectura → conciliación → acreditación)', () => {
  let server: HttpServer;
  let base: string;
  let pearl: PearlService;
  let ai: PearlAi;
  let feed: { id: string; token: string };
  const credited: string[] = [];
  let nextRead: ExtractedReceipt = { amount: '0', senderName: '' };
  let judgeVerdict = { approve: true, reason: 'ok' };
  const reads: string[] = [];
  const player = devToken('PLAYER', OP, 'player-ai');
  const player2 = devToken('PLAYER', OP, 'player-ai-2');
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');
  const agent = devToken('OPERATOR_AGENT', OP, 'cajero-1');

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: Buffer } = {}) => {
    const headers: Record<string, string> = { 'content-type': opts.raw ? 'image/png' : 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, type, body: type.includes('json') ? ((await res.json()) as any) : Buffer.from(await res.arrayBuffer()) };
  };
  const botTexts = async (token: string) => (await call('GET', '/inbox/v1/webchat/conversation', { token })).body.messages.filter((m: any) => m.authorType === 'bot').map((m: any) => m.body as string);

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    const deposits: ExternalDepositPort = { credit: async (req) => { credited.push(req.reference); return { depositId: `d-${req.reference}`, txId: 't', duplicate: false }; } };
    const deps: ModuleDeps = { wallet: new InMemoryWallet(), bus: new InMemoryEventBus(), auth: new MockAuth({ NODE_ENV: 'test' }), compliance: new InMemoryPlayerCompliance(), logger: silentLogger, env: { INBOX_SECRETS_KEY: 'k'.repeat(40) }, services: {} };
    Object.assign(deps.services, await createInboxModule().register(app, undefined, deps));
    Object.assign(deps.services, await createTideModule({ tickMs: 0 }).register(app, undefined, deps));
    const published = await createPearlModule({
      tickMs: 0, deposits,
      aiFactory: () => ({ readReceipt: async (img) => { reads.push(img.subarray(8, 20).toString()); return nextRead; }, judge: async () => judgeVerdict }),
    }).register(app, undefined, deps);
    pearl = published['pearl.service'] as PearlService;
    ai = published['pearl.ai'] as PearlAi;
    // Bot de bienvenida activo: NO debe responder a imágenes ni al titular que pide Pearl.
    const flows = deps.services['tide.flows'] as FlowService;
    const f = await flows.create(OP, 'Bienvenida', 'welcome');
    await flows.publish(OP, f.id, 'admin');
    await pearl.updateSettings(OP, { mode: 'auto', currency: 'ARS', minAmount: 100n, autoMaxAmount: 10_000_000n });
    await pearl.saveAccount(OP, { holderName: 'Abyss Gaming SRL', accountNumber: '0000003100012345678901' });
    const created = await pearl.createFeed(OP, 'generic', 'Banco');
    feed = { id: created.feed.id, token: created.token };
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('configuración de IA: clave cifrada que nunca sale y se borra al cambiar de proveedor', async () => {
    expect((await call('GET', '/pearl/v1/admin/ai', { token: agent })).status).toBe(403);
    expect((await call('GET', '/pearl/v1/admin/ai', { token: admin })).body).toEqual({ enabled: true, provider: 'anthropic', readerModel: 'claude-haiku-5-5', judgeModel: 'claude-opus-5-5', hasKey: false, keyFromEnv: false });
    const saved = await call('PUT', '/pearl/v1/admin/ai', { token: admin, body: { apiKey: 'sk-test-only-0123456789' } });
    expect(saved.body.hasKey).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain('sk-test');
    const gem = await call('PUT', '/pearl/v1/admin/ai', { token: admin, body: { provider: 'gemini' } });
    expect(gem.body).toMatchObject({ provider: 'gemini', readerModel: 'gemini-2.5-flash', hasKey: false });
    await call('PUT', '/pearl/v1/admin/ai', { token: admin, body: { provider: 'anthropic', apiKey: 'sk-test-only-0123456789' } });
  });

  it('foto por webchat → IA lee → pago del banco → fichas cargadas; el bot de bienvenida no interviene', async () => {
    await call('POST', `/pearl/v1/feeds/${feed.id}/${feed.token}`, { body: { id: 'B1', amount: '25000', senderName: 'PEREZ JUAN', occurredAt: new Date().toISOString() } });
    nextRead = { amount: '25.000,00', senderName: 'Juan Pérez', receiverAccount: '345678901' };
    expect((await call('POST', '/inbox/v1/webchat/attachments', { token: player, raw: Buffer.from('no soy una imagen') })).status).toBe(415);
    const up = await call('POST', '/inbox/v1/webchat/attachments?clientMsgId=img-1', { token: player, raw: png('recibo-1') });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ hasAttachment: true, body: '📷 Imagen' });
    await ai.drain();
    expect(reads).toEqual(['recibo-1....']);
    const receipts = await pearl.listReceipts(OP);
    expect(receipts[0]).toMatchObject({ status: 'credited', source: 'ai', playerId: 'player-ai' });
    expect(receipts[0].attachmentId).toBeTruthy();
    expect(credited).toEqual([`pearl:${receipts[0].id}`]);
    const texts = await botTexts(player);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/Acreditamos ARS 25\.000,00/);

    const img = await call('GET', `/pearl/v1/admin/receipts/${receipts[0].id}/image`, { token: agent });
    expect(img).toMatchObject({ status: 200, type: 'image/png' });
    expect((img.body as Buffer).subarray(0, 4)).toEqual(png('x').subarray(0, 4));

    // La misma foto reenviada: duplicado, sin segunda carga.
    await call('POST', '/inbox/v1/webchat/attachments', { token: player, raw: png('recibo-1') });
    await ai.drain();
    expect(credited).toHaveLength(1);
    expect((await botTexts(player)).at(-1)).toMatch(/ya lo recibimos/);
  });

  it('titular de billetera → pide el nombre → la respuesta del contacto completa y acredita', async () => {
    await call('POST', `/pearl/v1/feeds/${feed.id}/${feed.token}`, { body: { id: 'B2', amount: '8000', senderName: 'Lucia Gomez', occurredAt: new Date().toISOString() } });
    nextRead = { amount: '8000', senderName: 'Mercado Pago' };
    await call('POST', '/inbox/v1/webchat/attachments', { token: player2, raw: png('recibo-2') });
    await ai.drain();
    expect((await botTexts(player2)).at(-1)).toMatch(/nombre completo del titular/);
    await call('POST', '/inbox/v1/webchat/messages', { token: player2, body: { body: 'Lucía Gómez' } });
    await ai.drain();
    const texts = await botTexts(player2);
    expect(texts.at(-1)).toMatch(/Acreditamos ARS 8\.000,00/);
    expect(texts.some((t: string) => /asistente virtual/.test(t))).toBe(false);
  });

  it('juez que veta y lectura fallida → revisión; el cajero corrige los datos y se concilia', async () => {
    await call('POST', `/pearl/v1/feeds/${feed.id}/${feed.token}`, { body: { id: 'B3', amount: '4000', senderName: 'Juan Perez', occurredAt: new Date().toISOString() } });
    judgeVerdict = { approve: false, reason: 'el monto del comprobante parece editado' };
    nextRead = { amount: '4000', senderName: 'Juan Perez' };
    await call('POST', '/inbox/v1/webchat/attachments', { token: player, raw: png('recibo-3') });
    await ai.drain();
    expect((await pearl.listReceipts(OP))[0]).toMatchObject({ status: 'pending_review', reason: 'juez: el monto del comprobante parece editado' });

    judgeVerdict = { approve: true, reason: 'ok' };
    nextRead = { amount: '', senderName: '' }; // la IA no pudo leer
    await call('POST', '/inbox/v1/webchat/attachments', { token: player, raw: png('recibo-4') });
    await ai.drain();
    const r = (await pearl.listReceipts(OP))[0];
    expect(r).toMatchObject({ status: 'pending_review', reason: 'monto_legible,titular' });
    await call('POST', `/pearl/v1/feeds/${feed.id}/${feed.token}`, { body: { id: 'B4', amount: '3500', senderName: 'Juan Perez', occurredAt: new Date().toISOString() } });
    const fixed = await call('PATCH', `/pearl/v1/admin/receipts/${r.id}`, { token: agent, body: { extracted: { amount: '3500', senderName: 'Juan Perez' } } });
    expect(fixed.body.status).toBe('credited');
  });
});

describe('imágenes entrantes de WhatsApp y Telegram', () => {
  it('WhatsApp: media id → URL temporal → bytes con el token', async () => {
    const urls: string[] = [];
    const wa = new WhatsAppAdapter(async () => ({ status: 200, json: {} }), 'https://graph.test', async (url, headers) => {
      urls.push(`${url}|${headers?.authorization}`);
      return url.endsWith('/MEDIA1') ? { status: 200, body: Buffer.from(JSON.stringify({ url: 'https://cdn.test/f.jpg' })) } : { status: 200, body: Buffer.from('jpeg-bytes') };
    });
    const parsed = wa.parse({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '57300', id: 'w1', type: 'image', image: { id: 'MEDIA1', caption: 'pago' } }] } }] }] });
    expect(parsed[0]).toMatchObject({ body: '📷 Imagen: pago', media: { ref: 'MEDIA1' } });
    const cfg = { phoneNumberId: '123456', accessToken: 'EAAG-test-only-token-0123456789', appSecret: 'a'.repeat(32), displayPhone: '', apiVersion: 'v21.0' };
    expect((await wa.fetchMedia(cfg, 'MEDIA1')).toString()).toBe('jpeg-bytes');
    expect(urls).toEqual([`https://graph.test/v21.0/MEDIA1|Bearer ${cfg.accessToken}`, `https://cdn.test/f.jpg|Bearer ${cfg.accessToken}`]);
  });

  it('Telegram: la foto más grande vía getFile', async () => {
    const tg = new TelegramAdapter(async (url, body: any) => ({ status: 200, json: url.endsWith('/getFile') && body.file_id === 'BIG' ? { ok: true, result: { file_path: 'photos/f.jpg' } } : { ok: false } }), 'https://tg.test', async (url) => ({ status: url === 'https://tg.test/file/bot123456:TOKEN/photos/f.jpg' ? 200 : 404, body: Buffer.from('foto') }));
    const parsed = tg.parse({ update_id: 9, message: { message_id: 1, from: { id: 5, first_name: 'Ana' }, chat: { id: 5, type: 'private' }, photo: [{ file_id: 'SMALL' }, { file_id: 'BIG' }], caption: 'comprobante' } });
    expect(parsed[0]).toMatchObject({ body: '📷 Imagen: comprobante', media: { ref: 'BIG' } });
    expect((await tg.fetchMedia({ botToken: '123456:TOKEN', botUsername: '' }, 'BIG')).toString()).toBe('foto');
  });
});
