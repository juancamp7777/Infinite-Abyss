'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { api } from '@/lib/lobby/api';
import { DEFAULT_SKIN, skinStyle } from '@/lib/lobby/theme';
import { reefStyle, useReefSite, type ReefSite } from '@/lib/reef';
import type { Balance, Skin, VipState } from '@/lib/lobby/types';

interface Ctx { skin: Skin; site: ReefSite | null | undefined; balance: Balance | null; vip: VipState | null; refresh: () => void }
const LobbyCtx = createContext<Ctx>({ skin: DEFAULT_SKIN, site: undefined, balance: null, vip: null, refresh: () => {} });
export const useLobby = () => useContext(LobbyCtx);

/** Inyecta el tema del operador como variables CSS y comparte saldo y progreso VIP. */
export function LobbyProvider({ children }: { children: ReactNode }) {
  const { brand, operator, status: themeStatus } = useTheme();
  // La plantilla se pide cuando la marca ya resolvió el operador (por dominio); sin id, por host.
  const themeOperatorId = themeStatus === "loading" ? null : operator.id;
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
  const reef = useReefSite(themeOperatorId);
  // Reef publicado: marca, colores y banners de la plantilla del operador.
  const finalSkin = useMemo<Skin>(() => (reef ? {
    name: reef.config.brand.siteName, logoUrl: reef.config.brand.logoUrl ?? skin.logoUrl, colors: reef.config.colors,
    banners: reef.config.banners.length ? reef.config.banners.map((b) => ({ title: b.title, subtitle: b.subtitle, href: b.href, imageUrl: b.imageUrl, cta: b.cta })) : skin.banners,
  } : skin), [reef, skin]);
  const value = useMemo(() => ({ skin: finalSkin, site: reef, balance, vip, refresh }), [finalSkin, reef, balance, vip, refresh]);
  const layout = reef?.config.layout;
  // Mientras se resuelve la plantilla no se pinta el lobby (evita el "flash" de otro diseño).
  return (
    <LobbyCtx.Provider value={value}>
      <div className="nf-root" data-template={reef?.config.template ?? 'abyss'} data-nav={layout?.nav ?? 'sidebar'} data-cards={layout?.cards ?? 'portrait'}
        style={{ ...skinStyle(finalSkin.colors), ...reefStyle(reef?.config), ...(reef === undefined ? { visibility: 'hidden' as const } : {}) }}>
        {reef?.preview && <div className="sticky top-0 z-[60] bg-amber-400 px-3 py-1 text-center text-xs font-bold text-black">Vista previa del borrador de Reef · no visible para jugadores</div>}
        {children}
      </div>
    </LobbyCtx.Provider>
  );
}
