import type { ModuleLogger } from '../../shared/module';
import type { InboxEvent } from '../../inbox/application/InboxService';
import type { Conversation } from '../../inbox/domain/types';
import { bestFaq, compare, matchOption, normalize, render, type FlowGraph, type FlowNode } from '../domain/graph';
import type { NodeConfig } from '../domain/nodes';
import type { TideFlow, TideRepository, TideSession } from '../domain/types';

/** Lo que Tide necesita del inbox Sonar. */
export interface TideInboxPort {
  conversation(operatorId: string, id: string): Promise<Conversation>;
  botMessage(operatorId: string, id: string, body: string): Promise<unknown>;
  botHandoff(operatorId: string, id: string, note: string): Promise<unknown>;
  update(operatorId: string, id: string, patch: { status: 'closed' }): Promise<unknown>;
}

const MAX_STEPS = 40;
const TRACE = 30;
const BREAKER = 5;

/**
 * Motor de Tide. Cada conversación sin agente humano puede tener una sesión que recuerda en qué nodo va.
 * - Mensaje del contacto: si la sesión espera en una Pregunta, la respuesta elige el puerto; si no, arranca el primer
 *   flujo publicado cuyo inicio coincide (los de palabras clave tienen prioridad).
 * - Un agente que responde o se asigna la conversación detiene el bot; cerrar la conversación borra la sesión.
 * - Límite de pasos por turno (bucles) y cortacircuitos: 5 fallos seguidos desactivan el flujo.
 */
export class TideEngine {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly repo: TideRepository,
    private readonly inbox: TideInboxPort,
    private readonly opts: { logger: ModuleLogger; now?: () => Date },
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Serializa el trabajo por conversación (dos mensajes seguidos no pisan la sesión). */
  private lock(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
    this.locks.set(key, next);
    return next;
  }

  async onInboxEvent(e: InboxEvent): Promise<void> {
    const conv = e.conversation;
    if (e.type === 'closed') return this.repo.deleteSession(conv.id);
    if (e.type === 'agent_message') {
      const s = await this.repo.findSession(conv.id);
      if (s && s.status === 'waiting') await this.repo.saveSession({ ...s, status: 'handoff', updatedAt: this.now() });
      return;
    }
    return this.lock(conv.id, () => this.onContactMessage(conv, e.message.body));
  }

  private async onContactMessage(conv: Conversation, body: string): Promise<void> {
    if (conv.assigneeId) return;
    const s = await this.repo.findSession(conv.id);
    if (s?.status === 'handoff') return;
    if (s?.status === 'waiting') {
      const v = await this.repo.findVersion(s.flowId, s.version);
      const node = v?.graph.nodes.find((n) => n.id === s.nodeId);
      if (v && node?.type === 'ask') {
        const cfg = node.config as NodeConfig<'ask'>;
        const vars = cfg.saveAs ? { ...s.vars, [cfg.saveAs]: body.slice(0, 500) } : s.vars;
        const port = cfg.options.length ? matchOption(body, cfg.options) : 'other';
        return this.guard(s.flowId, conv.operatorId, () => this.run({ ...s, vars, expiresAt: undefined }, v.graph, conv, body, this.follow(v.graph, node, port)));
      }
    }
    const flow = await this.pickFlow(conv, body);
    if (!flow) return;
    const v = await this.repo.findVersion(flow.id, flow.publishedVersion!);
    const start = v?.graph.nodes.find((n) => n.type === 'trigger');
    if (!v || !start) return;
    const session: TideSession = { conversationId: conv.id, operatorId: conv.operatorId, flowId: flow.id, version: v.version, nodeId: start.id, status: 'done', vars: {}, trace: [], updatedAt: this.now() };
    await this.guard(flow.id, conv.operatorId, () => this.run(session, v.graph, conv, body, start.id));
  }

  /** Flujos activos y publicados del operador cuyo inicio acepta el canal; primero los que piden palabra clave. */
  private async pickFlow(conv: Conversation, body: string): Promise<TideFlow | null> {
    const text = ` ${normalize(body)} `;
    const candidates: Array<{ flow: TideFlow; keyword: boolean }> = [];
    for (const f of await this.repo.listFlows(conv.operatorId)) {
      if (!f.enabled || !f.publishedVersion) continue;
      const v = await this.repo.findVersion(f.id, f.publishedVersion);
      const t = v?.graph.nodes.find((n) => n.type === 'trigger');
      if (!t) continue;
      const cfg = t.config as NodeConfig<'trigger'>;
      if (!cfg.channels.includes(conv.channel)) continue;
      if (!cfg.keywords.length) candidates.push({ flow: f, keyword: false });
      else if (cfg.keywords.some((k) => text.includes(` ${normalize(k)} `))) candidates.push({ flow: f, keyword: true });
    }
    return (candidates.find((c) => c.keyword) ?? candidates[0])?.flow ?? null;
  }

  private follow(graph: FlowGraph, node: FlowNode, port: string): string | null {
    return graph.edges.find((e) => e.from === node.id && e.port === port)?.to ?? null;
  }

