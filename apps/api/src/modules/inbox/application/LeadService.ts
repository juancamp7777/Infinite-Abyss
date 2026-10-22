import { HttpError } from '../../shared/http/errors';
import type { PlayerAccountsPort } from '../../shared/ports/PlayerAccountsPort';
import type { Conversation } from '../domain/types';
import type { InboxService } from './InboxService';

/**
 * Leads del chat: cuenta de casino automática para quien escribe sin estar registrado (usuario + contraseña
 * generados y entregados por el chat) o vinculación de una cuenta existente por un agente que verificó la identidad.
 * Nunca se vincula una cuenta existente a pedido del propio contacto: daría acceso a retiros de otra persona.
 */
export class LeadService {
  constructor(
    private readonly inbox: InboxService,
    private readonly accounts: PlayerAccountsPort,
    private readonly opts: { webUrl?: string },
  ) {}

  /** Garantiza un jugador para la conversación; crea la cuenta si falta. */
  async ensurePlayer(conv: Conversation, preferredName?: string): Promise<{ playerId: string; created: boolean; username?: string }> {
    if (conv.playerId) return { playerId: conv.playerId, created: false };
    const account = await this.accounts.createLead(conv.operatorId, preferredName || conv.contactName);
    await this.inbox.linkPlayer(conv.operatorId, conv.id, account.playerId);
    const link = this.opts.webUrl ? `\nEntra en ${this.opts.webUrl.replace(/\/+$/, '')} y cámbiala cuando quieras.` : '';
    await this.inbox.botMessage(conv.operatorId, conv.id, `🎉 ¡Tu cuenta está lista!\nUsuario: ${account.username}\nContraseña: ${account.password}${link}`);
    return { playerId: account.playerId, created: true, username: account.username };
  }

  async createFor(operatorId: string, conversationId: string): Promise<{ playerId: string; username?: string }> {
    const conv = await this.inbox.conversation(operatorId, conversationId);
    if (conv.playerId) throw new HttpError(409, 'ALREADY_LINKED', 'La conversación ya tiene un jugador');
    const r = await this.ensurePlayer(conv);
    return { playerId: r.playerId, username: r.username };
  }

  async linkExisting(operatorId: string, conversationId: string, playerId: string): Promise<Conversation> {
    if (!(await this.accounts.exists(operatorId, playerId))) throw new HttpError(404, 'NOT_FOUND', 'Jugador no encontrado en este operador');
    return this.inbox.linkPlayer(operatorId, conversationId, playerId);
  }
}
