"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { authClient, getServerSessionSnapshot, getSessionSnapshot, subscribeSession, type Session } from "./auth";
import { ApiError, request, type RequestOptions } from "./api";

export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot, getServerSessionSnapshot);
}

export interface OperatorOption { id: string; name: string }

interface OperatorCtx {
  /** Operador activo (null = plataforma sin selección). */
  operatorId: string | null;
  setOperatorId(id: string): void;
  /** Operadores de la plataforma por nombre (solo PLATFORM_ADMIN). */
  known: OperatorOption[];
}

const Ctx = createContext<OperatorCtx>({ operatorId: null, setOperatorId: () => {}, known: [] });
const OP_KEY = "nymfo.backoffice.operators";

function saveCurrent(id: string | null) {
  try { window.localStorage.setItem(OP_KEY, JSON.stringify({ current: id ?? undefined })); } catch { /* almacenamiento bloqueado */ }
}

/** PLATFORM_ADMIN elige operador; el resto queda fijado al de su sesión. */
export function OperatorProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [picked, setPicked] = useState<string | null>(null);
  const [known, setKnown] = useState<OperatorOption[]>([]);
  const isPlatform = session?.role === "PLATFORM_ADMIN";
  // La plataforma recibe la lista de operadores por nombre y, si no había uno elegido (o ya no existe), toma el primero.
  useEffect(() => {
    if (!isPlatform) return;
    let alive = true;
    let saved: string | undefined;
    try { saved = (JSON.parse(window.localStorage.getItem(OP_KEY) ?? "{}") as { current?: string }).current; } catch { /* almacenamiento corrupto */ }
    request<{ items: OperatorOption[] }>("/backoffice/v1/admin/operators")
      .then(({ items }) => {
        if (!alive) return;
        setKnown(items);
        const next = items.find((o) => o.id === saved)?.id ?? items[0]?.id ?? saved ?? null;
        setPicked(next);
        saveCurrent(next);
      })
      .catch(() => alive && setPicked(saved ?? null));
    return () => { alive = false; };
  }, [isPlatform]);
  const setOperatorId = useCallback((id: string) => {
    const clean = id.trim() || null;
    setPicked(clean);
    saveCurrent(clean);
  }, []);
  const operatorId = session ? (session.role === "PLATFORM_ADMIN" ? picked : session.operatorId) : null;
  const value = useMemo(() => ({ operatorId, setOperatorId, known }), [operatorId, setOperatorId, known]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useOperator = () => useContext(Ctx);

const CurrencyCtx = createContext<string | undefined>(undefined);

/**
 * Moneda del operador activo (Operator.defaultCurrency) por su id, vía /backoffice/v1/admin/operators/:id/currency.
 * Sin operador elegido (vista consolidada de la plataforma, que puede mezclar monedas) o si no se puede determinar,
 * queda undefined y los montos se muestran sin símbolo: nunca se asume la moneda de otro operador.
 */
export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { operatorId } = useOperator();
  const [byOp, setByOp] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!operatorId || byOp[operatorId]) return;
    let live = true;
    request<{ defaultCurrency: string }>(`/backoffice/v1/admin/operators/${encodeURIComponent(operatorId)}/currency`)
      .then((r) => {
        if (live && r.defaultCurrency) setByOp((m) => ({ ...m, [operatorId]: r.defaultCurrency }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [operatorId, byOp]);
  return <CurrencyCtx.Provider value={operatorId ? byOp[operatorId] : undefined}>{children}</CurrencyCtx.Provider>;
}

/** Moneda a usar al formatear montos del operador activo (undefined si aún se desconoce). */
export const useCurrency = () => useContext(CurrencyCtx);

/** Cliente de API con el operador activo añadido como ?operatorId= en cada llamada. */
export function useApiClient() {
  const { operatorId } = useOperator();
  const call = useCallback(
    <T,>(path: string, opts: RequestOptions = {}) => request<T>(path, { ...opts, query: { operatorId: operatorId ?? undefined, ...opts.query } }),
    [operatorId],
  );
  return { call, operatorId };
}

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** GET con estados de carga/error. `path = null` pausa la consulta (p. ej. sin operador elegido). */
export function useApi<T>(path: string | null, query?: RequestOptions["query"]): ApiState<T> {
  const { operatorId } = useOperator();
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const qKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    request<T>(path, { signal: ctl.signal, query: { operatorId: operatorId ?? undefined, ...(JSON.parse(qKey) as RequestOptions["query"]) } })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof ApiError ? e.message : "Error inesperado");
        setLoading(false);
      });
    return () => ctl.abort();
  }, [path, operatorId, qKey, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export const logout = () => authClient.logout();
