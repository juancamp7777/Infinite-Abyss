'use client';
import { useT } from "@/lib/i18n";
import Link from 'next/link';
import { EmptyState, ErrorState, Skeleton, tournamentStatusLabel } from '@/components/lobby/States';
import { api } from '@/lib/lobby/api';
import { useAsync } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';

export default function TournamentsPage() {
  const { t } = useT();
  const tv = useAsync(() => api.tournaments().then((r) => r.tournaments), 'tours-all');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">{t("Torneos")}</h1>
      {tv.error ? <ErrorState message={tv.error} onRetry={tv.reload} />
        : tv.loading ? <div role="status" aria-label={t("Cargando")} className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
        : !tv.data?.length ? <EmptyState title={t("No hay torneos disponibles")} hint={t("Pronto habrá nuevos.")} />
        : <ul className="grid gap-3 md:grid-cols-2">{tv.data.map((x) => (
          <li key={x.id}><Link href={`/lobby/tournaments/${x.id}`} className="nf-panel block space-y-1 hover:border-[var(--nf-primary)]">
            <div className="flex items-center justify-between"><p className="font-bold">{x.name}</p><span className="nf-badge" style={{ background: 'var(--nf-accent)' }}>{t(tournamentStatusLabel(x.status))}</span></div>
            <p className="text-sm opacity-70">{new Date(x.startsAt).toLocaleString('es')} → {new Date(x.endsAt).toLocaleString('es')}</p>
            <p className="text-sm">{x.players} jugadores · Premio 1.º {formatMoney(x.prizes[0]?.amount ?? '0', x.currency)}{x.joined && ' · Inscrito'}</p>
          </Link></li>))}</ul>}
    </div>
  );
}
