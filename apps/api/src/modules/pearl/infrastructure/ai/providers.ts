import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ExtractedReceipt } from '../../domain/types';

/** Proveedores de IA de Pearl. anthropic = SDK oficial; gemini/deepseek = API compatible con OpenAI. */
export type AiProviderName = 'anthropic' | 'gemini' | 'deepseek';

export const AI_DEFAULTS: Record<AiProviderName, { reader: string; judge: string; baseUrl?: string }> = {
  anthropic: { reader: 'claude-haiku-5-5', judge: 'claude-opus-5-5' },
  gemini: { reader: 'gemini-2.5-flash', judge: 'gemini-2.5-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  deepseek: { reader: 'deepseek-v4-flash-vision-exp', judge: 'deepseek-v4-flash-vision-exp', baseUrl: 'https://api.deepseek.com/v1' },
};

export const ReceiptSchema = z.object({
  is_completed_transfer_receipt: z.boolean(),
  amount: z.string(),
  date: z.string(),
  time: z.string(),
  sender_name: z.string(),
  sender_tax_id: z.string(),
  receiver_account: z.string(),
  asset: z.string(),
  tx_id: z.string(),
  tamper_signals: z.array(z.string()),
});
export const VerdictSchema = z.object({ approve: z.boolean(), reason: z.string() });

export const READER_PROMPT = `Lees comprobantes de transferencias bancarias o de billeteras virtuales (Latinoamérica) que los jugadores envían para cargar saldo.
Devuelve exactamente los datos visibles, sin inventar:
- is_completed_transfer_receipt: true solo si es el comprobante de una transferencia YA REALIZADA. false si es la pantalla previa de "confirmar/revisar transferencia", un chat, un saldo, una foto de otra cosa o está ilegible.
- amount: el monto transferido tal como aparece (con sus separadores).
- date: fecha de la operación en formato YYYY-MM-DD ("" si no aparece).
- time: hora de la operación en formato HH:MM de 24 h ("" si no aparece).
- sender_name: titular de la cuenta ORIGEN (quien paga), nunca el destinatario. "" si no aparece.
- sender_tax_id: CUIT/CUIL/documento del que paga ("" si no aparece).
- receiver_account: cuenta DESTINO tal como se ve, aunque esté parcial: CBU/CVU o alias (Argentina), número de cuenta, llave o celular Nequi/Daviplata (Colombia), o la dirección de la billetera si es cripto ("" si no aparece).
- asset: "USDT" si es un envío/retiro de USDT (Binance u otra billetera cripto); "" si es dinero en pesos.
- tx_id: el TxID / hash de la transacción si aparece (en Binance: "TxID" o "Transferencia interna" con su número); "" si no aparece.
- tamper_signals: solo indicios CLAROS de edición (tipografías o alineaciones distintas en el monto o la fecha, números superpuestos, recortes sobre datos clave). Lista vacía si no hay evidencia.`;

export const JUDGE_PROMPT = `Eres el juez de una caja de casino. Una regla automática quiere acreditar un depósito porque el comprobante coincide con un pago real del banco.
Revisa la coherencia de todo: monto, titular del comprobante vs. titular del pago bancario, nombres que el jugador usó antes, fecha y los controles.
Aprueba si todo es coherente. Rechaza (approve=false) ante cualquier incoherencia o señal de fraude, explicando el motivo en una frase corta en español.`;

const toExtracted = (r: z.infer<typeof ReceiptSchema>): ExtractedReceipt => ({
  amount: r.amount.trim(),
  ...(r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? { date: r.date } : {}),
  ...(r.time && /^\d{2}:\d{2}$/.test(r.time) ? { time: r.time } : {}),
  senderName: r.sender_name.trim().slice(0, 120),
  ...(r.sender_tax_id.trim() ? { senderTaxId: r.sender_tax_id.trim().slice(0, 30) } : {}),
  ...(r.receiver_account.trim() ? { receiverAccount: r.receiver_account.trim().slice(0, 60) } : {}),
  ...(/usdt/i.test(r.asset) ? { asset: 'USDT' as const } : {}),
  ...(r.tx_id.trim() ? { txId: r.tx_id.trim().slice(0, 120) } : {}),
  notAReceipt: !r.is_completed_transfer_receipt,
  tamperSignals: r.tamper_signals.map((s) => s.slice(0, 200)).slice(0, 10),
});

export interface PearlAiClient {
  readReceipt(image: Buffer, mime: string): Promise<ExtractedReceipt>;
  judge(context: string): Promise<{ approve: boolean; reason: string }>;
}

/** Claude con salidas estructuradas (Zod). Esfuerzo bajo: lectura y juicio rápidos. */
export class AnthropicPearlAi implements PearlAiClient {
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly models: { reader: string; judge: string }, client?: Anthropic) {
    this.client = client ?? new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }

  async readReceipt(image: Buffer, mime: string): Promise<ExtractedReceipt> {
    const res = await this.client.messages.parse({
      model: this.models.reader,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(ReceiptSchema) },
      system: READER_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp', data: image.toString('base64') } },
        { type: 'text', text: 'Extrae los datos de este comprobante.' },
      ] }],
    });
    if (res.stop_reason === 'refusal' || !res.parsed_output) throw new Error(`lectura no disponible (${res.stop_reason})`);
    return toExtracted(res.parsed_output);
  }

  async judge(context: string) {
    const res = await this.client.messages.parse({
      model: this.models.judge,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(VerdictSchema) },
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: context }],
    });
    // Rechazo de seguridad o salida inválida = veto (el caso pasa a un humano).
    if (res.stop_reason === 'refusal' || !res.parsed_output) return { approve: false, reason: `juez sin respuesta (${res.stop_reason})` };
    return res.parsed_output;
  }
}

/** Gemini y DeepSeek por su API compatible con OpenAI (Chat Completions + JSON). */
export class OpenAiCompatiblePearlAi implements PearlAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly models: { reader: string; judge: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async chat<T>(model: string, system: string, content: unknown, schema: z.ZodType<T>, shape: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${system}\nResponde SOLO un JSON con esta forma: ${shape}` }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`proveedor de IA respondió ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content ?? '';
    return schema.parse(JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim()));
  }

  async readReceipt(image: Buffer, mime: string): Promise<ExtractedReceipt> {
    const shape = '{"is_completed_transfer_receipt":bool,"amount":str,"date":str,"time":str,"sender_name":str,"sender_tax_id":str,"receiver_account":str,"tamper_signals":[str]}';
    const r = await this.chat(this.models.reader, READER_PROMPT, [
      { type: 'text', text: 'Extrae los datos de este comprobante.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
    ], ReceiptSchema, shape);
    return toExtracted(r);
  }

  async judge(context: string) {
    try {
      return await this.chat(this.models.judge, JUDGE_PROMPT, context, VerdictSchema, '{"approve":bool,"reason":str}');
    } catch (e) {
      return { approve: false, reason: `juez sin respuesta (${(e as Error).message})` };
    }
  }
}
