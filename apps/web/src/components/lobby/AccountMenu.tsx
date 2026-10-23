'use client';
import { useT } from "@/lib/i18n";
import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Crown, Gamepad2, LogOut, ShieldCheck, UserCircle, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/lobby/format';
import { useLobby } from './LobbyProvider';

/** Saldo + Depositar (centro del header en escritorio). Solo con sesión. */
export function WalletChip() {
  const { t } = useT();
  const { status } = useAuth();
  const { balance } = useLobby();
  if (status !== 'authenticated') return null;
  return (
    <div className="flex items-stretch overflow-hidden rounded-lg border border-[var(--nf-border)] bg-[color-mix(in_srgb,var(--nf-bg)_70%,var(--nf-surface))]">
      <div role="status" aria-label={t("Saldo")} aria-live="polite" className="flex items-center gap-2 px-3 py-1.5 text-sm font-bold tabular-nums">
        <Wallet aria-hidden className="h-4 w-4 text-[var(--nf-primary)]" />
        {balance ? formatMoney(balance.balance, balance.currency) : '—'}
        {balance?.currency && <span className="text-xs font-semibold text-[var(--nf-muted)]">{balance.currency}</span>}
      </div>
      <Link href="/cashier" className="nf-btn nf-btn-primary rounded-none px-4">{t("Depositar")}</Link>
    </div>
  );
}

/** Acciones de cuenta: entrar/registrarse sin sesión; menú de usuario con sesión. */
export function AccountMenu() {
  const { t } = useT();
  const { status, user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (status === 'loading') return <div role="status" aria-label={t("Cargando sesión")} className="h-9 w-28 animate-pulse rounded-lg bg-white/10" />;
  if (status !== 'authenticated') {
    return (
      <nav aria-label={t("Cuenta")} className="flex items-center gap-2 text-sm">
        <Link href="/login" className="nf-btn nf-btn-ghost">{t("Entrar")}</Link>
        <Link href="/register" className="nf-btn nf-btn-primary">{t("Registrarse")}</Link>
      </nav>
    );
  }
  const item = 'flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-[var(--nf-surface-3)]';
  return (
    <div ref={box} className="relative">
      <button
        type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}
        className="nf-btn nf-btn-ghost px-2" aria-label={t("Menú de usuario")}
      >
        <UserCircle aria-hidden className="h-5 w-5" />
        <span className="hidden max-w-32 truncate sm:inline">{user?.username || user?.email?.split('@')[0] || t("Mi cuenta")}</span>
        <ChevronDown aria-hidden className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={t("Cuenta")} className="nf-panel-2 absolute right-0 top-[calc(100%+.5rem)] z-50 w-56 p-1.5 shadow-2xl">
          <Link role="menuitem" href="/cashier" className={item} onClick={() => setOpen(false)}><Wallet aria-hidden className="h-4 w-4" />{t("Cajero")}</Link>
          <Link role="menuitem" href="/account" className={item} onClick={() => setOpen(false)}><UserCircle aria-hidden className="h-4 w-4" />{t("Mi cuenta")}</Link>
          <Link role="menuitem" href="/lobby/vip" className={item} onClick={() => setOpen(false)}><Crown aria-hidden className="h-4 w-4" />{t("VIP")}</Link>
          <Link role="menuitem" href="/account#limits-title" className={item} onClick={() => setOpen(false)}><ShieldCheck aria-hidden className="h-4 w-4" />{t("Juego responsable")}</Link>
          <Link role="menuitem" href="/classic" className={item} onClick={() => setOpen(false)}><Gamepad2 aria-hidden className="h-4 w-4" />{t("Juegos clásicos")}</Link>
          <hr aria-hidden className="my-1 border-[var(--nf-border)]" />
          <button role="menuitem" type="button" className={`${item} w-full text-left`} onClick={() => { setOpen(false); void logout(); }}>
            <LogOut aria-hidden className="h-4 w-4" />{t("Cerrar sesión")}
          </button>
        </div>
      )}
    </div>
  );
}
