import type { Game } from '@/lib/lobby/types';
import { GameCard } from './GameCard';
import { CardSkeletons, EmptyState, ErrorState } from './States';

export function GameGrid(p: { games: Game[]; loading: boolean; error: string | null; onRetry?: () => void; hasMore?: boolean; onMore?: () => void; emptyTitle?: string; emptyHint?: string }) {
  if (p.error && p.games.length === 0) return <ErrorState message={p.error} onRetry={p.onRetry} />;
  if (p.loading && p.games.length === 0) return <CardSkeletons />;
  if (p.games.length === 0) return <EmptyState title={p.emptyTitle ?? 'No hay juegos'} hint={p.emptyHint} />;
  return (
    <div className="space-y-4">
      <ul className="nf-grid">{p.games.map((g) => <li key={g.id}><GameCard game={g} /></li>)}</ul>
      {p.error && <ErrorState message={p.error} onRetry={p.onRetry} />}
      {p.hasMore && <div className="text-center"><button type="button" className="nf-btn" disabled={p.loading} onClick={p.onMore}>{p.loading ? 'Cargando…' : 'Cargar más'}</button></div>}
    </div>
  );
}
