import { applyBps } from '../../shared/money';
import { PPM, PromoError, RandomSource, randomBigint } from './common';

export type JackpotLevelKey = 'mini' | 'major' | 'mega';
export const JACKPOT_LEVEL_KEYS: readonly JackpotLevelKey[] = ['mini', 'major', 'mega'];

export interface JackpotLevel {
  key: JackpotLevelKey;
  /** Valor con el que (re)arranca el pozo; lo financia la casa ("seed funding"). */
  seedAmount: bigint;
  /** Parte de cada contribución que va a este nivel (la suma de niveles = 10000). */
  shareBps: number;
  /** Probabilidad de disparo por apuesta elegible, en ppm. */
  triggerChancePpm: number;
  /** "Must drop by": el pozo cae como muy tarde al llegar a este valor (punto oculto aleatorio en (seed, mustDropBy]). */
  mustDropBy: bigint | null;
  /** Punto de caída oculto vigente (no se publica). */
  dropPoint: bigint | null;
  currentAmount: bigint;
  sortOrder: number;
}

export interface Jackpot {
  id: string;
  operatorId: string;
  name: string;
  currency: string;
  /** Porcentaje de cada apuesta elegible que alimenta los pozos (bps). */
  contributionBps: number;
  minBet: bigint;
  /** Vacío = todos los juegos. */
  gameIds: string[];
  /** Vacío = todas las categorías. */
  categories: string[];
  status: 'ACTIVE' | 'PAUSED';
  levels: JackpotLevel[];
  createdAt: Date;
  updatedAt: Date;
}

export interface JackpotContribution {
  id: string;
  jackpotId: string;
  operatorId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  betAmount: bigint;
  amount: bigint;
  perLevel: Partial<Record<JackpotLevelKey, bigint>>;
  createdAt: Date;
}

export interface JackpotWin {
  id: string;
  jackpotId: string;
  operatorId: string;
  playerId: string;
  currency: string;
  levelKey: JackpotLevelKey;
  roundId: string;
  gameId: string;
  amount: bigint;
  status: 'PENDING' | 'PAID';
  txId: string | null;
  createdAt: Date;
  paidAt: Date | null;
}

export interface JackpotSeedFunding {
  id: string;
  jackpotId: string;
  levelKey: JackpotLevelKey;
  amount: bigint;
  reason: 'INITIAL' | 'RESEED';
  createdAt: Date;
}

export interface TriggerDecision {
  key: JackpotLevelKey;
  /** Nuevo punto oculto tras el reseed (null si el nivel no usa must-drop-by). */
  nextDropPoint: bigint | null;
}

export function validateLevels(levels: Array<Pick<JackpotLevel, 'key' | 'shareBps' | 'seedAmount' | 'mustDropBy' | 'triggerChancePpm'>>): void {
  if (levels.length === 0) throw new PromoError(400, 'BAD_REQUEST', 'El jackpot necesita al menos un nivel');
  const keys = new Set(levels.map((l) => l.key));
  if (keys.size !== levels.length) throw new PromoError(400, 'BAD_REQUEST', 'Niveles repetidos');
  const total = levels.reduce((s, l) => s + l.shareBps, 0);
  if (total !== 10000) throw new PromoError(400, 'BAD_REQUEST', 'La suma de shareBps de los niveles debe ser 10000');
  for (const l of levels) {
    if (l.mustDropBy != null && l.mustDropBy <= l.seedAmount) {
      throw new PromoError(400, 'BAD_REQUEST', `mustDropBy del nivel ${l.key} debe superar la semilla`);
    }
    if (l.triggerChancePpm <= 0 && l.mustDropBy == null) {
      throw new PromoError(400, 'BAD_REQUEST', `El nivel ${l.key} necesita probabilidad de disparo o mustDropBy`);
    }
  }
}

/** Contribución total de una apuesta (floor; la fracción sub-unidad nunca se descuenta del jugador). */
export const totalContribution = (bet: bigint, contributionBps: number): bigint => applyBps(bet, contributionBps);

/**
 * Reparte `total` entre niveles por shareBps sin perder unidades: cada nivel recibe floor(total × share / 10000)
 * y el residuo completo va, de forma determinista, al nivel con mayor shareBps (empate → menor sortOrder).
 */
export function splitContribution(total: bigint, levels: Array<Pick<JackpotLevel, 'key' | 'shareBps' | 'sortOrder'>>): Partial<Record<JackpotLevelKey, bigint>> {
  const out: Partial<Record<JackpotLevelKey, bigint>> = {};
  if (levels.length === 0) return out;
  let assigned = 0n;
  for (const l of levels) {
    const part = (total * BigInt(l.shareBps)) / 10000n;
    out[l.key] = part;
    assigned += part;
  }
  const target = [...levels].sort((a, b) => b.shareBps - a.shareBps || a.sortOrder - b.sortOrder)[0];
  out[target.key] = (out[target.key] ?? 0n) + (total - assigned);
  return out;
}

/** Punto de caída oculto uniforme en (seed, mustDropBy]. */
export function pickDropPoint(seed: bigint, mustDropBy: bigint | null, rng: RandomSource): bigint | null {
  if (mustDropBy == null || mustDropBy <= seed) return null;
  return seed + 1n + randomBigint(mustDropBy - seed, rng);
}

/** Decide qué niveles se disparan tras sumar la contribución (como mucho uno por nivel). */
export function decideTriggers(levels: JackpotLevel[], rng: RandomSource): TriggerDecision[] {
  const out: TriggerDecision[] = [];
  for (const l of levels) {
    const mustDrop = l.dropPoint != null && l.currentAmount >= l.dropPoint;
    const random = l.triggerChancePpm > 0 && rng.int(PPM) < l.triggerChancePpm;
    if (mustDrop || random) out.push({ key: l.key, nextDropPoint: pickDropPoint(l.seedAmount, l.mustDropBy, rng) });
  }
  return out;
}

export function isBetEligible(j: Pick<Jackpot, 'status' | 'currency' | 'minBet' | 'gameIds' | 'categories'>, bet: { currency: string; amount: bigint; gameId: string; category: string }): boolean {
  return (
    j.status === 'ACTIVE' &&
    j.currency === bet.currency &&
    bet.amount >= j.minBet &&
    (j.gameIds.length === 0 || j.gameIds.includes(bet.gameId)) &&
    (j.categories.length === 0 || j.categories.includes(bet.category))
  );
}

/** Vista pública (sin puntos de caída ocultos). */
export function publicJackpot(j: Jackpot) {
  return {
    id: j.id,
    name: j.name,
    currency: j.currency,
    levels: j.levels.map((l) => ({ key: l.key, amount: l.currentAmount, mustDropBy: l.mustDropBy })),
  };
}
