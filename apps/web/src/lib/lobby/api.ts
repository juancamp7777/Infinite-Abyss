import { API_URL, ApiError, moduleOperatorId, moduleRequest } from '../modules';
import type {
  Balance, Game, GameQuery, Jackpot, Leaderboard, LaunchResult, Mission, Page, Provider, Skin, Streak,
  Tournament, VipState, WheelResult, WheelStatus,
} from './types';

export { ApiError };

interface Opts { method?: string; body?: unknown; auth?: boolean; signal?: AbortSignal }
const request = <T>(path: string, opts: Opts = {}): Promise<T> => moduleRequest<T>(path, opts);

const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Resuelve rutas de imagen relativas del Hub contra la API. */
export function assetUrl(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return /^(https?:|data:)/.test(p) ? p : `${API_URL}${p.startsWith('/') ? '' : '/'}${p}`;
}

export const api = {
  games: (q: GameQuery & { page?: number }, signal?: AbortSignal) =>
    request<Page<Game>>(`/hub/v1/games${qs({ operatorId: moduleOperatorId(), pageSize: 24, ...q })}`, { signal }),
  game: (id: string) => request<Game>(`/hub/v1/games/${encodeURIComponent(id)}${qs({ operatorId: moduleOperatorId() })}`),
  providers: () => request<{ items: Provider[] }>('/hub/v1/providers'),
  launch: (id: string, mode: 'real' | 'demo', currency?: string) =>
    request<LaunchResult>(`/hub/v1/games/${encodeURIComponent(id)}/launch`, {
      // Sin moneda explícita el servidor usa la del operador/jugador.
      method: 'POST', auth: true, body: { mode, ...(currency ? { currency } : {}), operatorId: moduleOperatorId() },
    }),
  jackpots: () => request<{ jackpots: Jackpot[] }>(`/promo/v1/jackpots${qs({ operatorId: moduleOperatorId() })}`),
  skin: () => request<Skin>(`/backoffice/v1/public/skin${qs({ operatorId: moduleOperatorId() })}`),
  balance: () => request<Balance>('/studio/v1/balance', { auth: true }),
  vip: () => request<VipState>('/gamification/v1/vip', { auth: true }),
  claimRakeback: () => request<{ amount: string; period: string; currency: string }>('/gamification/v1/vip/rakeback/claim', { method: 'POST', auth: true }),
  missions: () => request<{ missions: Mission[] }>('/gamification/v1/missions', { auth: true }),
  claimMission: (id: string) => request<unknown>(`/gamification/v1/missions/${encodeURIComponent(id)}/claim`, { method: 'POST', auth: true }),
  streak: () => request<Streak>('/gamification/v1/streak', { auth: true }),
  wheel: () => request<WheelStatus>('/gamification/v1/wheel', { auth: true }),
  spinWheel: () => request<WheelResult>('/gamification/v1/wheel/spin', { method: 'POST', auth: true }),
  tournaments: () => request<{ tournaments: Tournament[] }>('/gamification/v1/tournaments', { auth: true }),
  leaderboard: (id: string) => request<Leaderboard>(`/gamification/v1/tournaments/${encodeURIComponent(id)}/leaderboard`, { auth: true }),
  joinTournament: (id: string) => request<{ joined: boolean }>(`/gamification/v1/tournaments/${encodeURIComponent(id)}/join`, { method: 'POST', auth: true }),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Error inesperado';
}
