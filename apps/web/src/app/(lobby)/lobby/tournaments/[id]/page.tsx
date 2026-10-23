'use client';
import { useT } from "@/lib/i18n";
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { TournamentTable } from '@/components/lobby/TournamentTable';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { ErrorState, Skeleton, tournamentStatusLabel } from '@/components/lobby/States';
import { api, errorMessage } from '@/lib/lobby/api';
import { useAsync, useLiveLeaderboard } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';

export default function TournamentPage() {
  const { t } = useT();
  const id = String(useParams<{ id: string }>().id);
  const { refresh } = useLobby();
  const info = useAsync(() => api.tournaments().then((r) => r.tournaments.find((tv) => tv.id === id) ?? null), `tour:${id}`);
  const lb = useLiveLeaderboard(id);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tv = info.data;
  const join = async () => {
    setBusy(true); setErr(null);
    try { await api.joinTournament(id); info.reload(); refresh(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  if (info.error) return <ErrorState message={info.error} onRetry={info.reload} />;
  if (info.loading) return <Skeleton className="h-40" />;
  if (!tv) return <ErrorState message={t("Torneo no encontrado")} />;
  const joinable = !tv.joined && !['finished', 'cancelled', 'closing'].includes(tv.status);
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold">{tv.name}</h1>
        <span className="nf-badge" style={{ background: 'var(--nf-accent)' }}>{t(tournamentStatusLabel(tv.status))}</span>
        <span className="text-xs opacity-70" role="status">{lb.connected ? '● En vivo' : '○ Sin conexión en vivo'}</span>
        {joinable && <button type="button" className="nf-btn nf-btn-primary ml-auto" disabled={busy} onClick={join}>{busy ? '…' : tv.buyIn !== '0' ? `Unirse (${formatMoney(tv.buyIn, tv.currency)})` : t("Unirse gratis")}</button>}
        {tv.joined && <span className="ml-auto text-sm opacity-70">{t("Estás inscrito")}</span>}
      </header>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <section aria-label={t("Premios")} className="nf-panel flex flex-wrap gap-3 text-sm">
        {tv.prizes.map((p) => <span key={p.position}>#{p.position}: <b>{formatMoney(p.amount, tv.currency)}</b></span>)}
      </section>
      {lb.error && !lb.data ? <ErrorState message={lb.error} onRetry={lb.reload} />
        : lb.data ? <TournamentTable lb={lb.data} currency={tv.currency} /> : <Skeleton className="h-48" />}
    </div>
  );
}
