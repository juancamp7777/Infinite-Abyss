'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Heart, Play } from 'lucide-react';
import type { Game } from '@/lib/lobby/types';
import { assetUrl } from '@/lib/lobby/api';
import { fallbackThumb } from '@/lib/lobby/format';
import { useFavorites } from '@/lib/lobby/storage';

/** Tarjeta vertical (3:4) del catálogo: arte, insignias, favorito y título debajo. */
export function GameCard({ game }: { game: Game }) {
  const [broken, setBroken] = useState(false);
  const fav = useFavorites();
  const isFav = fav.has(game.id);
  const thumb = assetUrl(game.images?.thumb);
  const src = !broken && thumb ? thumb : fallbackThumb(game.title, game.providerId);
  return (
    <div className="group">
      <div className="nf-card">
        <Link href={`/lobby/game/${encodeURIComponent(game.id)}`} className="block focus-visible:outline-none" aria-label={`Jugar ${game.title} de ${game.providerName}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className="aspect-[3/4] w-full object-cover" />
          <span aria-hidden className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--nf-primary)] text-[var(--nf-on-primary)] shadow-lg">
              <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
            </span>
          </span>
        </Link>
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
          {game.isNew && <span className="nf-badge" style={{ background: 'var(--nf-secondary)', color: 'var(--nf-on-secondary)' }}>Nuevo</span>}
          {game.popularity >= 80 && <span className="nf-badge" style={{ background: 'var(--nf-primary)' }}>Top</span>}
        </div>
        <button
          type="button" aria-pressed={isFav} aria-label={isFav ? `Quitar ${game.title} de favoritos` : `Añadir ${game.title} a favoritos`}
          onClick={() => fav.toggle(game.id)}
          className={`nf-icon-btn absolute right-2 top-2 transition-opacity ${isFav ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'}`}
        >
          <Heart aria-hidden className="h-4 w-4" fill={isFav ? 'currentColor' : 'none'} />
        </button>
      </div>
      <p className="mt-1.5 truncate px-0.5 text-[13px] font-semibold">{game.title}</p>
      <p className="truncate px-0.5 text-[11px] text-[var(--nf-muted)]">{game.providerName}</p>
    </div>
  );
}
