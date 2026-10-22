import { currencyDecimals } from '../../../domain/money/currencies';
import type { InboxService } from '../../inbox/application/InboxService';
import type { Conversation } from '../../inbox/domain/types';
import type { ModuleLogger } from '../../shared/module';
import { PlayerAccountError, type PlayerAccountsPort } from '../../shared/ports/PlayerAccountsPort';
import { formatMoney } from '../domain/money';
import { parseAmountToMinor } from '../domain/matching';

export type WithdrawOutcome = { ok: true; withdrawalId: string } | { ok: false; code: string };

const REPLY: Record<string, string> = {
  NO_PLAYER: 'Para retirar primero necesitas una cuenta. Envíanos tu primer comprobante de carga y te la creamos al instante. 🙌',
  INVALID_AMOUNT: 'No entendí el monto. Escríbelo solo con números, por ejemplo 15000.',
  INVALID_ACCOUNT: 'Necesito el CBU, CVU o alias de la cuenta donde quieres recibir el retiro.',
  KYC_REQUIRED: 'Para retirar necesitamos verificar tu identidad. Un asesor te escribe por aquí para completarlo. 🔐',
  INSUFFICIENT_FUNDS: 'Tu saldo disponible no alcanza para ese retiro. Revisa tu saldo en la cuenta e intenta con otro monto.',
  LIMIT_EXCEEDED: 'Ese monto está fuera de los límites de retiro (mínimo, máximo o diario). Un asesor te ayuda si lo necesitas.',
  SELF_EXCLUDED: 'Tu cuenta tiene una autoexclusión activa, por eso no podemos procesar movimientos. Un asesor te contactará.',
};

/**
 * Retiros por chat: SIN IA. Se registran sobre el circuito real (reserva del saldo, revisión, pago manual) y la
 * conversación pasa a la sala de retiros con una nota para finanzas. Cualquier bloqueo se explica al contacto.
 */
export class ChatCashier {
  constructor(
    private readonly inbox: InboxService,
    private readonly accounts: PlayerAccountsPort | undefined,
    private readonly opts: { logger: ModuleLogger },
  ) {}

  async withdraw(conv: Conversation, amountText: string, account: string, holderName: string): Promise<WithdrawOutcome> {
    const fail = async (code: string, toSupport = false): Promise<WithdrawOutcome> => {
      await this.inbox.botMessage(conv.operatorId, conv.id, REPLY[code] ?? 'No pudimos registrar el retiro. Un asesor te escribe por aquí.');
      if (toSupport) await this.inbox.botHandoff(conv.operatorId, conv.id, `Retiro por chat no registrado (${code})`);
      return { ok: false, code };
    };
    if (!this.accounts) return fail('UNAVAILABLE', true);
    if (!conv.playerId) return fail('NO_PLAYER');
    const currency = await this.accounts.currency(conv.operatorId, conv.playerId);
    if (!currency) return fail('NO_PLAYER');
    const amount = parseAmountToMinor(amountText, currencyDecimals(currency));
    if (!amount) return fail('INVALID_AMOUNT');
    const acc = account.trim();
    if (!/^[\w.\- ]{6,60}$/.test(acc)) return fail('INVALID_ACCOUNT');
    try {
      const w = await this.accounts.requestWithdrawal({ operatorId: conv.operatorId, playerId: conv.playerId, amount, destination: { account: acc, holderName: holderName.trim().slice(0, 120) || conv.contactName } });
      const money = formatMoney(w.amount, w.currency);
      await this.inbox.botMessage(conv.operatorId, conv.id, `✅ Registramos tu retiro de ${money} a la cuenta ${acc}. Lo procesa el equipo de pagos y te avisamos cuando esté hecho.`);
      await this.inbox.botHandoff(conv.operatorId, conv.id, `Retiro ${money} a ${acc} (${holderName || 'titular sin indicar'}) · solicitud ${w.withdrawalId.slice(0, 8)}`);
      // botHandoff deja la sala en soporte: se vuelve a la sala de retiros.
      await this.inbox.setStage(conv.operatorId, conv.id, 'withdraw');
      return { ok: true, withdrawalId: w.withdrawalId };
    } catch (e) {
      if (e instanceof PlayerAccountError) return fail(e.code, ['KYC_REQUIRED', 'SELF_EXCLUDED', 'BLOCKED', 'INVALID', 'PLAYER_NOT_FOUND'].includes(e.code));
      this.opts.logger.error('[pearl] retiro por chat fallido', { conversationId: conv.id, error: (e as Error).message });
      return fail('ERROR', true);
    }
  }
}
