"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, refreshSession, tokens, type Balances, type PlayerUser } from "./api";

type AuthStatus = "loading" | "anonymous" | "authenticated";

type AuthResponse = { accessToken: string; refreshToken: string; user: PlayerUser };
type MeResponse = { user: PlayerUser; balances?: Balances };

type AuthState = {
  status: AuthStatus;
  user: PlayerUser | null;
  balances: Balances | null;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { email: string; password: string; username?: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Recarga usuario y saldos desde /api/me. */
  reloadMe: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<PlayerUser | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);

  const reloadMe = useCallback(async () => {
    const me = await api.get<MeResponse>("/api/me");
    setUser(me.user);
    setBalances(me.balances ?? null);
  }, []);

  // Restaura la sesión al cargar: refresh token (localStorage) → access token (memoria).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tokens.getRefresh()) {
        setStatus("anonymous");
        return;
      }
      const access = await refreshSession();
      if (cancelled) return;
      if (!access) {
        setStatus("anonymous");
        return;
      }
      try {
        await reloadMe();
        if (!cancelled) setStatus("authenticated");
      } catch {
        if (!cancelled) setStatus("anonymous");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadMe]);

  // Si el refresh falla en cualquier parte, la sesión se da por terminada.
  useEffect(
    () =>
      tokens.onAccessChange((token) => {
        if (!token && !tokens.getRefresh()) {
          setUser(null);
          setBalances(null);
          setStatus("anonymous");
        }
      }),
    [],
  );

  const applySession = useCallback(
    async (res: AuthResponse) => {
      tokens.setRefresh(res.refreshToken);
      tokens.setAccess(res.accessToken);
      setUser(res.user);
      try {
        await reloadMe();
      } catch {
        /* /api/me puede fallar momentáneamente; el usuario ya está autenticado */
      }
      setStatus("authenticated");
    },
    [reloadMe],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<AuthResponse>("/api/auth/login", { email, password }, { scope: "none" });
      await applySession(res);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: { email: string; password: string; username?: string }) => {
      const res = await api.post<AuthResponse>("/api/auth/register", input, { scope: "none" });
      await applySession(res);
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    const refreshToken = tokens.getRefresh();
    try {
      await api.post("/api/auth/logout", { refreshToken }, { scope: "none" });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    tokens.setRefresh(null);
    tokens.setAccess(null);
    setUser(null);
    setBalances(null);
    setStatus("anonymous");
  }, []);

  const value = useMemo(
    () => ({ status, user, balances, login, register, logout, reloadMe }),
    [status, user, balances, login, register, logout, reloadMe],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return ctx;
}
