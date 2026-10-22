'use client';
import Link from 'next/link';
import { Gamepad2, LogIn, LogOut, UserCircle, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/lobby/format';
import { useLobby } from './LobbyProvider';

/** Navegación de cuenta de la Fase 1 dentro del lobby: login/registro, cajero, cuenta y salida. */
export function AccountMenu() {
  const { status, logout } = useAuth();
  const { balance } = useLobby();
  if (status === 'loading') return <div role="status" aria-label="Cargando sesión" className="h-8 w-24 animate-pulse rounded-full bg-white/10" />;
  if (status !== 'authenticated') {
    return (
      <nav aria-label="Cuenta" className="flex items-center gap-2 text-sm">
        <span className="hidden sm:block"><Link href="/classic" className="nf-btn" aria-label="Juegos clásicos"><Gamepad2 aria-hidden className="inline h-4 w-4" /> Clásicos</Link></span>
        <Link href="/login" className="nf-btn"><LogIn aria-hidden className="inline h-4 w-4" /> Entrar</Link>
        <Link href="/register" className="nf-btn nf-btn-primary">Crear cuenta</Link>
      </nav>
    );
  }
  return (
    <nav aria-label="Cuenta" className="flex items-center gap-2 text-sm">
      <div className="nf-panel flex items-center gap-2 px-3 py-1.5 font-semibold" role="status" aria-label="Saldo" aria-live="polite">
        <Wallet aria-hidden className="h-4 w-4" />{balance ? formatMoney(balance.balance, balance.currency) : '—'}
      </div>
      <Link href="/cashier" className="nf-btn nf-btn-primary">Cajero</Link>
      <span className="hidden md:block"><Link href="/classic" className="nf-btn">Clásicos</Link></span>
      <Link href="/account" className="nf-btn" aria-label="Mi cuenta"><UserCircle aria-hidden className="inline h-4 w-4" /><span className="hidden sm:inline"> Mi cuenta</span></Link>
      <button type="button" onClick={() => void logout()} className="nf-btn" aria-label="Cerrar sesión"><LogOut aria-hidden className="inline h-4 w-4" /></button>
    </nav>
  );
}
