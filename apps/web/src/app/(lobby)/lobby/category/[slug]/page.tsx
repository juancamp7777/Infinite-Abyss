'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GameGrid } from '@/components/lobby/GameGrid';
import { EmptyState, ErrorState, Skeleton } from '@/components/lobby/States';
import { api } from '@/lib/lobby/api';
import { useAsync, useGames } from '@/lib/lobby/hooks';
import type { GameQuery } from '@/lib/lobby/types';

const TITLES: Record<string, string> = { originals: 'Originals', slots: 'Slots', live: 'Casino en vivo', table: 'Mesa', new: 'Nuevos', popular: 'Populares', providers: 'Proveedores' };

function queryFor(slug: string): GameQuery {
  if (slug === 'new') return { sort: 'new', pageSize: 36 };
  if (slug === 'popular') return { sort: 'popular', pageSize: 36 };
  return { category: slug, pageSize: 36 };
}

function Providers() {
  const p = useAsync(() => api.providers().then((r) => r.items), 'providers');
  if (p.error) return <ErrorState message={p.error} onRetry={p.reload} />;
  if (p.loading) return <div role="status" aria-label="Cargando" className="nf-grid"><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;
  if (!p.data?.length) return <EmptyState title="No hay proveedores" />;
  return <ul className="nf-grid">{p.data.map((x) => <li key={x.id}><Link href={`/lobby/provider/${x.id}`} className="nf-panel block text-center font-semibold hover:border-[var(--nf-primary)]">{x.name}<span className="block text-xs font-normal opacity-60">{x.type === 'internal' ? 'Abyss Studios' : 'Proveedor'}</span></Link></li>)}</ul>;
}

function Games({ slug }: { slug: string }) {
  const g = useGames(queryFor(slug));
  return <GameGrid games={g.items} loading={g.loading} error={g.error} onRetry={g.reload} hasMore={g.hasMore} onMore={g.loadMore} emptyTitle="No hay juegos en esta categoría" />;
}

export default function CategoryPage() {
  const slug = String(useParams<{ slug: string }>().slug);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">{TITLES[slug] ?? slug}</h1>
      {slug === 'providers' ? <Providers /> : <Games key={slug} slug={slug} />}
    </div>
  );
}
