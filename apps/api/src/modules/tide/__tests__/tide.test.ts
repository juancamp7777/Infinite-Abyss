import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import { devToken, MockAuth } from '../../shared/adapters/MockAuth';
import { InMemoryEventBus } from '../../shared/events/EventBus';
import { ModuleDeps, silentLogger } from '../../shared/module';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { InboxService } from '../../inbox/application/InboxService';
import { createInboxModule } from '../../inbox';
import { InMemoryInboxRepository } from '../../inbox/infrastructure/InMemoryInboxRepository';
import { FlowService, welcomeTemplate } from '../application/FlowService';
import { TideEngine, type TideInboxPort } from '../application/TideEngine';
import { bestFaq, compare, matchOption, render, similarity, validateGraph, type FlowGraph } from '../domain/graph';
import { createTideModule } from '../index';
import { InMemoryTideRepository } from '../infrastructure/InMemoryTideRepository';

const OP = 'op-tide';

describe('grafo y utilidades', () => {
  it('la plantilla de bienvenida es publicable', () => {
    expect(validateGraph(welcomeTemplate()).errors).toEqual([]);
  });

  it('detecta errores de estructura', () => {
    const g: FlowGraph = {
      nodes: [
        { id: 'a', type: 'trigger', config: {}, x: 0, y: 0 },
        { id: 'b', type: 'message', config: { text: '' }, x: 0, y: 0 },
        { id: 'c', type: 'ask', config: { question: '¿?', options: ['x'] }, x: 0, y: 0 },
        { id: 'd', type: 'handoff', config: {}, x: 0, y: 0 },
      ],
      edges: [
        { from: 'a', port: 'next', to: 'c' },
        { from: 'c', port: 'opt:0', to: 'a' },
        { from: 'c', port: 'opt:5', to: 'd' },
        { from: 'c', port: 'other', to: 'd' },
        { from: 'c', port: 'other', to: 'b' },
      ],
    };
    const errs = validateGraph(g).errors.join('\n');
    expect(errs).toMatch(/Nodo b \(message\)/);
    expect(errs).toMatch(/volver al nodo de inicio/);
    expect(errs).toMatch(/no tiene la salida "opt:5"/);
    expect(errs).toMatch(/más de una conexión/);
    expect(validateGraph({ nodes: [], edges: [] }).errors.join()).toMatch(/exactamente un nodo de inicio/);
    const unreachable = welcomeTemplate();
    unreachable.edges = unreachable.edges.filter((e) => e.to !== 'withdraw');
    expect(validateGraph(unreachable).errors.join()).toMatch(/withdraw no está conectado/);
  });

  it('plantillas sin eval ni prototipos', () => {
    const ctx = { contact: { name: 'Ana' }, vars: { monto: '50' } };
    expect(render('Hola {{contact.name}}, {{ vars.monto }} {{vars.nada}}', ctx)).toBe('Hola Ana, 50 ');
    expect(render('{{constructor.name}}{{contact.__proto__}}{{vars}}', ctx)).toBe('');
  });

  it('opciones, comparaciones y FAQ', () => {
    expect(matchOption('2', ['Depósitos', 'Retiros'])).toBe('opt:1');
    expect(matchOption('RETIROS', ['Depósitos', 'Retiros'])).toBe('opt:1');
    expect(matchOption('quiero depositos ya', ['Depósitos', 'Retiros'])).toBe('opt:0');
    expect(matchOption('hola', ['Depósitos'])).toBe('other');
    expect(compare('1.000,50', 'gt', '999')).toBe(true);
    expect(compare('Hola', 'eq', 'hola')).toBe(true);
    expect(compare('ABC', 'matches', '^ab')).toBe(true);
    expect(compare('a'.repeat(40) + 'c', 'matches', '(a+)+$')).toBe(false);
    expect(compare('x', 'matches', '[')).toBe(false);
    expect(similarity('cuanto tarda un retiro', '¿Cuánto tarda un retiro?')).toBe(1);
    const faq = [{ q: '¿Cuánto tarda un retiro?', a: 'R' }, { q: '¿Cómo activo un bono?', a: 'B' }];
    expect(bestFaq('cuanto tardan los retiros', faq, 0.35)?.a).toBe('R');
    expect(bestFaq('el clima de hoy', faq, 0.35)).toBeNull();
  });
});

