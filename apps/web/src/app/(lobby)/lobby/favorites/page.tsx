'use client';
import { GameGrid } from '@/components/lobby/GameGrid';
import { useGamesByIds } from '@/lib/lobby/hooks';
import { useFavorites } from '@/lib/lobby/storage';

export default function FavoritesPage() {
  const { ids } = useFavorites();
  const g = useGamesByIds(ids);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">Favoritos</h1>
      <GameGrid games={g.items} loading={g.loading} error={null} emptyTitle="Aún no tienes favoritos" emptyHint="Toca el corazón de un juego para guardarlo aquí." />
    </div>
  );
}
