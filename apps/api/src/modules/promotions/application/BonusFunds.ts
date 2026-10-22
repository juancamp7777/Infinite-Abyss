import type { WalletPort } from '../../shared/ports/WalletPort';
import { PROMO_PROVIDER } from '../domain/common';
import type { PlayerBonus } from '../domain/bonus';

/**
 * Movimientos del saldo de bono. El WalletPort común no tiene operaciones "bonus→cash" ni "retirar solo del bono",
 * así que el adaptador por defecto las expresa con convenciones de `ref.gameId` que la Fase 1 debe respetar:
 *
 *  - 'bonus-grant'   credit BONUS_GRANT  → abona en la subcuenta de bono del jugador.
 *  - 'bonus-convert' credit BONUS_GRANT  → TRANSFERENCIA: debita la subcuenta de bono y abona cash por el mismo monto
 *                                          (asiento doble player_bonus → player_cash; no crea dinero nuevo).
 *  - 'bonus-forfeit' debit  OTHER        → debita SOLO la subcuenta de bono (contrapartida: cuenta de bonos del operador).
 *  - 'cashback-cash' credit CASHBACK     → abona cash directo (cashback sin wagering).
 *
 * Todas usan ref.provider = 'nymfo-promotions', ref.roundId = bonusId e idempotencyKey `promo:bonus:<bonusId>:<op>`.
 * Si la Fase 1 publica una implementación nativa en deps.services['wallet.bonusFunds'], el módulo la usa en su lugar.
 * Nota: InMemoryWallet (pruebas) no conoce estas convenciones: 'bonus-convert' vuelve a abonar en bono y
 * 'bonus-forfeit' consume primero cash; las pruebas verifican las llamadas registradas, no esa semántica.
 */
export interface BonusFundsPort {
  bonusBalance(operatorId: string, playerId: string, currency: string): Promise<bigint>;
  grant(bonus: PlayerBonus, amount: bigint): Promise<{ txId: string }>;
  grantCash(bonus: PlayerBonus, amount: bigint): Promise<{ txId: string }>;
  convert(bonus: PlayerBonus, amount: bigint): Promise<{ txId: string }>;
  forfeit(bonus: PlayerBonus, amount: bigint): Promise<{ txId: string }>;
}

export const bonusKey = (bonusId: string, op: 'grant' | 'convert' | 'forfeit'): string => `promo:bonus:${bonusId}:${op}`;

export class WalletBonusFunds implements BonusFundsPort {
  constructor(private readonly wallet: WalletPort) {}

  async bonusBalance(operatorId: string, playerId: string, currency: string): Promise<bigint> {
    return (await this.wallet.getBalance(operatorId, playerId, currency)).bonus;
  }

  async grant(b: PlayerBonus, amount: bigint): Promise<{ txId: string }> {
    return this.wallet.credit({ ...this.base(b, amount, 'bonus-grant'), reason: 'BONUS_GRANT', idempotencyKey: bonusKey(b.id, 'grant') });
  }

  async grantCash(b: PlayerBonus, amount: bigint): Promise<{ txId: string }> {
    return this.wallet.credit({ ...this.base(b, amount, 'cashback-cash'), reason: 'CASHBACK', idempotencyKey: bonusKey(b.id, 'grant') });
  }

  async convert(b: PlayerBonus, amount: bigint): Promise<{ txId: string }> {
    return this.wallet.credit({ ...this.base(b, amount, 'bonus-convert'), reason: 'BONUS_GRANT', idempotencyKey: bonusKey(b.id, 'convert') });
  }

  async forfeit(b: PlayerBonus, amount: bigint): Promise<{ txId: string }> {
    return this.wallet.debit({ ...this.base(b, amount, 'bonus-forfeit'), reason: 'OTHER', idempotencyKey: bonusKey(b.id, 'forfeit') });
  }

  private base(b: PlayerBonus, amount: bigint, gameId: string) {
    return { operatorId: b.operatorId, playerId: b.playerId, currency: b.currency, amount, ref: { provider: PROMO_PROVIDER, gameId, roundId: b.id } };
  }
}
