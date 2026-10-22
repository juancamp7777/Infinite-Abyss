import { createHmac, randomBytes } from 'crypto';
import { PPM, RandomSource } from './common';

export interface DropPrize {
  id: string;
  amount: bigint;
  quantity: number;
  awarded: number;
  sortOrder: number;
}

export interface DropCampaign {
  id: string;
  operatorId: string;
  name: string;
  currency: string;
  startsAt: Date;
  endsAt: Date;
  /** Apuesta mínima para participar. */
  minBet: bigint;
  /** Probabilidad de premio por apuesta elegible (ppm). */
  dropChancePpm: number;
  /** Vacío = todos los juegos. */
  gameIds: string[];
  status: 'ACTIVE' | 'PAUSED';
  prizes: DropPrize[];
  createdAt: Date;
}

export interface DropAward {
  id: string;
  campaignId: string;
  prizeId: string;
  operatorId: string;
  playerId: string;
  currency: string;
  roundId: string;
  amount: bigint;
  status: 'PENDING' | 'PAID';
  txId: string | null;
  createdAt: Date;
}

/**
 * Tirada de un drop para (campaña, ronda). Por defecto es determinista (HMAC con secreto del servidor), así un
 * evento reprocesado da el mismo resultado y no permite "re-tirar".
 */
export type DropRoller = (campaignId: string, roundId: string) => number;

export function hmacDropRoller(secret?: string): DropRoller {
  const key = secret && secret.length > 0 ? secret : randomBytes(32).toString('hex');
  return (campaignId, roundId) => {
    const h = createHmac('sha256', key).update(`${campaignId}:${roundId}`).digest();
    return h.readUIntBE(0, 6) % PPM;
  };
}

export const remainingStock = (c: Pick<DropCampaign, 'prizes'>): number => c.prizes.reduce((s, p) => s + Math.max(0, p.quantity - p.awarded), 0);

export function isDropActive(c: Pick<DropCampaign, 'status' | 'startsAt' | 'endsAt' | 'prizes'>, now: Date): boolean {
  return c.status === 'ACTIVE' && c.startsAt <= now && now < c.endsAt && remainingStock(c) > 0;
}

export function isDropEligible(c: DropCampaign, bet: { currency: string; amount: bigint; gameId: string }, now: Date): boolean {
  return isDropActive(c, now) && c.currency === bet.currency && bet.amount >= c.minBet && (c.gameIds.length === 0 || c.gameIds.includes(bet.gameId));
}

/** Elige un premio ponderado por stock restante; null si no queda stock. */
export function pickPrize(prizes: DropPrize[], rng: RandomSource): DropPrize | null {
  const avail = [...prizes].sort((a, b) => a.sortOrder - b.sortOrder).filter((p) => p.quantity > p.awarded);
  const total = avail.reduce((s, p) => s + (p.quantity - p.awarded), 0);
  if (total <= 0) return null;
  let r = rng.int(total);
  for (const p of avail) {
    r -= p.quantity - p.awarded;
    if (r < 0) return p;
  }
  return avail[avail.length - 1];
}
