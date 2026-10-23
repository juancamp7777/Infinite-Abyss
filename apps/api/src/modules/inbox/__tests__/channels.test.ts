import { createHmac } from 'crypto';
import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { captureRawBody } from '../../hub/infrastructure/http/router';
import { SecretBox } from '../domain/secretBox';
import { createInboxModule } from '../index';
import type { HttpPost, WebhookRequest } from '../infrastructure/channels/ChannelAdapter';
import { TelegramAdapter } from '../infrastructure/channels/TelegramAdapter';
import { WhatsAppAdapter } from '../infrastructure/channels/WhatsAppAdapter';

const OP = 'op-channels';
const OTHER = 'op-channels-other';
const APP_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const WA_TOKEN = 'EAAG-test-only-access-token-0123456789';
const TG_TOKEN = '123456789:AAtest-only-bot-token-0123456789abcdef';

/** Transporte falso: registra cada llamada y responde según la cola o por defecto con éxito. */
function fakeHttp() {
  const calls: Array<{ url: string; body: any; headers?: Record<string, string> }> = [];
  const queue: Array<{ status: number; json: any }> = [];
  const http: HttpPost = async (url, body, headers) => {
    calls.push({ url, body, headers });
    if (queue.length) return queue.shift()!;
    if (url.includes('graph')) return { status: 200, json: { messages: [{ id: `wamid.${calls.length}` }] } };
    if (url.endsWith('/sendMessage')) return { status: 200, json: { ok: true, result: { message_id: 900 + calls.length } } };
    return { status: 200, json: { ok: true, result: true } };
  };
  return { http, calls, queue };
}

const req = (p: Partial<WebhookRequest>): WebhookRequest => ({ method: 'POST', headers: {}, query: {}, rawBody: Buffer.alloc(0), body: {}, ...p });
const waPayload = (from: string, id: string, text: string) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name: 'Carlos' } }], messages: [{ from, id, timestamp: '1', type: 'text', text: { body: text } }] } }] }],
});
const sign = (raw: string) => `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;

describe('SecretBox', () => {
  it('cifra y descifra; detecta manipulación y clave incorrecta', () => {
    const box = new SecretBox('k'.repeat(40));
    const sealed = box.seal({ token: 'secreto' });
    expect(sealed).not.toContain('secreto');
    expect(box.open(sealed)).toEqual({ token: 'secreto' });
    const parts = sealed.split('.');
    parts[3] = Buffer.from('{"token":"otro"}').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
    expect(() => new SecretBox('z'.repeat(40)).open(sealed)).toThrow();
    expect(() => new SecretBox('corta')).toThrow(/32/);
  });
});

describe('adaptadores', () => {
  it('WhatsApp: verificación GET, firma, parseo y errores de envío', async () => {
    const f = fakeHttp();
    const wa = new WhatsAppAdapter(f.http);
    expect(wa.handshake(req({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '42' } }), 'tok')).toBe('42');
    expect(wa.handshake(req({ method: 'GET', query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': '42' } }), 'tok')).toBeNull();
    const { config } = wa.parseConfig({ phoneNumberId: '1234567890', accessToken: WA_TOKEN, appSecret: APP_SECRET, displayPhone: '+57 300' });
    const raw = JSON.stringify(waPayload('573001112233', 'wamid.A', 'hola'));
    expect(wa.verify(req({ rawBody: Buffer.from(raw), headers: { 'x-hub-signature-256': sign(raw) } }), config)).toBe(true);
    expect(wa.verify(req({ rawBody: Buffer.from(raw + ' '), headers: { 'x-hub-signature-256': sign(raw) } }), config)).toBe(false);
    expect(wa.verify(req({ rawBody: Buffer.from(raw) }), config)).toBe(false);
    expect(wa.parse(JSON.parse(raw))).toEqual([{ from: '573001112233', name: 'Carlos', messageId: 'wamid.A', body: 'hola' }]);
    const img = waPayload('573001112233', 'wamid.B', '');
    img.entry[0].changes[0].value.messages[0] = { from: '573001112233', id: 'wamid.B', timestamp: '1', type: 'image', image: { caption: 'comprobante' } } as never;
    expect(wa.parse(img)[0].body).toBe('📷 Imagen: comprobante');
    expect(wa.parse({ object: 'otro' })).toEqual([]);

    expect(await wa.send(config, '573001112233', 'hola')).toEqual({ externalMessageId: 'wamid.1' });
    expect(f.calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v21.0/1234567890/messages', body: { to: '573001112233', text: { body: 'hola' } }, headers: { authorization: `Bearer ${WA_TOKEN}` } });
    f.queue.push({ status: 400, json: { error: { code: 131047, message: 'Re-engagement message' } } });
    await expect(wa.send(config, '1', 'x')).rejects.toThrow(/24 h/);
    expect(() => wa.parseConfig({ phoneNumberId: 'abc', accessToken: 'x', appSecret: 'y' })).toThrow(/inválidas/);
  });

  it('Telegram: secret_token, solo chats privados, envío y setWebhook', async () => {
    const f = fakeHttp();
    const tg = new TelegramAdapter(f.http);
    const { config, publicInfo } = tg.parseConfig({ botToken: TG_TOKEN, botUsername: '@AbyssBot' });
    expect(publicInfo).toEqual({ bot: '@AbyssBot' });
    expect(tg.verify(req({ headers: { 'x-telegram-bot-api-secret-token': 's3cret' } }), config, 's3cret')).toBe(true);
    expect(tg.verify(req({ headers: { 'x-telegram-bot-api-secret-token': 'otro' } }), config, 's3cret')).toBe(false);
    const update = { update_id: 77, message: { message_id: 5, from: { id: 9, first_name: 'Ana', last_name: 'Ruiz' }, chat: { id: 9, type: 'private' }, text: 'hola bot' } };
    expect(tg.parse(update)).toEqual([{ from: '9', name: 'Ana Ruiz', messageId: '77', body: 'hola bot' }]);
    expect(tg.parse({ ...update, message: { ...update.message, chat: { id: -1, type: 'group' } } })).toEqual([]);
    expect(await tg.send(config, '9', 'respuesta')).toEqual({ externalMessageId: '901' });
    await tg.activate(config, 'https://api.example.com/inbox/v1/channels/x/webhook', 's3cret');
    expect(f.calls[1]).toMatchObject({ url: `https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, body: { url: 'https://api.example.com/inbox/v1/channels/x/webhook', secret_token: 's3cret' } });
    expect(f.calls.slice(2).map((c) => c.url.split('/').at(-1))).toEqual(['setMyShortDescription', 'setMyDescription', 'setMyCommands']);
    expect(f.calls.at(-1)!.body).toMatchObject({ commands: expect.arrayContaining([{ command: 'recargar', description: 'Recargar saldo' }]) });
    f.queue.push({ status: 403, json: { ok: false, description: 'Forbidden: bot was blocked by the user' } });
    await expect(tg.send(config, '9', 'x')).rejects.toThrow(/blocked/);
  });
});

