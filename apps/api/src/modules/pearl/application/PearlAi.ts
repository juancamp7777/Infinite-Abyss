import type { InboxEvent } from '../../inbox/application/InboxService';
import type { SecretBox } from '../../inbox/domain/secretBox';
import type { Attachment, Conversation } from '../../inbox/domain/types';
import type { ModuleLogger } from '../../shared/module';
import { isWalletOrOwnName, nameTokens } from '../domain/matching';
import type { AiConfig, BankTx, ExtractedReceipt, PearlRepository, PearlSettings, Receipt } from '../domain/types';
import { AI_DEFAULTS, AnthropicPearlAi, OpenAiCompatiblePearlAi, type AiProviderName, type PearlAiClient } from '../infrastructure/ai/providers';
import type { PearlService } from './PearlService';

export interface AiConfigView {
  enabled: boolean;
  provider: AiProviderName;
  readerModel: string;
  judgeModel: string;
  hasKey: boolean;
  /** La clave viene del entorno del servidor (no del operador). */
  keyFromEnv: boolean;
}

export type AiClientFactory = (provider: AiProviderName, apiKey: string, models: { reader: string; judge: string }) => PearlAiClient;

const defaultFactory: AiClientFactory = (provider, apiKey, models) =>
  provider === 'anthropic' ? new AnthropicPearlAi(apiKey, models) : new OpenAiCompatiblePearlAi(apiKey, AI_DEFAULTS[provider].baseUrl!, models);

interface InboxPort {
  attachment(operatorId: string, id: string): Promise<Attachment>;
}

/**
 * IA de Pearl:
 * - Una imagen del contacto se lee con el modelo lector y entra a Pearl como comprobante (si no hay IA, va a lectura manual).
 * - Si Pearl pidió el titular, la siguiente respuesta de texto del contacto completa el comprobante y se vuelve a conciliar.
 * - Antes de acreditar sola, el modelo juez revisa la coherencia y puede vetar.
 * El trabajo con IA corre en segundo plano (el webhook o la subida responden al instante).
 */
