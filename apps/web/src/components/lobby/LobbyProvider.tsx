'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/lobby/api';
import { DEFAULT_SKIN, skinStyle } from '@/lib/lobby/theme';
import type { Balance, Skin, VipState } from '@/lib/lobby/types';

interface Ctx { skin: Skin; balance: Balance | null; vip: VipState | null; refresh: () => void }
const LobbyCtx = createContext<Ctx>({ skin: DEFAULT_SKIN, balance: null, vip: null, refresh: () => {} });
export const useLobby = () => useContext(LobbyCtx);

/** Inyecta el tema del operador como variables CSS y comparte saldo y progreso VIP. */
export function LobbyProvider({ children }: { children: ReactNode }) {
  const { brand } = useTheme();
  const { status } = useAuth();
  const [apiSkin, setApiSkin] = useState<Partial<Skin> | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [vip, setVip] = useState<VipState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status === 'loading') return;
    api.skin().then(setApiSkin, () => {});
  }, [status]);
  // Saldo y VIP solo con sesión real; sin sesión el lobby funciona en modo demo/catálogo.
  useEffect(() => {
    if (status !== 'authenticated') { setBalance(null); setVip(null); return; }
    let alive = true;
    api.balance().then((b) => { if (alive) setBalance(b); }, () => { if (alive) setBalance(null); });
    api.vip().then((v) => { if (alive) setVip(v); }, () => { if (alive) setVip(null); });
    return () => { alive = false; };
  }, [tick, status]);
  // La marca de la Fase 1 (nombre, logo, colores) manda; el skin del backoffice aporta banners y rellena colores vacíos.
  const skin = useMemo<Skin>(() => {
    const own = Object.fromEntries(Object.entries(brand.colors ?? {}).filter(([, v]) => typeof v === 'string' && v)) as Partial<Skin['colors']>;
    return {
      ...DEFAULT_SKIN,
      ...apiSkin,
      name: brand.displayName || apiSkin?.name || DEFAULT_SKIN.name,
      logoUrl: brand.logoUrl ?? apiSkin?.logoUrl ?? null,
      colors: { ...DEFAULT_SKIN.colors, ...apiSkin?.colors, ...own },
      banners: apiSkin?.banners?.length ? apiSkin.banners : DEFAULT_SKIN.banners,
    };
  }, [brand, apiSkin]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(() => ({ skin, balance, vip, refresh }), [skin, balance, vip, refresh]);
  return <LobbyCtx.Provider value={value}><div className="nf-root" style={skinStyle(skin.colors)}>{children}</div></LobbyCtx.Provider>;
}
