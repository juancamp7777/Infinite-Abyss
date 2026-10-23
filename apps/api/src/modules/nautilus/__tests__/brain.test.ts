import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeBrain, type ReadOnlyTool } from '../infrastructure/brain';

/** Cliente de Anthropic simulado: devuelve respuestas en orden y guarda lo que se le pidió. */
function fakeClient(replies: Array<Partial<Anthropic.Message>>) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (p: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(p));
        return replies.shift();
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const tool = (name: string, run: ReadOnlyTool['run']): ReadOnlyTool => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, run });

describe('Nautilus: ciclo de herramientas con Claude', () => {
  it('ejecuta la herramienta pedida, le devuelve el resultado y entrega el texto final', async () => {
    const { client, calls } = fakeClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'kpis', input: { days: 1 } } as Anthropic.ToolUseBlock] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ayer el GGR fue 400.000 COP.' } as Anthropic.TextBlock] },
    ]);
    const seen: unknown[] = [];
    const brain = new ClaudeBrain('k', 'claude-opus-5-5', client);
    const answer = await brain.ask('¿Cómo fue ayer?', 'Casino X', [tool('kpis', async (i) => { seen.push(i); return [{ ggr: '400.000 COP' }]; })]);
    expect(answer).toBe('Ayer el GGR fue 400.000 COP.');
    expect(seen).toEqual([{ days: 1 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, tools: [{ name: 'kpis' }] });
    const last = calls[1].messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '[{"ggr":"400.000 COP"}]' }]);
  });

  it('herramienta desconocida o con error: se informa a Claude sin romper; negativa = respuesta segura', async () => {
    const { client, calls } = fakeClient([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'borrar_todo', input: {} } as Anthropic.ToolUseBlock, { type: 'tool_use', id: 'b', name: 'kpis', input: {} } as Anthropic.ToolUseBlock] },
      { stop_reason: 'refusal', content: [] },
    ]);
    const brain = new ClaudeBrain('k', 'm', client);
    const answer = await brain.ask('?', '', [tool('kpis', async () => { throw new Error('base caída'); })]);
    expect(answer).toBe('No puedo responder esa pregunta.');
    expect(calls[1].messages.at(-1)!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: '{"error":"herramienta desconocida"}' },
      { type: 'tool_result', tool_use_id: 'b', content: 'Error: base caída', is_error: true },
    ]);
  });

  it('corta si Claude pide herramientas sin parar', async () => {
    const loop = Array.from({ length: 10 }, (_, i) => ({ stop_reason: 'tool_use' as const, content: [{ type: 'tool_use', id: `x${i}`, name: 'kpis', input: {} } as Anthropic.ToolUseBlock] }));
    const { client, calls } = fakeClient(loop);
    const answer = await new ClaudeBrain('k', 'm', client).ask('?', '', [tool('kpis', async () => 1)]);
    expect(answer).toContain('demasiados pasos');
    expect(calls).toHaveLength(8);
  });
});
