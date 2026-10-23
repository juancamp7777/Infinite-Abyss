import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/**
 * Cerebro de Nautilus sobre Claude (Anthropic SDK). Dos usos:
 * - briefing: resumen diario con salida estructurada (Zod) a partir de cifras y hallazgos ya calculados.
 * - ask: preguntas del operador con herramientas de SOLO LECTURA (ciclo manual de tool use, máx. 8 vueltas).
 * Nautilus nunca ejecuta acciones: recomienda, y lo que mueve dinero lo decide una persona.
 */

export const NAUTILUS_MODEL = 'claude-opus-5-5';

export const BriefingSchema = z.object({
  headline: z.string().describe('Una frase con lo más importante del día'),
  summary: z.string().describe('Dos o tres párrafos cortos sobre cómo fue el día'),
  risks: z.array(z.object({ title: z.string(), detail: z.string(), severity: z.enum(['info', 'warn', 'high']) })).max(6),
  recommendations: z.array(z.object({ action: z.string(), why: z.string() })).max(6),
});
export type Briefing = z.infer<typeof BriefingSchema>;

export interface ReadOnlyTool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool.InputSchema;
  run(input: Record<string, unknown>): Promise<unknown>;
}

export interface NautilusBrain {
  briefing(data: unknown): Promise<Briefing>;
  ask(question: string, context: string, tools: ReadOnlyTool[]): Promise<string>;
}

export type BrainFactory = (apiKey: string) => NautilusBrain;

const SYSTEM = `Eres Nautilus, el operador de inteligencia artificial de un casino online de la plataforma Infinite Abyss.
Hablas en español neutro, claro y directo, para el dueño del casino.
Reglas:
- Usa SOLO los datos que te entregan o que obtienes con las herramientas. Si un dato no está, dilo; nunca inventes cifras.
- Las cantidades de dinero vienen formateadas con su moneda: respétalas.
- No puedes ejecutar acciones. Recomiendas qué hacer y dónde (Sonar · Inbox, Pearl · Caja, retiros, Integraciones).
- Cualquier cosa que mueva dinero (retiros, ajustes, bonos) la decide una persona del equipo.
- Sé breve: prioriza lo urgente y lo que más dinero o jugadores afecta.`;

export class ClaudeBrain implements NautilusBrain {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = NAUTILUS_MODEL, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  }

  async briefing(data: unknown): Promise<Briefing> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: 'medium', format: zodOutputFormat(BriefingSchema) },
      messages: [{ role: 'user', content: `Redacta el resumen del día con estos datos (JSON):\n${JSON.stringify(data)}` }],
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`Claude no generó el resumen (${res.stop_reason})`);
    return res.parsed_output;
  }

  async ask(question: string, context: string, tools: ReadOnlyTool[]): Promise<string> {
    const defs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `${context}\n\nPregunta: ${question}` }];
    for (let turn = 0; turn < 8; turn++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: SYSTEM,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        tools: defs,
        messages,
      });
      if (res.stop_reason === 'refusal') return 'No puedo responder esa pregunta.';
      const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) {
        const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
        return text || 'No encontré una respuesta con los datos disponibles.';
      }
      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of calls) {
        const tool = tools.find((t) => t.name === call.name);
        try {
          const out = tool ? await tool.run((call.input ?? {}) as Record<string, unknown>) : { error: 'herramienta desconocida' };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out).slice(0, 20_000) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `Error: ${e instanceof Error ? e.message : 'falló la consulta'}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return 'La consulta necesitó demasiados pasos; prueba con una pregunta más concreta.';
  }
}

export const defaultBrainFactory: BrainFactory = (apiKey) => new ClaudeBrain(apiKey);
