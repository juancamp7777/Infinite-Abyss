'use client';
import { useT } from "@/lib/i18n";
import { useState } from 'react';
import type { Mission } from '@/lib/lobby/types';
import { api, errorMessage } from '@/lib/lobby/api';
import { formatMoney, rewardLabel, toNumber } from '@/lib/lobby/format';
import { EmptyState, ErrorState, Skeleton } from './States';

export function MissionsPanel(p: { missions: Mission[] | null; loading: boolean; error: string | null; onChange: () => void; onRetry?: () => void; limit?: number }) {
  const { t } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (p.error) return <ErrorState message={p.error} onRetry={p.onRetry} />;
  if (p.loading && !p.missions) return <div role="status" aria-label={t("Cargando misiones")} className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>;
  const list = (p.missions ?? []).slice(0, p.limit ?? 100);
  if (list.length === 0) return <EmptyState title={t("No hay misiones activas")} hint={t("Vuelve más tarde.")} />;
  const claim = async (id: string) => {
    setBusy(id); setMsg(null);
    try { await api.claimMission(id); p.onChange(); } catch (e) { setMsg(errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-2">
      {msg && <p role="alert" className="text-sm text-red-400">{msg}</p>}
      <ul className="space-y-2">
        {list.map((m) => {
          const tv = toNumber(m.target); const pct = tv > 0 ? Math.min(100, (toNumber(m.progress) / tv) * 100) : 0;
          const money = m.type === 'wager' || m.type === 'deposit';
          return (
            <li key={m.id} className="nf-panel flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{m.name} <span className="ml-1 text-[10px] uppercase opacity-60">{m.period === 'daily' ? t("Diaria") : t("Semanal")}</span></p>
                <div role="progressbar" aria-label={m.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="nf-bar my-1"><div style={{ width: `${pct}%` }} /></div>
                <p className="text-xs opacity-70">{money ? `${formatMoney(m.progress)} / ${formatMoney(m.target)}` : `${m.progress} / ${m.target}`} · {rewardLabel(m.reward)}</p>
              </div>
              {m.claimed ? <span className="text-xs opacity-60">{t("Reclamada")}</span>
                : <button type="button" className="nf-btn nf-btn-primary" disabled={!m.completed || busy === m.id} onClick={() => claim(m.id)}>{busy === m.id ? '…' : 'Reclamar'}</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
