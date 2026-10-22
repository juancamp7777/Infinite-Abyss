import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { Game } from '@/lib/lobby/types';
import { GameCard } from './GameCard';
import { Skeleton } from './States';

export function GameRow({ title, href, games, loading, error }: { title: string; href?: string; games: Game[]; loading?: boolean; error?: string | null }) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{title}</h2>
        {href && <Link href={href} className="nf-link flex items-center text-sm">Ver todo <ChevronRight aria-hidden className="h-4 w-4" /></Link>}
      </div>
      {error ? <p role="alert" className="text-sm opacity-70">No se pudo cargar: {error}</p>
        : loading ? <div role="status" aria-label="Cargando" className="nf-row">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-[3/2] w-40 shrink-0 sm:w-48" />)}</div>
        : games.length === 0 ? <p className="text-sm opacity-60">Sin juegos por ahora.</p>
        : <ul className="nf-row">{games.map((g) => <li key={g.id} className="w-40 shrink-0 sm:w-48"><GameCard game={g} /></li>)}</ul>}
    </section>
  );
}
