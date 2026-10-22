import { z } from 'zod';
import { NODE_SCHEMAS, portsOf, type NodeType } from './nodes';

export interface FlowNode {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  x: number;
  y: number;
}
export interface FlowEdge {
  from: string;
  port: string;
  to: string;
}
export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export const MAX_NODES = 80;

/** Forma del grafo (para guardar borradores incompletos; la configuración de cada nodo se valida al publicar). */
export const graphShape = z.object({
  nodes: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    type: z.enum(Object.keys(NODE_SCHEMAS) as [NodeType, ...NodeType[]]),
    config: z.record(z.string(), z.unknown()).default({}),
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
  })).max(MAX_NODES),
  edges: z.array(z.object({ from: z.string().max(40), port: z.string().max(20), to: z.string().max(40) })).max(MAX_NODES * 12),
});

export const emptyGraph = (): FlowGraph => ({ nodes: [{ id: 'start', type: 'trigger', config: { channels: ['webchat', 'whatsapp', 'telegram'], keywords: [] }, x: 80, y: 120 }], edges: [] });

/**
 * Validación estricta para publicar: un solo inicio, configuración válida por esquema, aristas a puertos existentes
 * (una por puerto), nada apunta al inicio y todos los nodos son alcanzables. Se permiten ciclos (menús que vuelven),
 * acotados en ejecución por el límite de pasos por turno.
 */
export function validateGraph(input: unknown): { graph: FlowGraph; errors: string[] } {
  const shape = graphShape.safeParse(input);
  if (!shape.success) return { graph: { nodes: [], edges: [] }, errors: shape.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const errors: string[] = [];
  const nodes: FlowNode[] = [];
  const ids = new Set<string>();
  for (const n of shape.data.nodes) {
    if (ids.has(n.id)) errors.push(`Id repetido: ${n.id}`);
    ids.add(n.id);
    const r = NODE_SCHEMAS[n.type].safeParse(n.config);
    if (!r.success) errors.push(`Nodo ${n.id} (${n.type}): ${r.error.issues.map((i) => `${i.path.join('.') || 'config'} ${i.message}`).join('; ')}`);
    nodes.push({ ...n, config: (r.success ? r.data : n.config) as Record<string, unknown> });
  }
  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length !== 1) errors.push('El flujo necesita exactamente un nodo de inicio');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (const e of shape.data.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) { errors.push(`Conexión a un nodo inexistente (${e.from} → ${e.to})`); continue; }
    if (!portsOf(from.type, from.config).includes(e.port)) errors.push(`El nodo ${from.id} no tiene la salida "${e.port}"`);
    if (to.type === 'trigger') errors.push('Nada puede volver al nodo de inicio');
    const key = `${e.from}:${e.port}`;
    if (seen.has(key)) errors.push(`La salida "${e.port}" de ${e.from} tiene más de una conexión`);
    seen.add(key);
  }
  if (triggers.length === 1) {
    const reach = new Set([triggers[0].id]);
    const queue = [triggers[0].id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of shape.data.edges) if (e.from === cur && !reach.has(e.to) && byId.has(e.to)) { reach.add(e.to); queue.push(e.to); }
    }
    for (const n of nodes) if (!reach.has(n.id)) errors.push(`El nodo ${n.id} no está conectado al inicio`);
    if (!shape.data.edges.some((e) => e.from === triggers[0].id)) errors.push('Conecta el inicio con el primer paso');
  }
  return { graph: { nodes, edges: shape.data.edges }, errors };
}

/* ───────────────────────── Plantillas {{ ruta }} ───────────────────────── */

const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);

/** Sustituye {{ a.b }} con valores del contexto. Sin eval: solo rutas de propiedades propias; desconocido → ''. */
export function render(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z_][\w.]{0,80})\s*\}\}/g, (_m, path: string) => {
    let cur: unknown = ctx;
    for (const key of path.split('.')) {
      if (BLOCKED.has(key) || cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) return '';
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur === null || cur === undefined || typeof cur === 'object' ? '' : String(cur).slice(0, 1000);
  });
}

/* ───────────────────────── Comparaciones y respuestas ───────────────────────── */

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
const num = (s: string) => {
  const n = Number(s.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export function compare(left: string, operator: string, right: string): boolean {
  switch (operator) {
    case 'eq': return normalize(left) === normalize(right);
    case 'ne': return normalize(left) !== normalize(right);
    case 'contains': return normalize(left).includes(normalize(right));
    case 'gt': return num(left) > num(right);
    case 'lt': return num(left) < num(right);
    case 'empty': return left.trim() === '';
    case 'not_empty': return left.trim() !== '';
    case 'matches':
      // Sin cuantificadores anidados tipo (a+)+ (retroceso catastrófico).
      if (right.length > 100 || /\([^)]*[+*}][^)]*\)[+*{]/.test(right)) return false;
      try {
        return new RegExp(right, 'i').test(left.slice(0, 500));
      } catch {
        return false;
      }
    default: return false;
  }
}

/** Puerto de una pregunta según la respuesta: texto igual a una opción, su número (1, 2…) o la opción contenida. */
export function matchOption(reply: string, options: string[]): string {
  const r = normalize(reply);
  if (!r) return 'other';
  const asNum = /^\d{1,2}$/.test(r) ? Number(r) - 1 : -1;
  if (asNum >= 0 && asNum < options.length) return `opt:${asNum}`;
  const exact = options.findIndex((o) => normalize(o) === r);
  if (exact >= 0) return `opt:${exact}`;
  const partial = options.findIndex((o) => normalize(o).length >= 3 && r.includes(normalize(o)));
  return partial >= 0 ? `opt:${partial}` : 'other';
}

const trigrams = (s: string) => {
  const t = new Set<string>();
  const p = `  ${s} `;
  for (let i = 0; i < p.length - 2; i++) t.add(p.slice(i, i + 3));
  return t;
};
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

/** Similitud 0-1 entre textos: media de Jaccard por palabras y Dice por trigramas (robusta a errores de tipeo). */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  const jaccard = overlap(wa, wb) / (wa.size + wb.size - overlap(wa, wb));
  const ta = trigrams(na);
  const tb = trigrams(nb);
  const dice = (2 * overlap(ta, tb)) / (ta.size + tb.size);
  return (jaccard + dice) / 2;
}

export function bestFaq(question: string, entries: Array<{ q: string; a: string }>, threshold: number): { a: string; score: number } | null {
  let best: { a: string; score: number } | null = null;
  for (const e of entries) {
    const score = similarity(question, e.q);
    if (!best || score > best.score) best = { a: e.a, score };
  }
  return best && best.score >= threshold ? best : null;
}
