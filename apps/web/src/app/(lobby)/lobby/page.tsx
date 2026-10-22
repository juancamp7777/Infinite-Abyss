'use client';
import Link from 'next/link';
import { BannerCarousel } from '@/components/lobby/BannerCarousel';
import { GameRow } from '@/components/lobby/GameRow';
import { JackpotTicker } from '@/components/lobby/JackpotTicker';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { MissionsPanel } from '@/components/lobby/MissionsPanel';
import { Skeleton } from '@/components/lobby/States';
import { api } from '@/lib/lobby/api';
import { useAsync, useGames, useJackpots } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';

export default function LobbyHome() {
  const { skin, refresh } = useLobby();
  const jp = useJackpots();
  const originals = useGames({ category: 'originals', pageSize: 12 });
  const slots = useGames({ category: 'slots', pageSize: 12 });
  const live = useGames({ category: 'live', pageSize: 12 });
  const fresh = useGames({ sort: 'new', pageSize: 12 });
  const popular = useGames({ sort: 'popular', pageSize: 12 });
  const tours = useAsync(() => api.tournaments().then((r) => r.tournaments), 'tours');
  const missions = useAsync(() => api.missions().then((r) => r.missions), 'missions');
  const activeTours = (tours.data ?? []).filter((t) => t.status === 'open' || t.status === 'active' || t.status === 'running').slice(0, 3);
  const tourList = activeTours.length ? activeTours : (tours.data ?? []).slice(0, 3);
  const row = (title: string, href: string, g: ReturnType<typeof useGames>) => <GameRow title={title} href={href} games={g.items} loading={g.loading} error={g.error} />;
  return (
    <>
      <h1 className="sr-only">Lobby</h1>
      <BannerCarousel banners={skin.banners} />
      <JackpotTicker jackpots={jp.data} loading={jp.loading} connected={jp.connected} />
      {row('Originals', '/lobby/category/originals', originals)}
      {row('Slots', '/lobby/category/slots', slots)}
      {row('Populares', '/lobby/category/popular', popular)}
      {row('Nuevos', '/lobby/category/new', fresh)}
      {live.items.length > 0 && row('Live', '/lobby/category/live', live)}
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Torneos activos" className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-lg font-bold">Torneos</h2><Link href="/lobby/tournaments" className="nf-link text-sm">Ver todos</Link></div>
          {tours.loading ? <Skeleton className="h-20" /> : tours.error ? <p role="alert" className="text-sm opacity-70">No se pudieron cargar los torneos.</p>
            : tourList.length === 0 ? <p className="text-sm opacity-60">No hay torneos por ahora.</p>
            : <ul className="space-y-2">{tourList.map((t) => (
              <li key={t.id}><Link href={`/lobby/tournaments/${t.id}`} className="nf-panel block hover:border-[var(--nf-primary)]">
                <p className="font-semibold">{t.name}</p>
                <p className="text-xs opacity-70">{t.players} jugadores · Premio 1.º: {formatMoney(t.prizes[0]?.amount ?? '0', t.currency)}</p>
              </Link></li>))}</ul>}
        </section>
        <section aria-label="Misiones" className="space-y-2">
          <div className="flex items-center justify-between"><h2 className="text-lg font-bold">Misiones</h2><Link href="/lobby/vip" className="nf-link text-sm">Ver todas</Link></div>
          <MissionsPanel missions={missions.data} loading={missions.loading} error={missions.error} limit={3} onRetry={missions.reload} onChange={() => { missions.reload(); refresh(); }} />
        </section>
      </div>
    </>
  );
}
