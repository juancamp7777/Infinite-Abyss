'use client';
import { GameGrid } from '@/components/lobby/GameGrid';
import { useGamesByIds } from '@/lib/lobby/hooks';
import { useRecent } from '@/lib/lobby/storage';

export default function RecentPage() {
  const g = useGamesByIds(useRecent());
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">Jugados recientemente</h1>
      <GameGrid games={g.items} loading={g.loading} error={null} emptyTitle="Todavía no has jugado nada" emptyHint="Tus últimos juegos aparecerán aquí." />
    </div>
  );
}
