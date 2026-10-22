import { randomInt } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuthService } from '../../../application/auth/AuthService';
import type { RequestWithdrawalUseCase } from '../../../application/cashier/RequestWithdrawalUseCase';
import { AppError } from '../../../domain/errors/AppError';
import {
  PlayerAccountError, type ChatWithdrawalRequest, type ChatWithdrawalResult, type LeadAccount, type PlayerAccountErrorCode, type PlayerAccountsPort,
} from '../../../modules/shared/ports/PlayerAccountsPort';
import { toTenantContext } from '../../tenancy/PrismaTenantRepository';

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = () => Array.from({ length: 10 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
const baseUsername = (name: string) =>
  (name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]{2,}/)?.[0] ?? 'jugador').slice(0, 12);

const CODE_MAP: Record<string, PlayerAccountErrorCode> = {
  KYC_REQUIRED: 'KYC_REQUIRED', INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS', LIMIT_EXCEEDED: 'LIMIT_EXCEEDED', SELF_EXCLUDED: 'SELF_EXCLUDED',
  NOT_FOUND: 'PLAYER_NOT_FOUND', FORBIDDEN: 'BLOCKED', VALIDATION_ERROR: 'INVALID',
};

/**
 * Leads del chat sobre el registro real (AuthService.register: rgSettings, evento player.registered) y retiros por
 * chat sobre RequestWithdrawalUseCase (KYC, límites, juego responsable, reserva del saldo CASH) con provider PEARL:
 * no hay pasarela, el equipo de finanzas aprueba, paga por banco y marca como pagado en el backoffice.
 */
export class Phase1PlayerAccounts implements PlayerAccountsPort {
  constructor(private readonly deps: { prisma: PrismaClient; auth: AuthService; requestWithdrawal: RequestWithdrawalUseCase }) {}

  private async tenant(operatorId: string) {
    const op = await this.deps.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!op) throw new PlayerAccountError('INVALID', 'Operador no encontrado');
    return toTenantContext(op);
  }

  async createLead(operatorId: string, displayName: string): Promise<LeadAccount> {
    const tenant = await this.tenant(operatorId);
    const base = baseUsername(displayName);
    for (let i = 0; i < 10; i++) {
      const username = `${base}${randomInt(1000, 10000)}`;
      const password = randomPassword();
      try {
        const res = await this.deps.auth.register(tenant, { email: `${username}@leads.invalid`, password, username });
        return { playerId: res.user.id, username, password };
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== 'CONFLICT') throw e;
      }
    }
    throw new PlayerAccountError('INVALID', 'No se pudo generar un usuario libre');
  }

  async exists(operatorId: string, playerId: string) {
    return !!(await this.deps.prisma.user.findFirst({ where: { id: playerId, operatorId, isDemo: false }, select: { id: true } }));
  }

  async currency(operatorId: string, playerId: string) {
    return (await this.deps.prisma.user.findFirst({ where: { id: playerId, operatorId }, select: { currency: true } }))?.currency ?? null;
  }

  async requestWithdrawal(req: ChatWithdrawalRequest): Promise<ChatWithdrawalResult> {
    const user = await this.deps.prisma.user.findFirst({ where: { id: req.playerId, operatorId: req.operatorId }, select: { id: true, currency: true, isDemo: true } });
    if (!user) throw new PlayerAccountError('PLAYER_NOT_FOUND', 'Jugador no encontrado');
    try {
      const w = await this.deps.requestWithdrawal.execute({
        auth: { kind: 'player', userId: user.id, operatorId: req.operatorId, currency: user.currency, isDemo: user.isDemo },
        tenant: await this.tenant(req.operatorId),
        provider: 'PEARL',
        amount: req.amount,
        currency: user.currency,
        destination: { type: 'bank_transfer', account: req.destination.account, holderName: req.destination.holderName, channel: 'chat' },
      });
      return { withdrawalId: w.id, amount: w.amount, currency: w.currency };
    } catch (e) {
      if (e instanceof AppError) throw new PlayerAccountError(CODE_MAP[e.code ?? ''] ?? 'INVALID', e.message);
      throw e;
    }
  }
}
