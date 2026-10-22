'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import type { Game } from '@/lib/lobby/types';
import { assetUrl } from '@/lib/lobby/api';
import { fallbackThumb } from '@/lib/lobby/format';
import { useFavorites } from '@/lib/lobby/storage';

export function GameCard({ game }: { game: Game }) {
  const [broken, setBroken] = useState(false);
  const fav = useFavorites();
  const isFav = fav.has(game.id);
  const src = !broken && assetUrl(game.images?.thumb) ? assetUrl(game.images.thumb)! : fallbackThumb(game.title, game.providerId);
  return (
    <div className="nf-card group relative">
      <Link href={`/lobby/game/${encodeURIComponent(game.id)}`} className="block focus-visible:outline-none" aria-label={`Jugar ${game.title}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="aspect-[3/2] w-full object-cover transition-transform duration-300 group-hover:scale-105" />
        <div className="p-2">
          <p className="truncate text-sm font-semibold">{game.title}</p>
          <p className="truncate text-xs opacity-60">{game.providerName}</p>
        </div>
      </Link>
      <div className="pointer-events-none absolute left-2 top-2 flex gap-1">
        {game.isNew && <span className="nf-badge" style={{ background: 'var(--nf-secondary)' }}>Nuevo</span>}
        {game.popularity >= 80 && <span className="nf-badge" style={{ background: 'var(--nf-accent)' }}>Popular</span>}
      </div>
      <button
        type="button" aria-pressed={isFav} aria-label={isFav ? `Quitar ${game.title} de favoritos` : `Añadir ${game.title} a favoritos`}
        onClick={() => fav.toggle(game.id)} className="nf-icon-btn absolute right-2 top-2"
      >
        <Heart aria-hidden className="h-4 w-4" fill={isFav ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}
