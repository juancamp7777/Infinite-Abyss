import { z } from 'zod';

/**
 * Catálogo de nodos de Tide. ÚNICA fuente de verdad: el motor valida con estos esquemas y el editor del backoffice
 * pinta los formularios a partir de `NODE_CATALOG` (GET /tide/v1/node-types), así UI y motor nunca discrepan.
 */

const text = (max = 2000) => z.string().trim().min(1).max(max);

export const NODE_SCHEMAS = {
  trigger: z.object({
    channels: z.array(z.enum(['webchat', 'whatsapp', 'telegram'])).min(1).default(['webchat', 'whatsapp', 'telegram']),
    /** Palabras clave (vacío = cualquier mensaje de una conversación sin agente humano). */
    keywords: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
  }),
  message: z.object({ text: text() }),
  ask: z.object({
    question: text(),
    /** Botones / opciones numeradas; cada una sale por su propio puerto. */
    options: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
    /** Variable donde se guarda la respuesta. */
    saveAs: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/).optional(),
    timeoutMinutes: z.number().int().min(1).max(10_080).default(30),
  }),
  condition: z.object({
    left: z.string().max(200),
    operator: z.enum(['eq', 'ne', 'contains', 'gt', 'lt', 'empty', 'not_empty', 'matches']),
    right: z.string().max(200).default(''),
  }),
  set_var: z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), value: z.string().max(500) }),
  faq: z.object({
    entries: z.array(z.object({ q: text(300), a: text() })).min(1).max(200),
    /** Similitud mínima (0-1) para responder sola. */
    threshold: z.number().min(0.1).max(1).default(0.35),
  }),
  handoff: z.object({ note: z.string().max(500).default('') }),
  close: z.object({ text: z.string().max(2000).default('') }),
} as const;

export type NodeType = keyof typeof NODE_SCHEMAS;
export type NodeConfig<T extends NodeType> = z.infer<(typeof NODE_SCHEMAS)[T]>;

export interface NodeDescriptor {
  type: NodeType;
  label: string;
  description: string;
  /** Puertos fijos de salida; `ask` añade uno por opción (`opt:0`, `opt:1`…). */
  ports: string[];
  dynamicPorts?: 'options';
  fields: Array<{ key: string; label: string; kind: 'text' | 'textarea' | 'number' | 'list' | 'channels' | 'select' | 'faq'; options?: string[]; hint?: string }>;
}

export const NODE_CATALOG: NodeDescriptor[] = [
  { type: 'trigger', label: 'Inicio', description: 'Arranca cuando un contacto escribe en un canal (opcionalmente con palabras clave).', ports: ['next'],
    fields: [{ key: 'channels', label: 'Canales', kind: 'channels' }, { key: 'keywords', label: 'Palabras clave', kind: 'list', hint: 'Vacío = cualquier mensaje' }] },
  { type: 'message', label: 'Mensaje', description: 'Envía un texto. Admite {{contact.name}}, {{vars.x}}, {{message.body}}.', ports: ['next'],
    fields: [{ key: 'text', label: 'Texto', kind: 'textarea' }] },
  { type: 'ask', label: 'Pregunta', description: 'Pregunta y espera la respuesta; cada opción sale por su puerto.', ports: ['other', 'timeout'], dynamicPorts: 'options',
    fields: [{ key: 'question', label: 'Pregunta', kind: 'textarea' }, { key: 'options', label: 'Opciones', kind: 'list' }, { key: 'saveAs', label: 'Guardar en variable', kind: 'text' }, { key: 'timeoutMinutes', label: 'Espera máxima (min)', kind: 'number' }] },
  { type: 'condition', label: 'Condición', description: 'Compara valores y sigue por sí o no.', ports: ['true', 'false'],
    fields: [{ key: 'left', label: 'Valor', kind: 'text', hint: 'p. ej. {{vars.monto}}' }, { key: 'operator', label: 'Operador', kind: 'select', options: ['eq', 'ne', 'contains', 'gt', 'lt', 'empty', 'not_empty', 'matches'] }, { key: 'right', label: 'Comparar con', kind: 'text' }] },
  { type: 'set_var', label: 'Variable', description: 'Guarda un valor en una variable del contacto.', ports: ['next'],
    fields: [{ key: 'name', label: 'Nombre', kind: 'text' }, { key: 'value', label: 'Valor', kind: 'text' }] },
  { type: 'faq', label: 'Preguntas frecuentes', description: 'Responde sola si el mensaje se parece a una pregunta conocida.', ports: ['answered', 'no_match'],
    fields: [{ key: 'entries', label: 'Preguntas y respuestas', kind: 'faq' }, { key: 'threshold', label: 'Similitud mínima', kind: 'number' }] },
  { type: 'handoff', label: 'Pasar a humano', description: 'Deja la conversación en la cola de agentes y detiene el bot.', ports: [],
    fields: [{ key: 'note', label: 'Nota interna para el agente', kind: 'textarea' }] },
  { type: 'close', label: 'Finalizar', description: 'Despide (opcional) y cierra la conversación.', ports: [],
    fields: [{ key: 'text', label: 'Despedida', kind: 'textarea' }] },
];

export const portsOf = (type: NodeType, config: Record<string, unknown>): string[] => {
  const d = NODE_CATALOG.find((n) => n.type === type)!;
  const opts = d.dynamicPorts === 'options' && Array.isArray(config.options) ? config.options.map((_, i) => `opt:${i}`) : [];
  return [...opts, ...d.ports];
};
