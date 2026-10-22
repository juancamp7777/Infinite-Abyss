import { InMemoryWallet } from '../../shared/adapters/InMemoryWallet';
import type { DomainEvents } from '../../shared/events/EventBus';
import { silentLogger } from '../../shared/module';
import { InMemoryGameCatalog } from '../../shared/ports/GameCatalogPort';
import { InMemoryPlayerCompliance } from '../../shared/ports/PlayerCompliancePort';
import { WalletBonusFunds } from '../application/BonusFunds';
import { BonusService } from '../application/BonusService';
import { DropsService } from '../application/DropsService';
import { JackpotService } from '../application/JackpotService';
import { PPM, RandomSource } from '../domain/common';
import { InMemoryBonusRepository } from '../infrastructure/memory/InMemoryBonusRepository';
import { InMemoryDropRepository } from '../infrastructure/memory/InMemoryDropRepository';
import { InMemoryJackpotRepository } from '../infrastructure/memory/InMemoryJackpotRepository';

export const OP = 'op-1';
export const CUR = 'USD';
export const T0 = new Date('2026-10-01T12:00:00.000Z');

/** Reloj manual. */
export function manualClock(start = T0) {
  let now = new Date(start);
  const clock = () => new Date(now);
  return { clock, set: (d: Date) => (now = new Date(d)), advanceHours: (h: number) => (now = new Date(now.getTime() + h * 3_600_000)) };
}

/** RNG guionizado: entrega los valores encolados y, si no hay, `fallback(max)` (por defecto max-1 → nunca dispara). */
export function scriptedRng(fallback: (max: number) => number = (max) => max - 1) {
  const queue: number[] = [];
  const rng: RandomSource = { int: (max) => (queue.length ? Math.min(queue.shift()!, max - 1) : fallback(max)) };
  return { rng, push: (...v: number[]) => queue.push(...v), hitNext: () => queue.push(0), PPM };
}

let seq = 0;
export function bet(playerId: string, amount: bigint, extra: Partial<DomainEvents['bet.placed']> = {}): DomainEvents['bet.placed'] {
  seq++;
  return {
    operatorId: OP,
    playerId,
    at: T0.toISOString(),
    amount,
    currency: CUR,
    gameId: 'starfall',
    provider: 'nymfo',
    category: 'slots',
    roundId: `r-${seq}`,
    ...extra,
  };
}

export function bonusEnv() {
  const wallet = new InMemoryWallet();
  const repo = new InMemoryBonusRepository();
  const clock = manualClock();
  const compliance = new InMemoryPlayerCompliance({ selfExcluded: false, hasActiveLimits: false, ageVerified: true, isMinor: false });
  const catalog = new InMemoryGameCatalog([
    { id: 'starfall', provider: 'nymfo', category: 'slots', title: 'Starfall' },
    { id: 'crash', provider: 'nymfo', category: 'originals', title: 'Crash' },
    { id: 'roulette-live', provider: 'evo', category: 'live', title: 'Live Roulette' },
  ]);
  const service = new BonusService({ repo, funds: new WalletBonusFunds(wallet), clock: clock.clock, logger: silentLogger, catalog, compliance, defaultCurrency: CUR });
  return { wallet, repo, clock, compliance, catalog, service };
}

export function jackpotEnv() {
  const wallet = new InMemoryWallet();
  const repo = new InMemoryJackpotRepository();
  const clock = manualClock();
  const r = scriptedRng();
  const service = new JackpotService({ repo, wallet, clock: clock.clock, rng: r.rng, logger: silentLogger });
  return { wallet, repo, clock, service, ...r };
}

export function dropsEnv(roll: (campaignId: string, roundId: string) => number = () => 0) {
  const wallet = new InMemoryWallet();
  const repo = new InMemoryDropRepository();
  const clock = manualClock();
  const r = scriptedRng((max) => 0);
  const service = new DropsService({ repo, wallet, clock: clock.clock, rng: r.rng, roller: roll, logger: silentLogger });
  return { wallet, repo, clock, service };
}
