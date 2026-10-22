import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { InboxService } from '../application/InboxService';
import { cleanBody, MAX_BODY } from '../domain/types';
import { createInboxModule } from '../index';
import { InMemoryInboxRepository } from '../infrastructure/InMemoryInboxRepository';

const OP = 'op-inbox';
const OTHER = 'op-other';

describe('inbox: dominio y servicio', () => {
  it('cleanBody quita caracteres de control, recorta y limita longitud', () => {
    expect(cleanBody('  hola\u0000\u0007 mundo\n ')).toBe('hola mundo');
    expect(cleanBody('a'.repeat(MAX_BODY + 50))).toHaveLength(MAX_BODY);
  });

  it('idempotencia por clientMsgId, reapertura y no leídos', async () => {
    const svc = new InboxService(new InMemoryInboxRepository());
    const conv = await svc.conversationFor({ operatorId: OP, channel: 'webchat', externalId: 'visitor:1', name: 'Ana' });
    const m1 = await svc.contactMessage(conv, 'hola', 'c-1');
    const again = await svc.contactMessage(conv, 'hola (reintento)', 'c-1');
    expect(again.id).toBe(m1.id);
    let { conversation, messages } = await svc.get(OP, conv.id);
    expect(messages).toHaveLength(1);
    expect(conversation.unread).toBe(1);
    await svc.agentMessage(OP, conv.id, 'agent-1', 'buenas', 'reply');
    ({ conversation } = await svc.get(OP, conv.id));
    expect(conversation).toMatchObject({ unread: 0, status: 'pending', assigneeId: 'agent-1', lastMessagePreview: 'buenas' });
    await svc.update(OP, conv.id, { status: 'closed' });
    const same = await svc.conversationFor({ operatorId: OP, channel: 'webchat', externalId: 'visitor:1', name: 'Ana' });
    expect(same.id).toBe(conv.id);
    await svc.contactMessage(same, 'sigo aquí');
    expect((await svc.get(OP, conv.id)).conversation.status).toBe('open');
  });

  it('las notas internas nunca llegan al contacto', async () => {
    const svc = new InboxService(new InMemoryInboxRepository());
    const sent: string[] = [];
    svc.setNotifier({ toAgents: () => {}, toContact: (_c, m) => sent.push(m.direction) });
    const conv = await svc.conversationFor({ operatorId: OP, channel: 'webchat', externalId: 'visitor:2', name: 'Leo' });
    await svc.contactMessage(conv, 'hola');
    await svc.agentMessage(OP, conv.id, 'a', 'jugador VIP, cuidado', 'note');
    await svc.agentMessage(OP, conv.id, 'a', 'te ayudo', 'reply');
    expect(sent).toEqual(['in', 'out']);
    const visible = await svc.contactMessages(conv);
    expect(visible.map((m) => m.direction)).toEqual(['in', 'out']);
    expect((await svc.get(OP, conv.id)).messages.map((m) => m.direction)).toEqual(['in', 'note', 'out']);
  });

  it('aislamiento por operador, mensajes vacíos y límite de ritmo', async () => {
    const svc = new InboxService(new InMemoryInboxRepository(), { contactRatePerMinute: 3 });
    const conv = await svc.conversationFor({ operatorId: OP, channel: 'webchat', externalId: 'visitor:3', name: 'Eva' });
    await expect(svc.get(OTHER, conv.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.agentMessage(OTHER, conv.id, 'a', 'x', 'reply')).rejects.toMatchObject({ status: 404 });
    await expect(svc.contactMessage(conv, ' \u0000 ')).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 3; i++) await svc.contactMessage(conv, `m${i}`);
    await expect(svc.contactMessage(conv, 'otro')).rejects.toMatchObject({ status: 429 });
  });

  it('respuestas rápidas: formato, duplicados y propiedad', async () => {
    const svc = new InboxService(new InMemoryInboxRepository());
    await expect(svc.saveQuickReply(OP, 'Mal Atajo', 'x')).rejects.toMatchObject({ status: 400 });
    const q = await svc.saveQuickReply(OP, 'saludo', 'Hola, ¿en qué te ayudo?');
    await expect(svc.saveQuickReply(OP, 'saludo', 'otra')).rejects.toMatchObject({ status: 409 });
    await expect(svc.saveQuickReply(OTHER, 'saludo2', 'x', q.id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.deleteQuickReply(OTHER, q.id)).toBe(false);
    expect((await svc.saveQuickReply(OP, 'saludo', 'editado', q.id)).body).toBe('editado');
    expect(await svc.deleteQuickReply(OP, q.id)).toBe(true);
  });
});

describe('inbox: HTTP y sockets', () => {
  let server: HttpServer;
  let ioServer: IOServer;
  let base: string;
  let origin: string;
  const sockets: ClientSocket[] = [];
  const agent = devToken('OPERATOR_AGENT', OP, 'agent-1');
  const otherAdmin = devToken('OPERATOR_ADMIN', OTHER, 'admin-x');
  const player = devToken('PLAYER', OP, 'player-1');

  const call = async (method: string, path: string, opts: { token?: string; visitor?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.visitor) headers['x-visitor-token'] = opts.visitor;
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const connect = (nsp: string, auth: Record<string, string>, query?: Record<string, string>) => {
    const s = ioClient(`${origin}${nsp}`, { auth, query, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    return s;
  };
  const next = <T>(s: ClientSocket, event: string) => new Promise<T>((r) => s.once(event, r));

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    ioServer = new IOServer(server);
    const deps: ModuleDeps = {
      wallet: new InMemoryWallet(),
      bus: new InMemoryEventBus(),
      auth: new MockAuth({ NODE_ENV: 'test' }),
      compliance: new InMemoryPlayerCompliance(),
      operators: { getCurrencyInfo: async (id) => ([OP, OTHER].includes(id) ? { defaultCurrency: 'USD', currencies: ['USD'], limits: {} } : null) },
      logger: silentLogger,
      env: {},
      services: {},
    };
    await createInboxModule({ sessionsPerMinute: 5 }).register(app, ioServer, deps);
    await new Promise<void>((r) => server.listen(0, r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    base = `${origin}/inbox/v1`;
  });

  afterEach(() => {
    sockets.splice(0).forEach((s) => s.close());
  });

  afterAll(async () => {
    ioServer.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('visitante: sesión, mensajes en vivo y aislamiento de notas', async () => {
    expect((await call('POST', '/webchat/session', { body: { operatorId: 'no-existe' } })).status).toBe(404);
    const s = await call('POST', '/webchat/session', { body: { operatorId: OP, name: 'Marta' } });
    expect(s.status).toBe(201);
    const visitor = s.body.token as string;
    expect((await call('GET', '/webchat/conversation')).status).toBe(401);
    expect((await call('GET', '/webchat/conversation', { visitor: 'x'.repeat(43) })).status).toBe(401);
    expect((await call('GET', '/webchat/conversation', { visitor })).body).toEqual({ conversation: null, messages: [] });

    const agentSock = connect('/inbox', { token: agent });
    await next(agentSock, 'inbox:ready');
    const contactSock = connect('/webchat', { visitorToken: visitor });
    await next(contactSock, 'webchat:ready');

    const gotAgent = next<any>(agentSock, 'inbox:message');
    const sent = await call('POST', '/webchat/messages', { visitor, body: { body: 'necesito ayuda con un retiro', clientMsgId: 'cm-1' } });
    expect(sent.status).toBe(201);
    expect((await gotAgent).body).toBe('necesito ayuda con un retiro');
    const retry = await call('POST', '/webchat/messages', { visitor, body: { body: 'necesito ayuda con un retiro', clientMsgId: 'cm-1' } });
    expect(retry.body.id).toBe(sent.body.id);

    const list = await call('GET', '/admin/conversations?assignee=unassigned', { token: agent });
    expect(list.body.items).toHaveLength(1);
    const conv = list.body.items[0];
    expect(conv).toMatchObject({ contactName: 'Marta', unread: 1, status: 'open' });
    expect((await call('GET', `/admin/conversations/${conv.id}`, { token: otherAdmin })).status).toBe(404);
    expect((await call('GET', `/admin/conversations?operatorId=${OP}`, { token: otherAdmin })).status).toBe(403);

    const contactMsgs: any[] = [];
    contactSock.on('webchat:message', (m) => contactMsgs.push(m));
    expect((await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'nota: revisar KYC', kind: 'note' } })).status).toBe(201);
    const reply = next<any>(contactSock, 'webchat:message');
    await call('POST', `/admin/conversations/${conv.id}/messages`, { token: agent, body: { body: 'Hola Marta, lo reviso' } });
    const r = await reply;
    expect(r.body).toBe('Hola Marta, lo reviso');
    expect(r.authorId).toBeUndefined();
    expect(contactMsgs.map((m) => m.direction)).toEqual(['out']);

    const history = await call('GET', '/webchat/conversation', { visitor });
    expect(history.body.messages.map((m: any) => m.direction)).toEqual(['in', 'out']);
    expect(JSON.stringify(history.body)).not.toContain('KYC');
    const full = await call('GET', `/admin/conversations/${conv.id}`, { token: agent });
    expect(full.body.messages.map((m: any) => m.direction)).toEqual(['in', 'note', 'out']);
    expect(full.body.conversation).toMatchObject({ assigneeId: 'agent-1', status: 'pending', unread: 0 });

    expect((await call('GET', '/admin/conversations?assignee=me', { token: agent })).body.items).toHaveLength(1);
    const mine = await call('PATCH', `/admin/conversations/${conv.id}`, { token: agent, body: { assigneeId: 'me' } });
    expect(mine.body.assigneeId).toBe('agent-1');
    expect((await call('GET', '/admin/conversations', { token: agent })).body.me).toBe('agent-1');
    const closed = await call('PATCH', `/admin/conversations/${conv.id}`, { token: agent, body: { status: 'closed', assigneeId: null } });
    expect(closed.body.status).toBe('closed');
    expect(closed.body.assigneeId).toBeUndefined();
  });

  it('jugador logueado: conversación ligada a su playerId', async () => {
    const sent = await call('POST', '/webchat/messages', { token: player, body: { body: 'hola soy jugador' } });
    expect(sent.status).toBe(201);
    const list = await call('GET', '/admin/conversations?q=jugador', { token: agent });
    expect(list.body.items[0]).toMatchObject({ playerId: 'player-1', externalId: 'player:player-1' });
    const read = await call('POST', `/admin/conversations/${list.body.items[0].id}/read`, { token: agent });
    expect(read.body.unread).toBe(0);
    expect((await call('POST', '/webchat/messages', { token: agent, body: { body: 'x' } })).status).toBe(401);
  });

  it('sockets rechazan credenciales inválidas', async () => {
    const bad = connect('/inbox', { token: player });
    expect(await next(bad, 'inbox:error')).toEqual({ code: 'UNAUTHORIZED' });
    const badContact = connect('/webchat', { visitorToken: 'y'.repeat(43) });
    expect(await next(badContact, 'webchat:error')).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('límite de sesiones de visitante por IP', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await call('POST', '/webchat/session', { body: { operatorId: OP } })).status;
    expect(last).toBe(429);
  });

  it('respuestas rápidas por HTTP', async () => {
    const c = await call('POST', '/admin/quick-replies', { token: agent, body: { shortcut: 'Retiro', body: 'Los retiros tardan hasta 24 h.' } });
    expect(c.status).toBe(201);
    expect(c.body.shortcut).toBe('retiro');
    expect((await call('GET', '/admin/quick-replies', { token: otherAdmin })).body.items).toHaveLength(0);
    expect((await call('DELETE', `/admin/quick-replies/${c.body.id}`, { token: otherAdmin })).status).toBe(404);
    expect((await call('DELETE', `/admin/quick-replies/${c.body.id}`, { token: agent })).status).toBe(200);
  });
});
