'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, errorMessage } from './api';
import { useAuth } from '@/lib/auth';
import { moduleOperatorId, playerBearer } from './config';
import { socketTarget } from '../api';
import type { Game, GameQuery, Jackpot, Leaderboard } from './types';

/** true cuando la sesión ya se resolvió (evita pedir datos con token a medias tras recargar). */
export function useAuthReady(): { ready: boolean; authenticated: boolean } {
  const { status } = useAuth();
  return { ready: status !== 'loading', authenticated: status === 'authenticated' };
}

export interface AsyncState<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Carga asíncrona con estados loading/error; se repite cuando cambia `key`. */
export function useAsync<T>(fn: () => Promise<T>, key: string): AsyncState<T> {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const { ready, authenticated } = useAuthReady();
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef.current().then(
      (data) => { if (alive) setState({ data, error: null, loading: false }); },
      (e) => { if (alive) setState({ data: null, error: errorMessage(e), loading: false }); },
    );
    return () => { alive = false; };
  }, [key, tick, ready, authenticated]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function useDebounce<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Catálogo paginado (acumula páginas). */
export function useGames(query: GameQuery, enabledIn = true) {
  const { ready } = useAuthReady();
  const enabled = enabledIn && ready;
  const key = JSON.stringify(query);
  const [state, setState] = useState<{ items: Game[]; total: number; page: number; loading: boolean; error: string | null }>({ items: [], total: 0, page: 0, loading: enabledIn, error: null });
  const [tick, setTick] = useState(0);
  const [wantPage, setWantPage] = useState(1);
  const lastKey = useRef(key);
  useEffect(() => {
    if (lastKey.current !== key) { lastKey.current = key; setWantPage(1); }
  }, [key]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const page = lastKey.current === key ? wantPage : 1;
    setState((s) => ({ ...s, loading: true, error: null, ...(page === 1 ? { items: [] } : {}) }));
    api.games({ ...query, page }).then(
      (r) => { if (alive) setState((s) => ({ items: page === 1 ? r.items : [...s.items, ...r.items], total: r.total, page, loading: false, error: null })); },
      (e) => { if (alive) setState((s) => ({ ...s, loading: false, error: errorMessage(e) })); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wantPage, tick, enabled]);
  const hasMore = state.items.length < state.total;
  return {
    ...state,
    hasMore,
    loadMore: () => setWantPage(state.page + 1),
    reload: () => { setWantPage(1); setTick((t) => t + 1); },
  };
}

/** Jackpots: carga inicial por HTTP y actualización en vivo por socket /promotions. */
export function useJackpots() {
  const initial = useAsync(() => api.jackpots().then((r) => r.jackpots), 'jackpots');
  const [live, setLive] = useState<Jackpot[] | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const t = socketTarget('/promotions');
    const s: Socket = io(t.url, { path: t.path, addTrailingSlash: t.addTrailingSlash, query: { operatorId: moduleOperatorId() }, transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('jackpot:update', (p: Jackpot[] | { jackpots: Jackpot[] }) => setLive(Array.isArray(p) ? p : p.jackpots ?? []));
    return () => { s.close(); };
  }, []);
  return { ...initial, data: live ?? initial.data, connected };
}

/** Tabla de un torneo en vivo (socket /gamification) con carga HTTP de respaldo. */
export function useLiveLeaderboard(id: string) {
  const { authenticated } = useAuthReady();
  const http = useAsync(() => api.leaderboard(id), `lb:${id}`);
  const [live, setLive] = useState<Leaderboard | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const token = playerBearer();
    if (!token) return;
    const t = socketTarget('/gamification');
    const s: Socket = io(t.url, { path: t.path, addTrailingSlash: t.addTrailingSlash, auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 8000 });
    const sub = () => s.emit('tournament:subscribe', { id }, (r: { ok?: boolean; leaderboard?: Leaderboard }) => { if (r?.ok && r.leaderboard) setLive(r.leaderboard); });
    s.on('connect', () => { setConnected(true); sub(); });
    s.on('disconnect', () => setConnected(false));
    s.on('tournament:leaderboard', (lb: Leaderboard) => { if (lb.tournamentId === id) setLive((cur) => ({ ...(cur ?? lb), ...lb })); });
    return () => { s.emit('tournament:unsubscribe', { id }); s.close(); };
  }, [id, authenticated]);
  return { ...http, data: live ?? http.data, connected };
}

/** Resuelve una lista de ids (favoritos/recientes) a juegos; ignora los que ya no existen. */
export function useGamesByIds(ids: string[]) {
  const key = ids.join(',');
  const [state, setState] = useState<{ items: Game[]; loading: boolean }>({ items: [], loading: ids.length > 0 });
  useEffect(() => {
    let alive = true;
    if (ids.length === 0) { setState({ items: [], loading: false }); return; }
    setState((s) => ({ ...s, loading: true }));
    Promise.allSettled(ids.map((id) => api.game(id))).then((rs) => {
      if (!alive) return;
      setState({ items: rs.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])), loading: false });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
