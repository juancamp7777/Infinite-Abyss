'use client';
import { useCallback, useSyncExternalStore } from 'react';

/** Listas persistidas en localStorage (favoritos y recientes), sincronizadas entre pestañas y componentes. */
const FAV_KEY = 'nymfo.lobby.favorites';
const REC_KEY = 'nymfo.lobby.recent';
const MAX_RECENT = 24;
const EMPTY: string[] = [];
const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: string[] }>();

function read(key: string): string[] {
  if (typeof window === 'undefined') return EMPTY;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(key); } catch { /* bloqueado */ }
  const c = cache.get(key);
  if (c && c.raw === raw) return c.value;
  let value = EMPTY;
  try {
    const p = raw ? JSON.parse(raw) : [];
    if (Array.isArray(p)) value = p.filter((x): x is string => typeof x === 'string');
  } catch { /* corrupto */ }
  cache.set(key, { raw, value });
  return value;
}
function write(key: string, value: string[]): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin espacio */ }
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === FAV_KEY || e.key === REC_KEY) cb(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

export function useFavorites() {
  const ids = useSyncExternalStore(subscribe, () => read(FAV_KEY), () => EMPTY);
  const toggle = useCallback((id: string) => {
    const cur = read(FAV_KEY);
    write(FAV_KEY, cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur]);
  }, []);
  return { ids, has: (id: string) => ids.includes(id), toggle };
}

export function useRecent() {
  return useSyncExternalStore(subscribe, () => read(REC_KEY), () => EMPTY);
}
export function pushRecent(id: string): void {
  write(REC_KEY, [id, ...read(REC_KEY).filter((x) => x !== id)].slice(0, MAX_RECENT));
}
