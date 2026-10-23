'use client';
import { useT } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Game } from '@/lib/lobby/types';
import { GameCard } from './GameCard';
import { Skeleton } from './States';

/** Fila horizontal de juegos con flechas (escritorio) y desplazamiento táctil (móvil). */
export function GameRow({ title, icon, href, games, loading, error }: { title: string; icon?: ReactNode; href?: string; games: Game[]; loading?: boolean; error?: string | null }) {
  const { t } = useT();
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = list.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, games.length, loading]);
  const page = (dir: 1 | -1) => {
    const el = list.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: reduce ? 'auto' : 'smooth' });
  };
  const showArrows = !loading && !error && games.length > 0;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">{icon}{title}</h2>
        <div className="ml-auto flex items-center gap-2">
          {href && <Link href={href} className="text-sm font-semibold text-[var(--nf-muted)] hover:text-[var(--nf-text)]">{t("Ver todo")}</Link>}
          {showArrows && (
            <div className="hidden gap-1 sm:flex">
              <button type="button" className="nf-square-btn" onClick={() => page(-1)} disabled={edges.start} aria-label={`Anteriores de ${title}`}><ChevronLeft aria-hidden className="h-4 w-4" /></button>
              <button type="button" className="nf-square-btn" onClick={() => page(1)} disabled={edges.end} aria-label={`Siguientes de ${title}`}><ChevronRight aria-hidden className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      </div>
      {error ? <p role="alert" className="text-sm text-[var(--nf-muted)]">No se pudo cargar: {error}</p>
        : loading ? <div role="status" aria-label={`Cargando ${title}`} className="nf-row">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="aspect-[3/4] w-[132px] shrink-0 sm:w-[156px]" />)}</div>
        : games.length === 0 ? <p className="text-sm text-[var(--nf-muted)]">{t("Sin juegos por ahora.")}</p>
        : <ul ref={list} onScroll={measure} className="nf-row">{games.map((g) => <li key={g.id} className="w-[132px] shrink-0 sm:w-[156px]"><GameCard game={g} /></li>)}</ul>}
    </section>
  );
}
