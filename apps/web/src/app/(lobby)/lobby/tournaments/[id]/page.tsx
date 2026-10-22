'use client';
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { TournamentTable } from '@/components/lobby/TournamentTable';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { ErrorState, Skeleton, tournamentStatusLabel } from '@/components/lobby/States';
import { api, errorMessage } from '@/lib/lobby/api';
import { useAsync, useLiveLeaderboard } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';

export default function TournamentPage() {
  const id = String(useParams<{ id: string }>().id);
  const { refresh } = useLobby();
  const info = useAsync(() => api.tournaments().then((r) => r.tournaments.find((t) => t.id === id) ?? null), `tour:${id}`);
  const lb = useLiveLeaderboard(id);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = info.data;
  const join = async () => {
    setBusy(true); setErr(null);
    try { await api.joinTournament(id); info.reload(); refresh(); } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  if (info.error) return <ErrorState message={info.error} onRetry={info.reload} />;
  if (info.loading) return <Skeleton className="h-40" />;
  if (!t) return <ErrorState message="Torneo no encontrado" />;
  const joinable = !t.joined && !['finished', 'cancelled', 'closing'].includes(t.status);
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold">{t.name}</h1>
        <span className="nf-badge" style={{ background: 'var(--nf-accent)' }}>{tournamentStatusLabel(t.status)}</span>
        <span className="text-xs opacity-70" role="status">{lb.connected ? '● En vivo' : '○ Sin conexión en vivo'}</span>
        {joinable && <button type="button" className="nf-btn nf-btn-primary ml-auto" disabled={busy} onClick={join}>{busy ? '…' : t.buyIn !== '0' ? `Unirse (${formatMoney(t.buyIn, t.currency)})` : 'Unirse gratis'}</button>}
        {t.joined && <span className="ml-auto text-sm opacity-70">Estás inscrito</span>}
      </header>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
      <section aria-label="Premios" className="nf-panel flex flex-wrap gap-3 text-sm">
        {t.prizes.map((p) => <span key={p.position}>#{p.position}: <b>{formatMoney(p.amount, t.currency)}</b></span>)}
      </section>
      {lb.error && !lb.data ? <ErrorState message={lb.error} onRetry={lb.reload} />
        : lb.data ? <TournamentTable lb={lb.data} currency={t.currency} /> : <Skeleton className="h-48" />}
    </div>
  );
}
