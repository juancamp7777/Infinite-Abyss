import { randomBytes } from 'crypto';
import { currencyDecimals } from '../../domain/money/currencies';
import { SecretBox } from '../inbox/domain/secretBox';
import type { InboxService } from '../inbox/application/InboxService';
import type { NymfoModule } from '../shared/module';
import type { ExternalDepositPort } from '../shared/ports/ExternalDepositPort';
import { ChatCashier } from './application/ChatCashier';
import { PearlAi, type AiClientFactory } from './application/PearlAi';
import { formatMoney } from './domain/money';
import type { LeadService } from '../inbox/application/LeadService';
import type { PlayerAccountsPort } from '../shared/ports/PlayerAccountsPort';
import { PearlService, type PearlOutcome } from './application/PearlService';
import type { PearlRepository, Receipt } from './domain/types';
import { buildPearlRouter } from './http/routes';
import { InMemoryPearlRepository } from './infrastructure/InMemoryPearlRepository';
import { PrismaPearlRepository, type PearlPrismaLike } from './infrastructure/PrismaPearlRepository';
import type { IntegrationsPort } from '../shared/ports/IntegrationsPort';

export const PEARL_PREFIX = '/pearl/v1';

export interface PearlModuleOptions {
  repo?: PearlRepository;
  deposits?: ExternalDepositPort;
  /** Barrido de comprobantes esperando al banco (ms); 0 = apagado. Por defecto PEARL_TICK_MS o 60000. */
  tickMs?: number;
  /** Clientes de IA (las pruebas inyectan uno falso). */
  aiFactory?: AiClientFactory;
}

const formatAmount = (r: Receipt) => (r.amount === undefined ? '' : formatMoney(r.amount, r.currency));
/** Mensajes al contacto por cada desenlace (el equipo ve además la nota interna en Sonar). */
export function pearlMessage(r: Receipt, outcome: PearlOutcome): string {
  switch (outcome) {
    case 'credited': return `✅ ¡Listo! Acreditamos ${formatAmount(r)} en tu cuenta. ¡Mucha suerte! 🍀`;
    case 'waiting_bank': return '⏳ Recibimos tu comprobante. Estamos esperando que el pago se refleje en el banco; te avisamos apenas se acredite.';
    case 'pending_review': return '🧾 Recibimos tu comprobante. Lo está revisando el equipo y te confirmamos en unos minutos.';
    case 'needs_info': return 'Para confirmar tu pago necesito el nombre completo del titular de la cuenta desde la que transferiste. 🙏';
    case 'duplicate': return 'Ese comprobante ya lo recibimos y está en proceso. En breve te confirmamos. 🙏';
    case 'rejected':
      return r.reason === 'no_es_comprobante'
        ? 'Esa imagen no parece el comprobante final. Envíanos la captura del comprobante de la transferencia ya realizada, por favor.'
        : 'No pudimos validar ese comprobante. Un asesor te va a escribir por aquí.';
  }
}

/**
 * Pearl: caja asistida. Concilia comprobantes contra los movimientos reales del banco (feeds Quikipay, HG Cash o genérico),
 * acredita sola cuando todo cuadra (modo auto, bajo el tope) y deja el resto en la cola de revisión humana.
 * Usa 'cashier.externalDeposits' (ledger real) y avisa al contacto por Sonar. HTTP en /pearl/v1. Servicio: 'pearl.service'.
 */
export function createPearlModule(opts: PearlModuleOptions = {}): NymfoModule {
  return {
    name: 'pearl',
    async register(app, _io, deps) {
      const repo = opts.repo ?? (deps.prisma ? new PrismaPearlRepository(deps.prisma as PearlPrismaLike) : new InMemoryPearlRepository());
      const deposits = opts.deposits ?? (deps.services['cashier.externalDeposits'] as ExternalDepositPort | undefined);
      if (!deposits) deps.logger.warn('[pearl] sin cashier.externalDeposits: todo comprobante irá a revisión humana');
      const pearl = new PearlService(repo, { deposits, logger: deps.logger, defaultCurrency: deps.env.PEARL_DEFAULT_CURRENCY || 'ARS' });

      const inbox = deps.services['inbox.service'] as InboxService | undefined;
      let ai: PearlAi | undefined;
      if (inbox) {
        const box = new SecretBox(deps.env.INBOX_SECRETS_KEY || randomBytes(32).toString('hex'));
        ai = new PearlAi(repo, pearl, inbox, box, {
          logger: deps.logger, envKey: deps.env.PEARL_ANTHROPIC_API_KEY || deps.env.ANTHROPIC_API_KEY || undefined, factory: opts.aiFactory,
          keyResolver: async (operatorId, provider) => (deps.services['integrations.service'] as IntegrationsPort | undefined)?.value(operatorId, provider, 'apiKey'),
          ensurePlayer: () => {
            const leads = deps.services['inbox.leads'] as LeadService | undefined;
            return leads ? (conv, name) => leads.ensurePlayer(conv, name) : undefined;
          },
        });
        // Prioridad sobre Tide: las imágenes y la respuesta del titular las atiende Pearl.
        inbox.onEvent((e) => ai!.onInboxEvent(e), 10);
        pearl.setNotifier(async (r, outcome) => {
          if (!r.conversationId) return;
          await inbox.botMessage(r.operatorId, r.conversationId, pearlMessage(r, outcome));
          // Salas: depósito acreditado → cliente (los VIP se quedan en VIP); en revisión → revisión de depósito.
          if (outcome === 'pending_review') {
            await inbox.botHandoff(r.operatorId, r.conversationId, `Pearl: comprobante ${formatAmount(r)} a revisión (${r.reason ?? 'sin motivo'})`);
            await inbox.setStage(r.operatorId, r.conversationId, 'deposit_review');
          } else if (outcome === 'credited') {
            const conv = await inbox.conversation(r.operatorId, r.conversationId);
            if (conv.stage !== 'vip') await inbox.setStage(r.operatorId, r.conversationId, 'client');
          }
        });
      }

      app.use(PEARL_PREFIX, buildPearlRouter({ auth: deps.auth, pearl, ai, attachment: inbox ? (op, id) => inbox.attachment(op, id) : undefined, logger: deps.logger }));
      const tickMs = opts.tickMs ?? Number(deps.env.PEARL_TICK_MS ?? 60_000);
      if (Number.isFinite(tickMs) && tickMs > 0) {
        const t = setInterval(() => void pearl.tick().catch((e) => deps.logger.error('[pearl] barrido', { error: (e as Error).message })), tickMs);
        t.unref?.();
      }
      const cashier = inbox ? new ChatCashier(inbox, deps.services['players.accounts'] as PlayerAccountsPort | undefined, { logger: deps.logger }) : undefined;
      return { 'pearl.service': pearl, ...(ai ? { 'pearl.ai': ai } : {}), ...(cashier ? { 'pearl.cashier': cashier } : {}) };
    },
  };
}

export const pearlModule = createPearlModule();
