'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/lobby/format';
import { useAsync } from '@/lib/lobby/hooks';
import { hhmm, lev, prizePool } from '@/lib/leviathan';

/** Cuenta regresiva corta: "12:34" o "2 h 05 min". */
function left(ms: number) {
  if (ms <= 0) return '0:00';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Concurso de Leviathan destacado en el inicio del lobby, con cuenta regresiva para inscribirse. */
export function LeviathanSpotlight() {
  const { t } = useT();
  const { status } = useAuth();
  const games = useAsync(() => (status === 'authenticated' ? lev.lobby().catch(() => []) : Promise.resolve([])), `lev-spot-${status}`);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Primero el que tiene inscripciones abiertas; si no, el que está en juego.
  const g = games.data?.find((x) => x.status === 'OPEN' && Date.parse(x.entriesCloseAt) > now) ?? games.data?.find((x) => x.status === 'RUNNING');
  if (!g) return null;
  const open = g.status === 'OPEN';
  return (
    <Link href={`/lobby/leviathan/${g.id}`} aria-label={`${t('Concurso')} ${g.title}`}
      className="group relative block overflow-hidden rounded-2xl border border-[var(--nf-primary)]/40 p-4 sm:p-5"
      style={{ background: 'radial-gradient(120% 140% at 0% 0%, rgba(14,165,233,.28), transparent 55%), radial-gradient(120% 140% at 100% 100%, rgba(234,179,8,.22), transparent 55%), var(--nf-surface)' }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-bold uppercase tracking-[.25em] text-[var(--nf-primary)]">⚔️ Leviathan · {open ? t('Inscripciones abiertas') : t('En juego')}</p>
          <p className="text-xl font-extrabold sm:text-2xl">{g.title}</p>
          <p className="text-sm opacity-85">
            {g.players > 0 ? <>{t('Premios')} <b>{formatMoney(prizePool(g).toString(), g.currency)}</b> · {g.players} {t('jugadores')}</> : t('El pozo crece con cada inscrito')} · {t('Entrada')} <b>{BigInt(g.entry) > BigInt(0) ? formatMoney(g.entry, g.currency) : t('Gratis')}</b>
          </p>
          {!!g.events?.length && (
            <p className="truncate text-xs opacity-70">
              {g.events.map((e) => `${e.home} vs ${e.away}`).join(' · ')}{(g.eventCount ?? 0) > g.events.length ? ` · +${(g.eventCount ?? 0) - g.events.length}` : ''}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-lg bg-black/40 px-3 py-1 font-mono text-lg font-bold tabular-nums" aria-live="off">
            {open ? left(Date.parse(g.entriesCloseAt) - now) : `${t('Termina')} ${hhmm(g.endsAt)}`}
          </span>
          <span className="rounded-xl px-4 py-2 text-sm font-extrabold text-black transition group-hover:scale-105" style={{ background: 'linear-gradient(90deg,var(--nf-primary),var(--nf-accent))' }}>
            {open ? t('Inscribirme') : t('Ver ranking')}
          </span>
        </div>
      </div>
    </Link>
  );
}
