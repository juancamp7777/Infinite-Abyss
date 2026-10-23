'use client';
import { useT } from "@/lib/i18n";
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { GameGrid } from '@/components/lobby/GameGrid';
import { useDebounce, useGames } from '@/lib/lobby/hooks';

function Results() {
  const { t } = useT();
  const q = useDebounce((useSearchParams().get('q') ?? '').trim(), 250);
  const g = useGames({ q, pageSize: 36 }, q.length > 0);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">{q ? `Resultados para “${q}”` : 'Buscar'}</h1>
      {!q ? <p className="opacity-70">{t("Escribe en la barra superior para buscar juegos o proveedores.")}</p>
        : <GameGrid games={g.items} loading={g.loading} error={g.error} onRetry={g.reload} hasMore={g.hasMore} onMore={g.loadMore} emptyTitle={`Sin resultados para “${q}”`} emptyHint="Prueba con otro nombre o proveedor." />}
    </div>
  );
}
export default function SearchPage() { return <Suspense><Results /></Suspense>; }
