'use client';
import { useT } from "@/lib/i18n";
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2, Clock, Crown, Dices, Flame, Gamepad2, Heart, Home, Layers, Menu, Radio, Search, Sparkles, Trophy, type LucideIcon,
} from 'lucide-react';

export interface NavItem { label: string; href: string; icon: LucideIcon }
export interface NavSection { title: string; items: NavItem[] }

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Casino',
    items: [
      { label: 'Inicio', href: '/lobby', icon: Home },
      { label: 'Favoritos', href: '/lobby/favorites', icon: Heart },
      { label: 'Recientes', href: '/lobby/recent', icon: Clock },
    ],
  },
  {
    title: 'Juegos',
    items: [
      { label: 'Originals', href: '/lobby/category/originals', icon: Gamepad2 },
      { label: 'Slots', href: '/lobby/category/slots', icon: Layers },
      { label: 'Casino en vivo', href: '/lobby/category/live', icon: Radio },
      { label: 'Mesa', href: '/lobby/category/table', icon: Dices },
      { label: 'Nuevos', href: '/lobby/category/new', icon: Sparkles },
      { label: 'Populares', href: '/lobby/category/popular', icon: Flame },
      { label: 'Proveedores', href: '/lobby/category/providers', icon: Building2 },
    ],
  },
  {
    title: 'Promociones',
    items: [
      { label: 'Torneos', href: '/lobby/tournaments', icon: Trophy },
      { label: 'VIP', href: '/lobby/vip', icon: Crown },
    ],
  },
];
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

export function isActive(path: string, href: string): boolean {
  return href === '/lobby' ? path === '/lobby' : path === href || path.startsWith(`${href}/`);
}

/** Menú lateral por secciones. Colapsado muestra solo íconos (con nombre accesible y tooltip). */
export function SideNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { t } = useT();
  const path = usePathname();
  return (
    <nav aria-label={t("Categorías")} className="flex flex-col gap-1">
      {NAV_SECTIONS.map((s) => (
        <div key={s.title} className="flex flex-col gap-0.5">
          {collapsed ? <hr aria-hidden className="mx-3 my-2 border-[var(--nf-border)]" /> : <p className="nf-nav-title">{t(s.title)}</p>}
          {s.items.map(({ label, href, icon: Icon }) => {
            const on = isActive(path, href);
            return (
              <Link
                key={href} href={href} onClick={onNavigate} aria-current={on ? 'page' : undefined}
                title={collapsed ? t(label) : undefined} aria-label={collapsed ? t(label) : undefined}
                className={`nf-nav ${on ? 'nf-nav-on' : ''} ${collapsed ? 'justify-center px-0' : ''}`}
              >
                <Icon aria-hidden className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && <span className="truncate">{t(label)}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

const BOTTOM: NavItem[] = [
  { label: 'Inicio', href: '/lobby', icon: Home },
  { label: 'Originals', href: '/lobby/category/originals', icon: Gamepad2 },
  { label: 'Slots', href: '/lobby/category/slots', icon: Layers },
  { label: 'VIP', href: '/lobby/vip', icon: Crown },
];

/** Barra inferior del móvil: menú, accesos principales y búsqueda. */
export function BottomNav({ onMenu, onSearch, menuOpen }: { onMenu: () => void; onSearch: () => void; menuOpen: boolean }) {
  const { t } = useT();
  const path = usePathname();
  const cls = 'nf-nav flex-1 flex-col gap-0.5 px-1 py-1.5 text-[11px] justify-center';
  return (
    <nav aria-label={t("Navegación móvil")} className="flex items-stretch px-1 pb-[env(safe-area-inset-bottom)]">
      <button type="button" onClick={onMenu} aria-expanded={menuOpen} aria-controls="nf-drawer" className={cls}>
        <Menu aria-hidden className="h-5 w-5" />Menú
      </button>
      {BOTTOM.map(({ label, href, icon: Icon }) => {
        const on = isActive(path, href);
        return (
          <Link key={href} href={href} aria-current={on ? 'page' : undefined} className={`${cls} ${on ? 'text-[var(--nf-primary)]' : ''}`}>
            <Icon aria-hidden className="h-5 w-5" />{t(label)}
          </Link>
        );
      })}
      <button type="button" onClick={onSearch} className={cls}>
        <Search aria-hidden className="h-5 w-5" />Buscar
      </button>
    </nav>
  );
}

const TOP: NavItem[] = NAV_ITEMS.filter((i) => i.href !== '/lobby/favorites' && i.href !== '/lobby/recent');

/** Menú horizontal de escritorio (plantillas Reef con navegación superior). */
export function TopNav() {
  const { t } = useT();
  const path = usePathname();
  return (
    <nav aria-label={t("Categorías")} className="nf-topnav mx-auto hidden max-w-[1240px] px-3 sm:px-5 lg:flex">
      {TOP.map(({ label, href, icon: Icon }) => {
        const on = isActive(path, href);
        return (
          <Link key={href} href={href} aria-current={on ? 'page' : undefined} className={`nf-nav ${on ? 'nf-nav-on' : ''}`}>
            <Icon aria-hidden className="h-4 w-4 shrink-0" />{t(label)}
          </Link>
        );
      })}
    </nav>
  );
}
