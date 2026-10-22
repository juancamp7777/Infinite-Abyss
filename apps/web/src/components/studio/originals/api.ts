/**
 * Cliente mínimo de la API de Nymfo Studios (/studio/v1) para los originals.
 * Montos siempre como string bigint en unidades mínimas. El cliente nunca decide resultados.
 */
import type { StudioGameProps } from '../types';
import { newId, studioRequest } from '@/lib/studio/http';

export { API_URL, StudioApiError, ensureDemoSession, prepare, errorMessage } from '@/lib/studio/http';

export interface PublicRound {
  id: string;
  gameId: string;
  bet: string;
  baseBet: string;
  win: string;
  multiplier: number;
  currency: string;
  outcome: unknown;
  params: Record<string, unknown>;
  rtp: number;
  serverSeedHash: string;
  serverSeed?: string;
  clientSeed: string;
  nonce: number;
  status: 'OPEN' | 'SETTLED' | 'FAILED' | 'ROLLED_BACK' | string;
  mode: 'real' | 'demo';
  createdAt: string;
}

export interface PlayResponse {
  round: PublicRound;
  balance: string | null;
  view?: Record<string, unknown>;
}

export interface BalanceResponse {
  balance: string;
  currency: string;
  mode: 'real' | 'demo';
}

export interface FairnessView {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
}

export interface RotateResponse {
  previous: { serverSeed: string; serverSeedHash: string; clientSeed: string; lastNonce: number; noncesUsed: number };
  current: FairnessView;
}

export interface VerifyResponse {
  gameId: string;
  computedHash: string;
  serverSeedHash: string | null;
  hashMatches: boolean | null;
  nonce: number;
  clientSeed: string;
  outcome: unknown;
  multiplier?: number;
  round?: { roundId: string; clientSeedMatches: boolean; nonceMatches: boolean; outcomeMatches?: boolean; multiplierMatches?: boolean };
}

export interface VerifyInput {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  gameId: string;
  serverSeedHash?: string;
  params?: Record<string, unknown>;
  rtp?: number;
  roundId?: string;
}

const request = studioRequest;

export const studioApi = {
  balance: (p: StudioGameProps) => request<BalanceResponse>('GET', '/balance', p),
  play: (p: StudioGameProps, amount: string, params: Record<string, unknown>) =>
    request<PlayResponse>('POST', `/play/${p.gameId}`, p, { amount, params, roundId: newId() }),
  start: (p: StudioGameProps, amount: string, params: Record<string, unknown>) =>
    request<PlayResponse>('POST', `/games/${p.gameId}/start`, p, { amount, params, roundId: newId() }),
  action: (p: StudioGameProps, roundId: string, action: { type: string; [k: string]: unknown }) =>
    request<PlayResponse>('POST', `/games/${p.gameId}/action`, p, { roundId, action }),
  settle: (p: StudioGameProps, roundId: string) => request<PlayResponse>('POST', `/games/${p.gameId}/settle`, p, { roundId }),
  active: (p: StudioGameProps) => request<{ round: PublicRound | null }>('GET', `/games/${p.gameId}/active`, p),
  rounds: (p: StudioGameProps, limit = 20) => request<{ rounds: PublicRound[] }>('GET', `/rounds?gameId=${encodeURIComponent(p.gameId)}&limit=${limit}`, p),
  fairness: (p: StudioGameProps) => request<FairnessView>('GET', '/fairness', p),
  setClientSeed: (p: StudioGameProps, clientSeed: string) => request<FairnessView>('POST', '/fairness/client-seed', p, { clientSeed }),
  rotate: (p: StudioGameProps, clientSeed?: string) => request<RotateResponse>('POST', '/fairness/rotate', p, clientSeed ? { clientSeed } : {}),
  verify: (p: StudioGameProps, input: VerifyInput) => request<VerifyResponse>('POST', '/fairness/verify', p, input as unknown as Record<string, unknown>),
};
