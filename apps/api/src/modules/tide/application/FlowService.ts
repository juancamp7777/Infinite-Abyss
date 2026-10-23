import { randomUUID } from 'crypto';
import { HttpError } from '../../shared/http/errors';
import { emptyGraph, graphShape, validateGraph, type FlowGraph } from '../domain/graph';
import type { TideFlow, TideRepository } from '../domain/types';

/** Plantilla de arranque: bienvenida, menú, preguntas frecuentes y paso a humano. */
export function welcomeTemplate(): FlowGraph {
  return {
    nodes: [
      { id: 'start', type: 'trigger', config: { channels: ['webchat', 'whatsapp', 'telegram'], keywords: [] }, x: 40, y: 200 },
      { id: 'hello', type: 'message', config: { text: '¡Hola {{contact.name}}! 👋 Soy el asistente virtual.' }, x: 300, y: 200 },
      { id: 'menu', type: 'ask', config: { question: '¿En qué te ayudo? Elige una opción o escribe tu pregunta.', options: ['Depósitos', 'Retiros', 'Hablar con un agente'], saveAs: 'motivo', timeoutMinutes: 30 }, x: 560, y: 200 },
      { id: 'deposit', type: 'message', config: { text: 'Para recargar, haz tu transferencia y envíame aquí la foto del comprobante 📸. La verificamos y te acreditamos en minutos. También puedes depositar desde Caja → Depositar.' }, x: 860, y: 20 },
      { id: 'w_amount', type: 'ask', config: { question: '¿Cuánto quieres retirar? Escribe solo el número.', options: [], saveAs: 'monto', timeoutMinutes: 15 }, x: 860, y: 140 },
      { id: 'w_account', type: 'ask', config: { question: '¿A qué cuenta te lo enviamos? (Nequi, Daviplata, cuenta bancaria, CBU/CVU o alias)', options: [], saveAs: 'cuenta', timeoutMinutes: 15 }, x: 1120, y: 140 },
      { id: 'w_holder', type: 'ask', config: { question: '¿Nombre completo del titular de esa cuenta?', options: [], saveAs: 'titular', timeoutMinutes: 15 }, x: 1380, y: 140 },
      { id: 'withdraw', type: 'withdraw', config: { amountVar: 'monto', accountVar: 'cuenta', holderVar: 'titular' }, x: 1640, y: 140 },
      { id: 'faq', type: 'faq', config: { threshold: 0.35, entries: [
        { q: '¿Cuánto tarda un depósito?', a: 'Los depósitos se acreditan al instante una vez confirmado el pago.' },
        { q: '¿Cuánto tarda un retiro?', a: 'Los retiros se procesan en menos de 24 horas hábiles.' },
        { q: '¿Cómo activo un bono?', a: 'Los bonos se activan desde Promociones antes de depositar.' },
      ] }, x: 860, y: 280 },
      { id: 'more', type: 'ask', config: { question: '¿Te ayudo con algo más?', options: ['Sí', 'No, gracias'], timeoutMinutes: 15 }, x: 1160, y: 120 },
      { id: 'human', type: 'handoff', config: { note: 'Motivo: {{vars.motivo}}' }, x: 1160, y: 380 },
      { id: 'bye', type: 'close', config: { text: '¡Gracias por escribirnos! Aquí estamos cuando nos necesites. 🌊' }, x: 1440, y: 200 },
    ],
    edges: [
      { from: 'start', port: 'next', to: 'hello' },
      { from: 'hello', port: 'next', to: 'menu' },
      { from: 'menu', port: 'opt:0', to: 'deposit' },
      { from: 'menu', port: 'opt:1', to: 'w_amount' },
      { from: 'w_amount', port: 'other', to: 'w_account' },
      { from: 'w_account', port: 'other', to: 'w_holder' },
      { from: 'w_holder', port: 'other', to: 'withdraw' },
      { from: 'menu', port: 'opt:2', to: 'human' },
      { from: 'menu', port: 'other', to: 'faq' },
      { from: 'menu', port: 'timeout', to: 'bye' },
      { from: 'deposit', port: 'next', to: 'more' },

      { from: 'faq', port: 'answered', to: 'more' },
      { from: 'faq', port: 'no_match', to: 'human' },
      { from: 'more', port: 'opt:0', to: 'menu' },
      { from: 'more', port: 'opt:1', to: 'bye' },
      { from: 'more', port: 'other', to: 'human' },
      { from: 'more', port: 'timeout', to: 'bye' },
    ],
  };
}

/** Flujos de Tide: borrador editable, publicación validada en versiones inmutables y activación. */
export class FlowService {
  constructor(private readonly repo: TideRepository) {}

  list(operatorId: string) {
    return this.repo.listFlows(operatorId);
  }

  async get(operatorId: string, id: string) {
    const f = await this.repo.findFlow(operatorId, id);
    if (!f) throw new HttpError(404, 'NOT_FOUND', 'Flujo no encontrado');
    return f;
  }

  async create(operatorId: string, name: string, template: 'blank' | 'welcome'): Promise<TideFlow> {
    if ((await this.repo.listFlows(operatorId)).length >= 50) throw new HttpError(409, 'LIMIT', 'Máximo 50 flujos por operador');
    const now = new Date();
    return this.repo.saveFlow({ id: randomUUID(), operatorId, name: name.trim().slice(0, 80) || 'Flujo sin nombre', enabled: false, draft: template === 'welcome' ? welcomeTemplate() : emptyGraph(), createdAt: now, updatedAt: now });
  }

  /** Guarda el borrador (puede estar incompleto: la validación estricta es al publicar). */
  async saveDraft(operatorId: string, id: string, patch: { name?: string; draft?: unknown }): Promise<TideFlow> {
    const f = await this.get(operatorId, id);
    const next: TideFlow = { ...f, updatedAt: new Date() };
    if (patch.name !== undefined) next.name = patch.name.trim().slice(0, 80) || f.name;
    if (patch.draft !== undefined) {
      const r = graphShape.safeParse(patch.draft);
      if (!r.success) throw new HttpError(400, 'BAD_REQUEST', 'Grafo inválido', r.error.issues.slice(0, 10));
      next.draft = r.data as FlowGraph;
    }
    return this.repo.saveFlow(next);
  }

  async validate(operatorId: string, id: string): Promise<string[]> {
    return validateGraph((await this.get(operatorId, id)).draft).errors;
  }

  /** Publica el borrador como nueva versión; las conversaciones en curso terminan con la versión que empezaron. */
  async publish(operatorId: string, id: string, userId: string): Promise<TideFlow> {
    const f = await this.get(operatorId, id);
    const { graph, errors } = validateGraph(f.draft);
    if (errors.length) throw new HttpError(422, 'INVALID_FLOW', 'El flujo tiene errores', errors);
    const version = (f.publishedVersion ?? 0) + 1;
    await this.repo.saveVersion({ flowId: f.id, version, graph, publishedBy: userId, createdAt: new Date() });
    return this.repo.saveFlow({ ...f, publishedVersion: version, enabled: true, updatedAt: new Date() });
  }

  async setEnabled(operatorId: string, id: string, enabled: boolean): Promise<TideFlow> {
    const f = await this.get(operatorId, id);
    if (enabled && !f.publishedVersion) throw new HttpError(409, 'NOT_PUBLISHED', 'Publica el flujo antes de activarlo');
    return this.repo.saveFlow({ ...f, enabled, updatedAt: new Date() });
  }

  async remove(operatorId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteFlow(operatorId, id))) throw new HttpError(404, 'NOT_FOUND', 'Flujo no encontrado');
  }
}