describe('canales por HTTP', () => {
  let server: HttpServer;
  let base: string;
  const f = fakeHttp();
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');
  const agent = devToken('OPERATOR_AGENT', OP, 'agent-1');
  const otherAdmin = devToken('OPERATOR_ADMIN', OTHER, 'admin-2');

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* texto plano */
    }
    return { status: res.status, body, text };
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ verify: captureRawBody }));
    server = createServer(app);
    const deps: ModuleDeps = {
      wallet: new InMemoryWallet(),
      bus: new InMemoryEventBus(),
      auth: new MockAuth({ NODE_ENV: 'test' }),
      compliance: new InMemoryPlayerCompliance(),
      logger: silentLogger,
      env: { INBOX_SECRETS_KEY: 'test-only-inbox-key-0123456789abcdefghij', INBOX_PUBLIC_URL: 'https://api.example.com/' },
      services: {},
    };
    await createInboxModule({ adapters: [new WhatsAppAdapter(f.http), new TelegramAdapter(f.http)] }).register(app, undefined, deps);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inbox/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('WhatsApp de punta a punta: alta, webhook firmado e idempotente, respuesta, fallo y reintento', async () => {
    expect((await call('POST', '/admin/channels', { token: agent, body: { type: 'whatsapp', config: {} } })).status).toBe(403);
    const created = await call('POST', '/admin/channels', { token: admin, body: { type: 'whatsapp', name: 'Soporte WA', config: { phoneNumberId: '1234567890', accessToken: WA_TOKEN, appSecret: APP_SECRET, displayPhone: '+57 300 111' } } });
    expect(created.status).toBe(201);
    const ch = created.body.channel;
    expect(ch).toMatchObject({ type: 'whatsapp', name: 'Soporte WA', enabled: true, publicInfo: { phone: '+57 300 111' }, webhookUrl: `https://api.example.com/inbox/v1/channels/${ch.id}/webhook` });
    const listed = await call('GET', '/admin/channels', { token: admin });
    expect(JSON.stringify(listed.body)).not.toMatch(new RegExp(`${WA_TOKEN}|${APP_SECRET}|configEnc`));
    expect((await call('GET', '/admin/channels', { token: otherAdmin })).body.items).toHaveLength(0);
    expect((await call('PATCH', `/admin/channels/${ch.id}`, { token: otherAdmin, body: { enabled: false } })).status).toBe(404);

    const hook = `/channels/${ch.id}/webhook`;
    const verify = await call('GET', `${hook}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(ch.verifyToken)}&hub.challenge=1158201444`);
    expect(verify).toMatchObject({ status: 200, text: '1158201444' });
    expect((await call('GET', `${hook}?hub.mode=subscribe&hub.verify_token=malo&hub.challenge=1`)).status).toBe(403);

    const raw = JSON.stringify(waPayload('573001112233', 'wamid.IN1', 'quiero retirar'));
    expect((await call('POST', hook, { raw, headers: { 'x-hub-signature-256': sign(raw.replace('retirar', 'robar')) } })).status).toBe(401);
    expect((await call('POST', hook, { raw, headers: { 'x-hub-signature-256': sign(raw) } })).body).toEqual({ ok: true, received: 1 });
    await call('POST', hook, { raw, headers: { 'x-hub-signature-256': sign(raw) } }); // reintento de Meta

    const convs = (await call('GET', '/admin/conversations', { token: agent })).body.items;
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: 'whatsapp', channelId: ch.id, contactName: 'Carlos', unread: 1, externalId: `${ch.id}:573001112233` });
    const conv = convs[0];
    expect((await call('GET', `/admin/conversations/${conv.id}`, { token: agent })).body.messages).toHaveLength(1);

    const reply = await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'Hola Carlos' } });
    expect(reply.body).toMatchObject({ status: 'sent', direction: 'out' });
    expect(reply.body.externalMessageId).toMatch(/^wamid\./);
    expect(f.calls.at(-1)).toMatchObject({ body: { to: '573001112233', text: { body: 'Hola Carlos' } } });

    const sentBefore = f.calls.length;
    await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'nota', kind: 'note' } });
    expect(f.calls.length).toBe(sentBefore); // las notas no salen por el canal

    f.queue.push({ status: 400, json: { error: { code: 131047, message: 'Re-engagement' } } });
    const failed = await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'seguimos?' } });
    expect(failed.body).toMatchObject({ status: 'failed' });
    expect(failed.body.error).toMatch(/24 h/);
    const retried = await call('POST', `/admin/conversations/${conv.id}/messages/${failed.body.id}/retry`, { token: agent });
    expect(retried.body).toMatchObject({ status: 'sent' });
    expect(retried.body.error).toBeUndefined();
    expect((await call('POST', `/admin/conversations/${conv.id}/messages/${failed.body.id}/retry`, { token: agent })).status).toBe(409);

    await call('PATCH', `/admin/channels/${ch.id}`, { token: admin, body: { enabled: false } });
    expect((await call('POST', hook, { raw, headers: { 'x-hub-signature-256': sign(raw) } })).status).toBe(404);
    const blocked = await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'x' } });
    expect(blocked.body).toMatchObject({ status: 'failed', error: 'El canal está desactivado' });
  });

  it('Telegram: alta registra el webhook; webhook con secret_token', async () => {
    f.queue.push({ status: 401, json: { ok: false, description: 'Unauthorized' } });
    const bad = await call('POST', '/admin/channels', { token: admin, body: { type: 'telegram', config: { botToken: TG_TOKEN } } });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: 'CHANNEL_ACTIVATION_FAILED' } } });
    expect((await call('GET', '/admin/channels', { token: admin })).body.items.filter((c: any) => c.type === 'telegram')).toHaveLength(0);

    const created = await call('POST', '/admin/channels', { token: admin, body: { type: 'telegram', config: { botToken: TG_TOKEN, botUsername: 'AbyssBot' } } });
    expect(created.status).toBe(201);
    const ch = created.body.channel;
    expect(ch.verifyToken).toBeUndefined();
    const setHook = f.calls.filter((c) => c.url.endsWith('/setWebhook')).at(-1)!;
    expect(setHook.url).toContain('/setWebhook');
    const secret = setHook.body.secret_token as string;

    const update = { update_id: 5001, message: { message_id: 1, from: { id: 42, first_name: 'Luis' }, chat: { id: 42, type: 'private' }, text: 'hola' } };
    expect((await call('POST', `/channels/${ch.id}/webhook`, { body: update })).status).toBe(401);
    expect((await call('POST', `/channels/${ch.id}/webhook`, { body: update, headers: { 'x-telegram-bot-api-secret-token': secret } })).body).toEqual({ ok: true, received: 1 });
    const conv = (await call('GET', '/admin/conversations?q=Luis', { token: agent })).body.items[0];
    expect(conv).toMatchObject({ channel: 'telegram', externalId: `${ch.id}:42` });
    const reply = await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: '¡Hola Luis!' } });
    expect(reply.body.status).toBe('sent');
    expect(f.calls.at(-1)).toMatchObject({ url: `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, body: { chat_id: '42', text: '¡Hola Luis!' } });

    expect((await call('DELETE', `/admin/channels/${ch.id}`, { token: admin })).status).toBe(200);
    const orphan = await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'x' } });
    expect(orphan.body).toMatchObject({ status: 'failed', error: 'El canal de esta conversación ya no existe' });
  });
});