export class PearlAi {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly repo: PearlRepository,
    private readonly pearl: PearlService,
    private readonly inbox: InboxPort,
    private readonly box: SecretBox,
    private readonly opts: { logger: ModuleLogger; envKey?: string; keyResolver?: (operatorId: string, provider: AiProviderName) => Promise<string | undefined>; factory?: AiClientFactory; ensurePlayer?: () => ((conv: Conversation, name: string) => Promise<{ playerId: string }>) | undefined },
  ) {
    pearl.setJudge((ctx) => this.judge(ctx));
  }

  async config(operatorId: string): Promise<AiConfigView> {
    const c = await this.stored(operatorId);
    const shared = !c.keyEnc && !!(await this.sharedKey(operatorId, c.provider));
    return { enabled: c.enabled, provider: c.provider, readerModel: c.readerModel, judgeModel: c.judgeModel, hasKey: !!c.keyEnc || shared || this.envKeyApplies(c), keyFromEnv: !c.keyEnc && (shared || this.envKeyApplies(c)) };
  }

  /** Llave conectada en Integraciones (del casino o de la plataforma) para este proveedor de IA. */
  private async sharedKey(operatorId: string, provider: AiProviderName): Promise<string | undefined> {
    return this.opts.keyResolver?.(operatorId, provider).catch(() => undefined);
  }

  async saveConfig(operatorId: string, patch: { enabled?: boolean; provider?: AiProviderName; readerModel?: string; judgeModel?: string; apiKey?: string | null }): Promise<AiConfigView> {
    const cur = await this.stored(operatorId);
    const provider = patch.provider ?? cur.provider;
    const changedProvider = provider !== cur.provider;
    const next: AiConfig = {
      ...cur, provider, updatedAt: new Date(),
      enabled: patch.enabled ?? cur.enabled,
      readerModel: patch.readerModel ?? (changedProvider ? AI_DEFAULTS[provider].reader : cur.readerModel),
      judgeModel: patch.judgeModel ?? (changedProvider ? AI_DEFAULTS[provider].judge : cur.judgeModel),
    };
    if (patch.apiKey === null) delete next.keyEnc;
    else if (patch.apiKey) next.keyEnc = this.box.seal(patch.apiKey);
    else if (changedProvider) delete next.keyEnc; // una clave de otro proveedor no sirve
    await this.repo.saveAi(next);
    return this.config(operatorId);
  }

  /** Listener de Sonar (prioridad sobre Tide): consume imágenes y respuestas de titular pendientes. */
  async onInboxEvent(e: InboxEvent): Promise<'handled' | void> {
    if (e.type !== 'contact_message') return;
    const conv = e.conversation;
    if (e.message.attachmentId) {
      this.background(() => this.processImage(conv, e.message.attachmentId!));
      return 'handled';
    }
    const last = await this.repo.latestReceiptForConversation(conv.operatorId, conv.id);
    const text = e.message.body.trim();
    if (last?.status === 'needs_info' && text.length <= 80 && nameTokens(text).length >= 2 && !/\d{3,}/.test(text)) {
      this.background(async () => {
        await this.pearl.updateExtracted(conv.operatorId, last.id, { ...last.extracted, senderName: text });
      });
      return 'handled';
    }
  }

  /** Espera el trabajo en segundo plano (pruebas y apagado ordenado). */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private background(fn: () => Promise<void>) {
    const p: Promise<void> = fn()
      .catch((err: Error) => {
        this.opts.logger.error('[pearl] tarea de IA fallida', { error: err.message });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async processImage(conv: Conversation, attachmentId: string) {
    const att = await this.inbox.attachment(conv.operatorId, attachmentId);
    const client = await this.client(conv.operatorId);
    let extracted: ExtractedReceipt = { amount: '', senderName: '' };
    if (client) {
      try {
        extracted = await client.readReceipt(att.data, att.mime);
      } catch (err) {
        this.opts.logger.warn('[pearl] lectura con IA fallida: queda para lectura manual', { conversationId: conv.id, error: (err as Error).message });
      }
    }
    // Lead nuevo con un comprobante legible: se le crea la cuenta (como hacía la caja anterior) antes de conciliar.
    let playerId = conv.playerId;
    const ensure = this.opts.ensurePlayer?.();
    if (!playerId && ensure && extracted.amount && !extracted.notAReceipt && (await this.pearl.settings(conv.operatorId)).autoRegisterLeads) {
      const name = extracted.senderName && !isWalletOrOwnName(extracted.senderName, []) ? extracted.senderName : conv.contactName;
      playerId = await ensure(conv, name).then((r) => r.playerId).catch((err: Error) => {
        this.opts.logger.warn('[pearl] alta automática del lead fallida', { conversationId: conv.id, error: err.message });
        return undefined;
      });
    }
    await this.pearl.submit({ operatorId: conv.operatorId, conversationId: conv.id, playerId, image: att.data, attachmentId: att.id, extracted, source: client ? 'ai' : 'manual' });
  }

  private async judge(ctx: { receipt: Receipt; bankTx: BankTx; settings: PearlSettings }): Promise<{ approve: boolean; reason?: string }> {
    const client = await this.client(ctx.receipt.operatorId);
    if (!client) return { approve: true }; // sin IA deciden solo las reglas deterministas
    const known = ctx.receipt.playerId ? await this.repo.knownSenderNames(ctx.receipt.operatorId, ctx.receipt.playerId) : [];
    const context = JSON.stringify({
      comprobante: { ...ctx.receipt.extracted, montoUnidadesMinimas: ctx.receipt.amount?.toString(), moneda: ctx.receipt.currency },
      controles: ctx.receipt.checks,
      pagoBancario: { monto: ctx.bankTx.amount.toString(), titular: ctx.bankTx.senderName, documento: ctx.bankTx.senderTaxId ?? null, fecha: ctx.bankTx.occurredAt.toISOString() },
      titularesAnterioresDelJugador: known,
    });
    return client.judge(context);
  }

  private envKeyApplies(c: AiConfig) {
    return c.provider === 'anthropic' && !!this.opts.envKey;
  }

  private async stored(operatorId: string): Promise<AiConfig> {
    return (await this.repo.getAi(operatorId)) ?? { operatorId, enabled: true, provider: 'anthropic', readerModel: AI_DEFAULTS.anthropic.reader, judgeModel: AI_DEFAULTS.anthropic.judge, updatedAt: new Date() };
  }

  private async client(operatorId: string): Promise<PearlAiClient | null> {
    const c = await this.stored(operatorId);
    if (!c.enabled) return null;
    const key = c.keyEnc ? this.box.open<string>(c.keyEnc) : (await this.sharedKey(operatorId, c.provider)) ?? (this.envKeyApplies(c) ? this.opts.envKey! : null);
    return key ? (this.opts.factory ?? defaultFactory)(c.provider, key, { reader: c.readerModel, judge: c.judgeModel }) : null;
  }
}
