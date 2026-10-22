import { randomInt } from 'crypto';
import type { WalletPort, CreditReason } from '../../shared/ports/WalletPort';
import type { PlayerCompliancePort } from '../../shared/ports/PlayerCompliancePort';
import type { ModuleLogger } from '../../shared/module';
import { type OperatorCurrencyPort, resolveOperatorCurrency } from '../../shared/ports/OperatorCurrencyPort';
import type { DocStore } from '../infrastructure/DocStore';
import { OperatorSettings, defaultSettings } from '../domain/types';

export const COL = {
  settings: 'settings',
  level: 'level',
  vip: 'vip',
  dedupe: 'dedupe',
  mission: 'mission',
  missionProg: 'mprog',
  achievement: 'achv',
  unlocked: 'unlock',
  stats: 'stats',
  streak: 'streak',
  wheel: 'wheel',
  tournament: 'tour',
  entry: 'tentry',
  payout: 'payout',
  pgrant: 'pgrant',
  player: 'player',
  claim: 'claim',
} as const;

/** RNG inyectable. Por defecto crypto.randomInt (CSPRNG). */
export interface Rng {
  /** Entero uniforme en [0, maxExclusive). */
  int(maxExclusive: number): number;
}
export const cryptoRng: Rng = { int: (n) => randomInt(0, n) };

export interface Notifier {
  toPlayer(operatorId: string, playerId: string, event: string, payload: unknown): void;
  toTournament(tournamentId: string, event: string, payload: unknown): void;
}
export const nullNotifier: Notifier = { toPlayer: () => undefined, toTournament: () => undefined };
export const playerRoom = (op: string, player: string): string => `player:${op}:${player}`;
export const tournamentRoom = (id: string): string => `tournament:${id}`;

/** Servicio de promociones (módulo s9) usado opcionalmente. Contrato mínimo esperado. */
export interface PromotionsLike {
  grantBonus?(req: {
    operatorId: string;
    playerId: string;
    promotionId: string;
    amount?: bigint;
    currency: string;
    idempotencyKey: string;
    source: string;
  }): Promise<unknown>;
}

/** Exclusión mutua por clave dentro del proceso (cadena de promesas). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface GamiContext {
  store: DocStore;
  wallet: WalletPort;
  compliance?: PlayerCompliancePort;
  clock: () => number;
  rng: Rng;
  notifier: Notifier;
  logger: ModuleLogger;
  locks: KeyedMutex;
  promotions?: PromotionsLike;
  /** Moneda del operador (defaultCurrency) para los ajustes sin moneda guardada. */
  operators?: OperatorCurrencyPort;
  /** Respaldo SOLO para el dev-server sin operador real. */
  fallbackCurrency?: string;
}

export async function loadSettings(ctx: GamiContext, op: string): Promise<OperatorSettings> {
  const s = (await ctx.store.get<Partial<OperatorSettings>>(COL.settings, op, 'cfg')) ?? {};
  const currency = s.currency ?? (await resolveOperatorCurrency(ctx.operators, op, ctx.fallbackCurrency, ctx.logger));
  const d = defaultSettings(currency);
  return {
    ...d,
    ...s,
    currency,
    houseEdgeBps: { ...d.houseEdgeBps, ...(s.houseEdgeBps ?? {}) },
    unitsPerPoint: { ...d.unitsPerPoint, ...(s.unitsPerPoint ?? {}) },
    streakRewards: s.streakRewards ?? d.streakRewards,
    wheel: s.wheel ?? d.wheel,
  };
}

export async function saveSettings(ctx: GamiContext, op: string, patch: Partial<OperatorSettings>): Promise<OperatorSettings> {
  const current = (await ctx.store.get<Partial<OperatorSettings>>(COL.settings, op, 'cfg')) ?? {};
  await ctx.store.put(COL.settings, op, 'cfg', { ...current, ...patch });
  return loadSettings(ctx, op);
}

export async function playerCurrency(ctx: GamiContext, op: string, player: string, settings?: OperatorSettings): Promise<string> {
  const p = await ctx.store.get<{ currency?: string }>(COL.player, op, player);
  return p?.currency ?? (settings ?? (await loadSettings(ctx, op))).currency;
}

export const eventTime = (ctx: GamiContext, at: string | undefined): number => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : ctx.clock();
};

export interface PayoutRecord {
  id: string;
  type: string;
  playerId: string;
  currency: string;
  amount: bigint;
  reason: string;
  at: number;
}

/** Credita (idempotente por key) y deja el registro del pago para los reportes. */
export async function payCredit(
  ctx: GamiContext,
  p: { op: string; player: string; currency: string; amount: bigint; reason: CreditReason; key: string; type: string; gameId?: string },
): Promise<void> {
  if (p.amount <= 0n) return;
  await ctx.wallet.credit({
    operatorId: p.op,
    playerId: p.player,
    currency: p.currency,
    amount: p.amount,
    idempotencyKey: p.key,
    reason: p.reason,
    ref: { provider: 'nymfo-gamification', ...(p.gameId ? { gameId: p.gameId } : {}) },
  });
  const rec: PayoutRecord = { id: p.key, type: p.type, playerId: p.player, currency: p.currency, amount: p.amount, reason: p.reason, at: ctx.clock() };
  await ctx.store.putIfAbsent(COL.payout, p.op, p.key, rec, p.player);
}
