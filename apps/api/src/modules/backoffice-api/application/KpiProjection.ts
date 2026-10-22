import type { DomainEventName, DomainEvents, EventBus } from '../../shared/events/EventBus';
import type { KpiRepository } from '../domain/types';

export const dayOf = (iso: string): string => {
  const t = Date.parse(iso);
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString().slice(0, 10);
};

/** Proyecta los eventos del bus a contadores diarios por operador. Idempotente por clave de evento. */
export class KpiProjection {
  constructor(private readonly repo: KpiRepository) {}

  subscribe(bus: EventBus): () => void {
    const offs: Array<() => void> = [];
    const on = <K extends DomainEventName>(name: K, h: (e: DomainEvents[K]) => Promise<void>) => offs.push(bus.subscribe(name, h));
    on('player.registered', (e) => this.registered(e));
    on('deposit.completed', (e) => this.deposit(e));
    on('withdrawal.completed', (e) => this.withdrawal(e));
    on('bet.placed', (e) => this.betPlaced(e));
    on('bet.settled', (e) => this.betSettled(e));
    on('login', (e) => this.login(e));
    on('session.started', (e) => this.sessionStarted(e));
    return () => offs.forEach((f) => f());
  }

  /** Marca actividad del jugador ese día y suma el contador de activos si es nueva. */
  private async touchActive(op: string, day: string, player: string): Promise<void> {
    if (await this.repo.touchPlayerDay(op, day, player, 'active')) await this.repo.bumpDay(op, day, { activePlayers: 1 });
  }

  async registered(e: DomainEvents['player.registered']): Promise<void> {
    if (!(await this.repo.claimEvent(`reg:${e.operatorId}:${e.playerId}`))) return;
    const day = dayOf(e.at);
    await this.repo.setPlayerMilestone(e.operatorId, e.playerId, { registeredDay: day });
    await this.repo.bumpDay(e.operatorId, day, { registrations: 1 });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async deposit(e: DomainEvents['deposit.completed']): Promise<void> {
    if (!(await this.repo.claimEvent(`dep:${e.operatorId}:${e.txId}`))) return;
    const day = dayOf(e.at);
    const amount = BigInt(e.amount);
    await this.repo.bumpDay(e.operatorId, day, { depositsCount: 1, depositsAmount: amount });
    if (e.isFirst) {
      await this.repo.bumpDay(e.operatorId, day, { ftdCount: 1, ftdAmount: amount });
      await this.repo.setPlayerMilestone(e.operatorId, e.playerId, { firstDepositDay: day });
    }
    if (await this.repo.touchPlayerDay(e.operatorId, day, e.playerId, 'depositor')) await this.repo.bumpDay(e.operatorId, day, { depositors: 1 });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async withdrawal(e: DomainEvents['withdrawal.completed']): Promise<void> {
    if (!(await this.repo.claimEvent(`wd:${e.operatorId}:${e.txId}`))) return;
    const day = dayOf(e.at);
    await this.repo.bumpDay(e.operatorId, day, { withdrawalsCount: 1, withdrawalsAmount: BigInt(e.amount) });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async betPlaced(e: DomainEvents['bet.placed']): Promise<void> {
    if (!(await this.repo.claimEvent(`bp:${e.operatorId}:${e.roundId}`))) return;
    const day = dayOf(e.at);
    await this.repo.bumpDay(e.operatorId, day, { betCount: 1, stakePlaced: BigInt(e.amount) });
    if (await this.repo.touchPlayerDay(e.operatorId, day, e.playerId, 'bettor')) await this.repo.bumpDay(e.operatorId, day, { bettors: 1 });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async betSettled(e: DomainEvents['bet.settled']): Promise<void> {
    if (!(await this.repo.claimEvent(`bs:${e.operatorId}:${e.roundId}`))) return;
    const day = dayOf(e.at);
    await this.repo.bumpDay(e.operatorId, day, { settledCount: 1, settledStake: BigInt(e.amount), settledWins: BigInt(e.win) });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async login(e: DomainEvents['login']): Promise<void> {
    if (!(await this.repo.claimEvent(`login:${e.operatorId}:${e.playerId}:${e.at}:${e.ip ?? ''}`))) return;
    const day = dayOf(e.at);
    await this.repo.bumpDay(e.operatorId, day, { logins: 1 });
    await this.touchActive(e.operatorId, day, e.playerId);
  }

  async sessionStarted(e: DomainEvents['session.started']): Promise<void> {
    await this.touchActive(e.operatorId, dayOf(e.at), e.playerId);
  }
}
