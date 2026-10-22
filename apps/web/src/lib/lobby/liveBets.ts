'use client';
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { socketTarget } from '../api';
import { api } from './api';
import { moduleOperatorId, playerBearer } from './config';
import { useAuthReady } from './hooks';
import type { FeedBet } from './types';
import { EMPTY_LISTS, LIVE_MAX, mergeBatch, prepend, type LiveLists } from './liveFeed';

export { EMPTY_LISTS, LIVE_MAX, formatMultiplier, mergeBatch, prepend, profitOf, timeOf, type LiveLists, type LiveTab } from './liveFeed';

/**
 * Apuestas en vivo del lobby: snapshot + lotes por socket (/feed). Con sesión, el socket se autentica y
 * además llegan las apuestas propias. Si el socket no conecta, carga una vez por HTTP.
 * `fresh` marca las apuestas recién llegadas (para animarlas).
 */
function useLiveBetsSource() {
  const { ready, authenticated } = useAuthReady();
  const [lists, setLists] = useState<LiveLists>(EMPTY_LISTS);
  const [connected, setConnected] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let fellBack = false;
    const token = authenticated ? playerBearer() : null;
    const t = socketTarget('/feed');
    const s: Socket = io(t.url, {
      path: t.path, addTrailingSlash: t.addTrailingSlash, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000,
      query: { operatorId: moduleOperatorId() }, ...(token ? { auth: { token } } : {}),
    });
    const markFresh = (ids: string[]) => {
      setFresh(new Set(ids));
      setTimeout(() => { if (alive) setFresh(new Set()); }, 600);
    };
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('feed:snapshot', (snap: Partial<LiveLists>) => {
      setLists({
        mine: (snap.mine ?? []).slice(0, LIVE_MAX), all: (snap.all ?? []).slice(0, LIVE_MAX),
        high: (snap.high ?? []).slice(0, LIVE_MAX), lucky: (snap.lucky ?? []).slice(0, LIVE_MAX),
      });
    });
    s.on('feed:bets', (batch: FeedBet[]) => {
      if (!Array.isArray(batch) || batch.length === 0) return;
      setLists((cur) => mergeBatch(cur, batch));
      markFresh(batch.map((b) => b.id));
    });
    s.on('feed:mine', (bet: FeedBet) => setLists((cur) => ({ ...cur, mine: prepend(cur.mine, [{ ...bet, isMe: true }]) })));
    s.on('connect_error', () => {
      if (fellBack) return;
      fellBack = true;
      Promise.all((['all', 'high', 'lucky'] as const).map((k) => api.feed(k).then((r) => [k, r.bets] as const)))
        .then((rs) => { if (alive) setLists((cur) => ({ ...cur, ...Object.fromEntries(rs) })); })
        .catch(() => { /* sin feed: la tabla muestra su estado vacío */ });
    });
    return () => { alive = false; s.close(); };
  }, [ready, authenticated]);

  return { lists, connected, fresh };
}

type LiveFeed = ReturnType<typeof useLiveBetsSource>;
const LiveFeedCtx = createContext<LiveFeed | null>(null);

/** Una sola conexión al feed para toda la página (tabla de apuestas y tira de últimas ganancias). */
export function LiveFeedProvider({ children }: { children: ReactNode }) {
  return createElement(LiveFeedCtx.Provider, { value: useLiveBetsSource() }, children);
}

/** Feed compartido; fuera de LiveFeedProvider lanza para no abrir sockets duplicados por error. */
export function useLiveBets(): LiveFeed {
  const ctx = useContext(LiveFeedCtx);
  if (!ctx) throw new Error('useLiveBets debe usarse dentro de LiveFeedProvider');
  return ctx;
}
