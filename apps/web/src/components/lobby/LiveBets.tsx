'use client';
import { useT } from "@/lib/i18n";
import { useId, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { Activity } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/lobby/format';
import { formatMultiplier, profitOf, timeOf, useLiveBets, type LiveTab } from '@/lib/lobby/liveBets';

const TABS: Array<{ id: LiveTab; label: string; empty: string; authOnly?: boolean }> = [
  { id: 'mine', label: 'Mis apuestas', empty: 'Aún no tienes apuestas. ¡Elige un juego y empieza!', authOnly: true },
  { id: 'all', label: 'Todas', empty: 'Todavía no hay apuestas en vivo.' },
  { id: 'high', label: 'Grandes apostadores', empty: 'Sin apuestas grandes por ahora.' },
  { id: 'lucky', label: 'Grandes victorias', empty: 'Sin grandes victorias por ahora.' },
];
const ROWS = 10;

/** Ganancia con signo: "+$ 12" / "−$ 3" / "$ 0". */
function signedMoney(v: bigint, currency: string): string {
  const zero = BigInt(0);
  const abs = formatMoney((v < zero ? -v : v).toString(), currency);
  return v > zero ? `+${abs}` : v < zero ? `−${abs}` : abs;
}

/** Tabla de apuestas en vivo del lobby (módulo feed). */
export function LiveBets() {
  const { t } = useT();
  const { status } = useAuth();
  const { lists, connected, fresh } = useLiveBets();
  const tabs = TABS.filter((tv) => !tv.authOnly || status === 'authenticated');
  const [tab, setTab] = useState<LiveTab>('all');
  const current = tabs.some((tv) => tv.id === tab) ? tab : 'all';
  const base = useId();
  const rows = lists[current].slice(0, ROWS);
  const meta = TABS.find((tv) => tv.id === current)!;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.findIndex((tv) => tv.id === current);
    const to = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(tabs[to].id);
    document.getElementById(`${base}-tab-${tabs[to].id}`)?.focus();
  };

  return (
    <section aria-labelledby={`${base}-title`} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={`${base}-title`} className="flex items-center gap-2 text-lg font-bold">
          <Activity aria-hidden className="h-5 w-5 text-[var(--nf-secondary)]" />{t("Apuestas en vivo")}
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-[var(--nf-muted)]" role="status">
          <span aria-hidden className="nf-live-dot" data-off={!connected} />{connected ? t("En vivo") : t("Conectando…")}
        </span>
        <div role="tablist" aria-label={t("Tipo de apuestas")} className="nf-tabs sm:ml-auto">
          {tabs.map((tv) => (
            <button
              key={tv.id} id={`${base}-tab-${tv.id}`} type="button" role="tab" aria-selected={current === tv.id}
              aria-controls={`${base}-panel`} tabIndex={current === tv.id ? 0 : -1} onClick={() => setTab(tv.id)} onKeyDown={onKey} className="nf-tab"
            >{t(tv.label)}</button>
          ))}
        </div>
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${current}`} className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="nf-panel py-8 text-center text-sm text-[var(--nf-muted)]">{t(meta.empty)}</p>
        ) : (
          <table className="nf-table">
            <caption className="sr-only">{t(meta.label)}</caption>
            <thead>
              <tr>
                <th scope="col">{t("Juego")}</th>
                <th scope="col">{t("Jugador")}</th>
                <th scope="col" className="hidden md:table-cell">{t("Hora")}</th>
                <th scope="col" className="nf-num hidden sm:table-cell">{t("Apuesta")}</th>
                <th scope="col" className="nf-num">{t("Multiplicador")}</th>
                <th scope="col" className="nf-num">{t("Ganancia")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const profit = profitOf(b);
                const won = profit > BigInt(0);
                return (
                  <tr key={b.id} className={fresh.has(b.id) ? 'nf-row-new' : undefined}>
                    <td className="max-w-[9rem] truncate font-semibold sm:max-w-[14rem]">
                      <Link href={`/lobby/game/${encodeURIComponent(b.gameId)}`} className="hover:underline">{b.gameTitle}</Link>
                    </td>
                    <td className="max-w-[8rem] truncate text-[var(--nf-muted)]">{b.isMe || current === 'mine' ? <span className="font-semibold text-[var(--nf-text)]">{t("Tú")}</span> : b.player}</td>
                    <td className="hidden text-[var(--nf-muted)] md:table-cell">{timeOf(b.at)}</td>
                    <td className="nf-num hidden sm:table-cell">{formatMoney(b.amount, b.currency)}</td>
                    <td className="nf-num">{formatMultiplier(b.multiplier)}</td>
                    <td className={`nf-num font-semibold ${won ? 'nf-pos' : 'nf-neg'}`}>
                      {signedMoney(profit, b.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