/** Motor sobre el inbox real en memoria, con reloj controlable. */
function setup() {
  let now = new Date('2026-10-23T12:00:00Z');
  const clock = () => now;
  const inboxRepo = new InMemoryInboxRepository();
  const inbox = new InboxService(inboxRepo, { now: clock, contactRatePerMinute: 1000 });
  const repo = new InMemoryTideRepository();
  const withdrawals: Array<[string, string, string]> = [];
  const engine = new TideEngine(repo, inbox, {
    logger: silentLogger, now: clock,
    actions: () => ({
      ensurePlayer: async (c) => ({ playerId: c.playerId ?? 'nuevo-1', created: !c.playerId }),
      withdraw: async (_c, a, acc, h) => { withdrawals.push([a, acc, h]); return { ok: true }; },
    }),
  });
  inbox.onEvent((e) => engine.onInboxEvent(e));
  const flows = new FlowService(repo);
  const say = async (externalId: string, body: string) => {
    const conv = await inbox.conversationFor({ operatorId: OP, channel: 'webchat', externalId, name: 'Ana' });
    await inbox.contactMessage(conv, body);
    return conv.id;
  };
  const bot = async (convId: string) => (await inbox.get(OP, convId)).messages.filter((m) => m.authorType === 'bot').map((m) => `${m.direction}:${m.body.split('\n')[0]}`);
  return { inbox, repo, engine, flows, say, bot, withdrawals, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('motor de Tide', () => {
  it('un operador sin flujos activos no queda mudo: la bienvenida se activa de fábrica una sola vez; si la desactivan, se respeta', async () => {
    const t = setup();
    await t.flows.create(OP, 'Borrador', 'blank');
    const c = await t.say('v0', 'hola, ¿hay alguien?');
    expect(await t.bot(c)).toEqual(['out:¡Hola Ana! 👋 Soy el asistente virtual.', 'out:¿En qué te ayudo? Elige una opción o escribe tu pregunta.']);
    const flows = (await t.flows.list(OP)).filter((f) => f.name !== 'Borrador');
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ name: 'Bienvenida (automático)', enabled: true, publishedVersion: 1 });
    await t.say('v0b', 'hola');
    expect(await t.flows.list(OP)).toHaveLength(2);
    await t.flows.setEnabled(OP, flows[0].id, false);
    const quiet = await t.say('v0c', 'hola');
    expect(await t.bot(quiet)).toEqual([]);
    expect(await t.flows.list(OP)).toHaveLength(2);
  });

  it('bienvenida → menú → opción → ¿algo más? → cierre', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Bienvenida', 'welcome');
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('v1', 'hola');
    expect(await t.bot(c)).toEqual(['out:¡Hola Ana! 👋 Soy el asistente virtual.', 'out:¿En qué te ayudo? Elige una opción o escribe tu pregunta.']);
    expect(await t.repo.findSession(c)).toMatchObject({ status: 'waiting', nodeId: 'menu' });
    await t.say('v1', '1');
    expect((await t.bot(c)).slice(2)).toEqual(['out:Para recargar, haz tu transferencia y envíame aquí la foto del comprobante 📸. La verificamos y te acreditamos en minutos. También puedes depositar desde Caja → Depositar.', 'out:¿Te ayudo con algo más?']);
    expect((await t.repo.findSession(c))?.vars).toEqual({ motivo: '1' });
    await t.say('v1', 'no, gracias');
    expect((await t.bot(c)).at(-1)).toMatch(/Gracias por escribirnos/);
    expect((await t.inbox.get(OP, c)).conversation.status).toBe('closed');
    expect(await t.repo.findSession(c)).toBeNull();
  });

  it('retiro guiado: monto → cuenta → titular → solicitud registrada (sin IA)', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Bienvenida', 'welcome');
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('vr', 'hola');
    await t.say('vr', 'Retiros');
    expect((await t.bot(c)).at(-1)).toMatch(/Cuánto quieres retirar/);
    await t.say('vr', '15.000');
    await t.say('vr', 'mi.alias.mp');
    await t.say('vr', 'Ana Ruiz');
    expect(t.withdrawals).toEqual([['15.000', 'mi.alias.mp', 'Ana Ruiz']]);
    expect(await t.repo.findSession(c)).toMatchObject({ status: 'done', nodeId: 'withdraw' });
  });

  it('nodos de sala y alta de cuenta; el bot calla en salas de atención humana', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Alta', 'blank');
    await t.flows.saveDraft(OP, f.id, { draft: {
      nodes: [
        { id: 'start', type: 'trigger', config: {}, x: 0, y: 0 },
        { id: 'reg', type: 'register', config: {}, x: 0, y: 0 },
        { id: 'ok', type: 'message', config: { text: 'cuenta creada' }, x: 0, y: 0 },
        { id: 'room', type: 'move_stage', config: { stage: 'support' }, x: 0, y: 0 },
      ],
      edges: [{ from: 'start', port: 'next', to: 'reg' }, { from: 'reg', port: 'created', to: 'ok' }, { from: 'ok', port: 'next', to: 'room' }],
    } });
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('vs', 'hola');
    expect(await t.bot(c)).toEqual(['out:cuenta creada']);
    expect((await t.inbox.get(OP, c)).conversation.stage).toBe('support');
    await t.say('vs', 'hola de nuevo');
    expect(await t.bot(c)).toEqual(['out:cuenta creada']);
  });

  it('pregunta libre → FAQ; sin coincidencia → humano y el bot se calla', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Bienvenida', 'welcome');
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('v2', 'hola');
    await t.say('v2', '¿cuánto tarda un depósito?');
    expect((await t.bot(c)).slice(2)).toEqual(['out:Los depósitos se acreditan al instante una vez confirmado el pago.', 'out:¿Te ayudo con algo más?']);
    await t.say('v2', 'sí');
    await t.say('v2', 'tengo un problema con mi cuenta bancaria');
    const msgs = (await t.inbox.get(OP, c)).messages;
    expect(msgs.at(-1)).toMatchObject({ direction: 'note', authorType: 'bot' });
    expect(msgs.at(-1)!.body).toContain('Motivo: tengo un problema');
    expect(await t.repo.findSession(c)).toMatchObject({ status: 'handoff' });
    const before = msgs.length;
    await t.say('v2', '¿hola?');
    expect((await t.inbox.get(OP, c)).messages.length).toBe(before + 1); // solo el del contacto
  });

  it('un agente que responde detiene el bot', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Bienvenida', 'welcome');
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('v3', 'hola');
    await t.inbox.agentMessage(OP, c, 'agent-1', 'Hola, soy Laura', 'reply');
    expect(await t.repo.findSession(c)).toMatchObject({ status: 'handoff' });
    const n = (await t.bot(c)).length;
    await t.say('v3', '1');
    expect((await t.bot(c)).length).toBe(n);
  });

  it('espera vencida sigue por "timeout" y cierra', async () => {
    const t = setup();
    const f = await t.flows.create(OP, 'Bienvenida', 'welcome');
    await t.flows.publish(OP, f.id, 'admin');
    const c = await t.say('v4', 'hola');
    expect(await t.engine.tick()).toBe(0);
    t.advance(31 * 60_000);
    expect(await t.engine.tick()).toBe(1);
    expect((await t.bot(c)).at(-1)).toMatch(/Gracias por escribirnos/);
    expect((await t.inbox.get(OP, c)).conversation.status).toBe('closed');
  });

  it('prioridad de palabras clave, canales y versión fijada por sesión', async () => {
    const t = setup();
    const general = await t.flows.create(OP, 'General', 'welcome');
    await t.flows.publish(OP, general.id, 'admin');
    const promo = await t.flows.create(OP, 'Bonos', 'blank');
    await t.flows.saveDraft(OP, promo.id, { draft: {
      nodes: [
        { id: 'start', type: 'trigger', config: { channels: ['webchat'], keywords: ['bono'] }, x: 0, y: 0 },
        { id: 'q', type: 'ask', config: { question: '¿Qué bono quieres?', options: ['Bienvenida'] }, x: 0, y: 0 },
      ],
      edges: [{ from: 'start', port: 'next', to: 'q' }],
    } });
    await t.flows.publish(OP, promo.id, 'admin');
    const c = await t.say('v5', 'Quiero un BONO!');
    expect(await t.bot(c)).toEqual(['out:¿Qué bono quieres?']);

    // v2 cambia la pregunta; la sesión en curso sigue en v1.
    const g = (await t.flows.get(OP, promo.id)).draft;
    g.nodes[1].config = { ...g.nodes[1].config, question: 'Pregunta nueva' };
    await t.flows.saveDraft(OP, promo.id, { draft: g });
    await t.flows.publish(OP, promo.id, 'admin');
    expect(await t.repo.findSession(c)).toMatchObject({ version: 1 });

    await t.flows.setEnabled(OP, general.id, false);
    const other = await t.say('v6', 'hola');
    expect(await t.bot(other)).toEqual([]);
  });

  it('corta bucles sin pregunta y desactiva un flujo que falla 5 veces seguidas', async () => {
    const t = setup();
    const loop = await t.flows.create(OP, 'Bucle', 'blank');
    await t.flows.saveDraft(OP, loop.id, { draft: {
      nodes: [
        { id: 'start', type: 'trigger', config: {}, x: 0, y: 0 },
        { id: 'm', type: 'message', config: { text: 'eco' }, x: 0, y: 0 },
        { id: 'v', type: 'set_var', config: { name: 'n', value: 'x' }, x: 0, y: 0 },
      ],
      edges: [{ from: 'start', port: 'next', to: 'm' }, { from: 'm', port: 'next', to: 'v' }, { from: 'v', port: 'next', to: 'm' }],
    } });
    await t.flows.publish(OP, loop.id, 'admin');
    const c = await t.say('v7', 'hola');
    expect((await t.bot(c)).length).toBeLessThan(25);

    const repo = new InMemoryTideRepository();
    const broken: TideInboxPort = {
      conversation: async () => { throw new Error('x'); },
      botMessage: async () => { throw new Error('canal caído'); },
      botHandoff: async () => undefined,
      update: async () => undefined,
      setStage: async () => undefined,
    };
    const engine = new TideEngine(repo, broken, { logger: silentLogger });
    const flows = new FlowService(repo);
    const f = await flows.create(OP, 'Frágil', 'welcome');
    await flows.publish(OP, f.id, 'admin');
    const conv = { id: '00000000-0000-4000-8000-000000000001', operatorId: OP, channel: 'webchat', externalId: 'x', contactName: 'X', status: 'open', stage: 'new_lead', lastMessageAt: new Date(), lastMessagePreview: '', unread: 0, createdAt: new Date(), updatedAt: new Date() } as const;
    for (let i = 0; i < 5; i++) await engine.onInboxEvent({ type: 'contact_message', conversation: { ...conv }, message: { body: 'hola' } as never });
    expect((await flows.get(OP, f.id)).enabled).toBe(false);
  });
});

