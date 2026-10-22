'use client';
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChatWidget } from '@/components/webchat/ChatWidget';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { AccountMenu, WalletChip } from './AccountMenu';
import { BottomNav, SideNav, TopNav } from './CategoryNav';
import { LobbyProvider, useLobby } from './LobbyProvider';
import { SearchBox } from './SearchBox';
import { VipProgressBar } from './VipProgressBar';

const COLLAPSE_KEY = 'abyss.lobby.sidebarCollapsed';
const DEFAULT_LOGO = '/brand/infinite-abyss-logo.svg';
const DEFAULT_MARK = '/brand/infinite-abyss-mark.svg';

/** Logo del operador con respaldo a la marca por defecto si la imagen falla. */
function Logo({ variant, className }: { variant: 'full' | 'mark'; className: string }) {
  const { skin } = useLobby();
  const fallback = variant === 'mark' ? DEFAULT_MARK : DEFAULT_LOGO;
  const own = variant === 'full' ? skin.logoUrl : null;
  const [broken, setBroken] = useState(false);
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={own && !broken ? own : fallback} onError={() => setBroken(true)} alt={`Logotipo de ${skin.name}`} className={className} />;
}

function useCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* almacenamiento bloqueado */ }
  }, []);
  const toggle = useCallback(() => setCollapsed((c) => {
    try { window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1'); } catch { /* almacenamiento bloqueado */ }
    return !c;
  }), []);
  return [collapsed, toggle];
}

/** Panel modal (menú o búsqueda en móvil): Escape cierra, foco atrapado y bloqueo del scroll de fondo. */
function useModal(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])') ?? []);
    (focusables()[0] ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, close, ref]);
}

function Shell({ children }: { children: ReactNode }) {
  const { vip, site } = useLobby();
  const topbar = site?.config.layout.nav === 'topbar';
  const path = usePathname();
  const [collapsed, toggleCollapsed] = useCollapsed();
  const [drawer, setDrawer] = useState(false);
  const [search, setSearch] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const closeSearch = useCallback(() => setSearch(false), []);
  useModal(drawer, closeDrawer, drawerRef);
  useModal(search, closeSearch, searchRef);
  // Al navegar se cierran los paneles móviles.
  useEffect(() => { setDrawer(false); setSearch(false); }, [path]);

  return (
    <div className="flex min-h-screen">
      <a href="#nf-main" className="nf-skip">Saltar al contenido</a>

      {!topbar && <aside data-collapsed={collapsed} className="nf-side sticky top-0 hidden h-screen shrink-0 flex-col lg:flex" aria-label="Menú lateral">
        <div className={`flex h-16 items-center border-b border-[var(--nf-border)] px-3 ${collapsed ? 'justify-center' : 'justify-between'}`}>
          {!collapsed && <Link href="/lobby" aria-label="Ir al inicio"><Logo variant="full" className="h-9 w-auto" /></Link>}
          <button type="button" onClick={toggleCollapsed} className="nf-square-btn" aria-label={collapsed ? 'Expandir menú' : 'Contraer menú'} aria-expanded={!collapsed}>
            {collapsed ? <PanelLeftOpen aria-hidden className="h-4 w-4" /> : <PanelLeftClose aria-hidden className="h-4 w-4" />}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          <SideNav collapsed={collapsed} />
        </div>
        {!collapsed && vip && <div className="border-t border-[var(--nf-border)] p-3"><VipProgressBar vip={vip} /></div>}
      </aside>}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="nf-top sticky top-0 z-30">
          <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-3 px-3 sm:px-5">
            <Link href="/lobby" className={`flex shrink-0 items-center ${topbar ? '' : 'lg:hidden'}`} aria-label="Ir al inicio">
              <Logo variant="mark" className="h-9 w-9 sm:hidden" />
              <Logo variant="full" className="hidden h-9 w-auto sm:block" />
            </Link>
            <div className="hidden min-w-0 flex-1 md:block lg:max-w-sm">
              <Suspense fallback={<div className="h-10" />}><SearchBox /></Suspense>
            </div>
            <div className="ml-auto flex items-center gap-2 md:ml-0 md:flex-1 md:justify-center"><WalletChip /></div>
            <div className="flex items-center gap-2">
              <div className="hidden xl:block"><VipProgressBar vip={vip} compact /></div>
              <AccountMenu />
            </div>
          </div>
          {topbar && <TopNav />}
        </header>
        <main id="nf-main" tabIndex={-1} className="mx-auto w-full max-w-[1240px] flex-1 space-y-8 px-3 pb-28 pt-5 outline-none sm:px-5 lg:pb-10">
          {children}
        </main>
      </div>

      <ChatWidget />

      <div className="nf-bottom fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <BottomNav menuOpen={drawer} onMenu={() => setDrawer((d) => !d)} onSearch={() => setSearch(true)} />
      </div>

      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="nf-drawer-backdrop absolute inset-0" onClick={closeDrawer} aria-hidden />
          <div id="nf-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label="Menú" tabIndex={-1}
            className="nf-side absolute inset-y-0 left-0 flex w-[min(19rem,85vw)] flex-col shadow-2xl outline-none">
            <div className="flex h-16 items-center justify-between border-b border-[var(--nf-border)] px-3">
              <Logo variant="full" className="h-9 w-auto" />
              <button type="button" onClick={closeDrawer} className="nf-square-btn" aria-label="Cerrar menú"><X aria-hidden className="h-4 w-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2"><SideNav onNavigate={closeDrawer} /></div>
            {vip && <div className="border-t border-[var(--nf-border)] p-3"><VipProgressBar vip={vip} /></div>}
          </div>
        </div>
      )}

      {search && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="nf-drawer-backdrop absolute inset-0" onClick={closeSearch} aria-hidden />
          <div ref={searchRef} role="dialog" aria-modal="true" aria-label="Buscar juegos" className="nf-top absolute inset-x-0 top-0 flex items-center gap-2 p-3">
            <Suspense fallback={<div className="h-10 flex-1" />}><SearchBox onSubmitted={closeSearch} /></Suspense>
            <button type="button" onClick={closeSearch} className="nf-square-btn shrink-0" aria-label="Cerrar búsqueda"><X aria-hidden className="h-4 w-4" /></button>
          </div>
        </div>
      )}
    </div>
  );
}

export function LobbyShell({ children }: { children: ReactNode }) {
  return <LobbyProvider><Shell>{children}</Shell></LobbyProvider>;
}
