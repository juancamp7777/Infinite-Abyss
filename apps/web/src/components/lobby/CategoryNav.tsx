'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clock, Crown, Flame, Gamepad2, Heart, Home, Layers, Radio, Sparkles, Trophy, Building2, type LucideIcon } from 'lucide-react';

export interface NavItem { label: string; href: string; icon: LucideIcon }
export const NAV_ITEMS: NavItem[] = [
  { label: 'Inicio', href: '/lobby', icon: Home },
  { label: 'Originals', href: '/lobby/category/originals', icon: Gamepad2 },
  { label: 'Slots', href: '/lobby/category/slots', icon: Layers },
  { label: 'Live', href: '/lobby/category/live', icon: Radio },
  { label: 'Nuevos', href: '/lobby/category/new', icon: Sparkles },
  { label: 'Populares', href: '/lobby/category/popular', icon: Flame },
  { label: 'Proveedores', href: '/lobby/category/providers', icon: Building2 },
  { label: 'Favoritos', href: '/lobby/favorites', icon: Heart },
  { label: 'Recientes', href: '/lobby/recent', icon: Clock },
  { label: 'Torneos', href: '/lobby/tournaments', icon: Trophy },
  { label: 'VIP', href: '/lobby/vip', icon: Crown },
];
export const MOBILE_ITEMS = ['Inicio', 'Slots', 'Originals', 'Torneos', 'VIP'];

function active(path: string, href: string): boolean {
  return href === '/lobby' ? path === '/lobby' : path === href || path.startsWith(`${href}/`);
}

export function CategoryNav({ variant }: { variant: 'sidebar' | 'bottom' }) {
  const path = usePathname();
  const items = variant === 'bottom' ? NAV_ITEMS.filter((i) => MOBILE_ITEMS.includes(i.label)) : NAV_ITEMS;
  return (
    <nav aria-label={variant === 'bottom' ? 'Navegación móvil' : 'Categorías'} className={variant === 'bottom' ? 'flex justify-around' : 'flex flex-col gap-1'}>
      {items.map(({ label, href, icon: Icon }) => {
        const on = active(path, href);
        return (
          <Link key={href} href={href} aria-current={on ? 'page' : undefined} className={`nf-nav ${on ? 'nf-nav-on' : ''} ${variant === 'bottom' ? 'flex-col gap-0.5 px-2 py-1 text-[11px]' : ''}`}>
            <Icon aria-hidden className="h-4 w-4 shrink-0" /> {label}
          </Link>
        );
      })}
    </nav>
  );
}