describe('API de Tide', () => {
  let server: HttpServer;
  let base: string;
  const admin = devToken('OPERATOR_ADMIN', OP, 'admin-1');
  const agent = devToken('OPERATOR_AGENT', OP, 'agent-1');
  const other = devToken('OPERATOR_ADMIN', 'op-otro', 'admin-2');
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    server = createServer(app);
    const deps: ModuleDeps = {
      wallet: new InMemoryWallet(), bus: new InMemoryEventBus(), auth: new MockAuth({ NODE_ENV: 'test' }), compliance: new InMemoryPlayerCompliance(),
      logger: silentLogger, env: {}, services: {},
    };
    deps.services = await createInboxModule().register(app, undefined, deps);
    await createTideModule({ tickMs: 0 }).register(app, undefined, deps);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tide/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('CRUD, validación, publicación y aislamiento', async () => {
    expect((await call('GET', '/admin/flows', agent)).status).toBe(403);
    expect((await call('GET', '/admin/node-types', admin)).body.items.map((n: any) => n.type)).toContain('ask');
    const created = await call('POST', '/admin/flows', admin, { name: 'Soporte', template: 'blank' });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await call('POST', `/admin/flows/${id}/publish`, admin)).body.error).toMatchObject({ code: 'INVALID_FLOW', details: ['Conecta el inicio con el primer paso'] });
    expect((await call('PATCH', `/admin/flows/${id}`, admin, { enabled: true })).status).toBe(409);
    expect((await call('PUT', `/admin/flows/${id}`, admin, { draft: { nodes: [{ id: 'x', type: 'nope' }], edges: [] } })).status).toBe(400);
    const draft = { nodes: [{ id: 'start', type: 'trigger', config: {}, x: 0, y: 0 }, { id: 'h', type: 'handoff', config: {}, x: 200, y: 0 }], edges: [{ from: 'start', port: 'next', to: 'h' }] };
    expect((await call('PUT', `/admin/flows/${id}`, admin, { name: 'Soporte 2', draft })).body.name).toBe('Soporte 2');
    expect((await call('POST', `/admin/flows/${id}/validate`, admin)).body.errors).toEqual([]);
    expect((await call('POST', `/admin/flows/${id}/publish`, admin)).body).toMatchObject({ publishedVersion: 1, enabled: true });
    expect((await call('GET', '/admin/flows', admin)).body.items[0]).toMatchObject({ id, nodes: 2, publishedVersion: 1 });
    expect((await call('GET', `/admin/flows/${id}`, other)).status).toBe(404);
    expect((await call('DELETE', `/admin/flows/${id}`, other)).status).toBe(404);
    expect((await call('DELETE', `/admin/flows/${id}`, admin)).status).toBe(200);
  });
});
