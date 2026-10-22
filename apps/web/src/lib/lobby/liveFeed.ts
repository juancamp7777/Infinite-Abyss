/** Lógica pura del feed de apuestas en vivo (sin React ni sockets): fusión de lotes, límites y formato. */
import type { FeedBet, FeedKind } from './types';

export type LiveTab = FeedKind | 'mine';
export type LiveLists = Record<LiveTab, FeedBet[]>;
export const LIVE_MAX = 20;
export const EMPTY_LISTS: LiveLists = { mine: [], all: [], high: [], lucky: [] };

/** Antepone las apuestas nuevas (la más reciente primero), sin duplicados por id y acotado a `max`. */
export function prepend(list: FeedBet[], incoming: FeedBet[], max = LIVE_MAX): FeedBet[] {
  const seen = new Set<string>();
  const out: FeedBet[] = [];
  for (const b of [...[...incoming].reverse(), ...list]) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Reparte un lote de `feed:bets` (cada apuesta trae sus `kinds`) en las listas públicas.
 * El lote llega en orden de llegada (la última es la más reciente).
 */
export function mergeBatch(lists: LiveLists, batch: FeedBet[], max = LIVE_MAX): LiveLists {
  const next: LiveLists = { ...lists };
  for (const kind of ['all', 'high', 'lucky'] as const) {
    const mine = batch.filter((b) => (b.kinds ?? ['all']).includes(kind));
    if (mine.length) next[kind] = prepend(lists[kind], mine, max);
  }
  return next;
}

/** Ganancia neta de una apuesta en unidades mínimas (bigint; nunca float). */
export function profitOf(b: Pick<FeedBet, 'amount' | 'win'>): bigint {
  try {
    return BigInt(b.win) - BigInt(b.amount);
  } catch {
    return BigInt(0);
  }
}

/** "12.5x"; los multiplicadores grandes sin decimales. */
export function formatMultiplier(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '0.00x';
  return m >= 1000 ? `${Math.round(m).toLocaleString('es-CO')}x` : `${m.toFixed(2)}x`;
}

/** Hora local HH:MM de una fecha ISO ('' si no es válida). */
export function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}
