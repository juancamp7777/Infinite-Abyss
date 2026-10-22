/**
 * Cliente tipado de Nymfo Studios (/studio/v1) para las slots.
 * Montos siempre como string bigint en unidades mínimas; el cliente nunca decide resultados.
 * Comparte la sesión demo (localStorage) con el cliente de los originals.
 */
import type { StudioGameProps } from '@/components/studio/types';
import { newId, studioRequest, type StudioCtx } from './http';

export { API_URL, StudioApiError, playerToken, ensureDemoSession, prepare, errorMessage, formatMoney, winUnits } from './http';

export interface SlotRound<O = unknown> {
  id: string;
  gameId: string;
  /** Apuesta total debitada (con bonus buy = coste × apuesta base). */
  bet: string;
  baseBet: string;
  win: string;
  /** Ganancia en veces la apuesta base. */
  multiplier: number;
  currency: string;
  outcome: O;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  status: string;
  mode: 'real' | 'demo';
  bonusBuy?: boolean;
  createdAt: string;
}

export interface SlotPlayResponse<O = unknown> {
  round: SlotRound<O>;
  /** Saldo tras la ronda (null si no disponible). */
  balance: string | null;
}

export interface BalanceInfo {
  balance: string;
  currency: string;
  mode: 'real' | 'demo';
}

export interface GameInfo {
  id: string;
  name: string;
  rtp: number;
  volatility: string;
  maxWin: number;
  bonusBuy: { costMultiplier: number } | null;
}

type Ctx = StudioCtx;

const request = studioRequest;

export const slotApi = {
  balance: (c: StudioGameProps) => request<BalanceInfo>('GET', '/balance', c),
  games: (c: Ctx) => request<{ games: GameInfo[] }>('GET', '/games', c),
  /** Un giro. `amount` = apuesta base (string bigint); con bonusBuy el servidor cobra costMultiplier × amount. */
  play: <O>(c: StudioGameProps, amount: string, bonusBuy: boolean) =>
    request<SlotPlayResponse<O>>('POST', `/play/${c.gameId}`, c, { amount, bonusBuy: bonusBuy || undefined, roundId: newId() }),
  rounds: (c: StudioGameProps, limit = 20) =>
    request<{ rounds: SlotRound[] }>('GET', `/rounds?gameId=${encodeURIComponent(c.gameId)}&limit=${limit}`, c),
};