  /** Ejecuta desde `startId` hasta una Pregunta (espera), un traspaso, un cierre o el final del camino. */
  private async run(session: TideSession, graph: FlowGraph, conv: Conversation, body: string, startId: string | null): Promise<void> {
    const s: TideSession = { ...session, trace: [...session.trace] };
    const ctx = () => ({ contact: { name: conv.contactName, channel: conv.channel, playerId: conv.playerId ?? '' }, vars: s.vars, message: { body } });
    const send = (text: string) => this.inbox.botMessage(conv.operatorId, conv.id, text);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const finish = async (status: TideSession['status'], nodeId = s.nodeId) => {
      await this.repo.saveSession({ ...s, status, nodeId, trace: s.trace.slice(-TRACE), updatedAt: this.now() });
    };

    let cur = startId;
    for (let step = 0; step < MAX_STEPS; step++) {
      const node = cur ? byId.get(cur) : undefined;
      if (!node) return finish('done');
      s.trace.push(node.id);
      s.nodeId = node.id;
      let port = 'next';
      switch (node.type) {
        case 'trigger':
          break;
        case 'message':
          await send(render((node.config as NodeConfig<'message'>).text, ctx()));
          break;
        case 'ask': {
          const cfg = node.config as NodeConfig<'ask'>;
          const options = cfg.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
          await send(`${render(cfg.question, ctx())}${options ? `\n\n${options}` : ''}`);
          s.expiresAt = new Date(this.now().getTime() + cfg.timeoutMinutes * 60_000);
          return finish('waiting', node.id);
        }
        case 'condition': {
          const cfg = node.config as NodeConfig<'condition'>;
          port = compare(render(cfg.left, ctx()), cfg.operator, render(cfg.right, ctx())) ? 'true' : 'false';
          break;
        }
        case 'set_var': {
          const cfg = node.config as NodeConfig<'set_var'>;
          s.vars = { ...s.vars, [cfg.name]: render(cfg.value, ctx()).slice(0, 500) };
          break;
        }
        case 'faq': {
          const cfg = node.config as NodeConfig<'faq'>;
          const hit = bestFaq(body, cfg.entries, cfg.threshold);
          if (hit) await send(render(hit.a, ctx()));
          port = hit ? 'answered' : 'no_match';
          break;
        }
        case 'handoff':
          await this.inbox.botHandoff(conv.operatorId, conv.id, render((node.config as NodeConfig<'handoff'>).note, ctx()));
          return finish('handoff', node.id);
        case 'close': {
          const cfg = node.config as NodeConfig<'close'>;
          if (cfg.text) await send(render(cfg.text, ctx()));
          await finish('done', node.id);
          await this.inbox.update(conv.operatorId, conv.id, { status: 'closed' });
          return;
        }
      }
      cur = this.follow(graph, node, port);
    }
    this.opts.logger.warn('[tide] límite de pasos alcanzado (¿bucle sin pregunta?)', { flowId: s.flowId, conversationId: s.conversationId });
    return finish('done');
  }

  /** Errores del flujo: se registran, la sesión no queda colgada y 5 seguidos desactivan el flujo. */
  private async guard(flowId: string, operatorId: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.failures.delete(flowId);
    } catch (e) {
      const n = (this.failures.get(flowId) ?? 0) + 1;
      this.failures.set(flowId, n);
      this.opts.logger.error('[tide] fallo ejecutando flujo', { flowId, error: (e as Error).message, consecutive: n });
      if (n >= BREAKER) {
        const f = await this.repo.findFlow(operatorId, flowId);
        if (f?.enabled) await this.repo.saveFlow({ ...f, enabled: false, updatedAt: this.now() });
        this.failures.delete(flowId);
        this.opts.logger.error('[tide] flujo desactivado por fallos consecutivos', { flowId });
      }
    }
  }

  /** Esperas vencidas: siguen por el puerto "timeout" de su Pregunta (o terminan si no está conectado). */
  async tick(limit = 100): Promise<number> {
    const due = await this.repo.dueSessions(this.now(), limit);
    for (const d of due) {
      await this.lock(d.conversationId, async () => {
        const s = await this.repo.findSession(d.conversationId);
        if (!s || s.status !== 'waiting' || !s.expiresAt || s.expiresAt > this.now()) return;
        const v = await this.repo.findVersion(s.flowId, s.version);
        const node = v?.graph.nodes.find((n) => n.id === s.nodeId);
        let conv: Conversation;
        try {
          conv = await this.inbox.conversation(s.operatorId, s.conversationId);
        } catch {
          return this.repo.deleteSession(s.conversationId);
        }
        if (!v || !node) return this.repo.deleteSession(s.conversationId);
        if (conv.assigneeId || conv.status === 'closed') {
          await this.repo.saveSession({ ...s, status: conv.status === 'closed' ? 'done' : 'handoff', updatedAt: this.now() });
          return;
        }
        await this.guard(s.flowId, s.operatorId, () => this.run({ ...s, expiresAt: undefined }, v.graph, conv, '', this.follow(v.graph, node, 'timeout')));
      });
    }
    return due.length;
  }
}
