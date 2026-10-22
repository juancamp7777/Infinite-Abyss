'use client';

/** Registro gameId → componente del juego de Nymfo Studios (carga diferida; solo en cliente). */
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import type { StudioGameProps } from './types';

const Loading = () => (
  <div className="grid h-dvh place-items-center bg-slate-950 text-sm text-slate-400" role="status">
    Cargando juego…
  </div>
);

const lazy = (loader: () => Promise<{ default: ComponentType<StudioGameProps> }>) => dynamic(loader, { ssr: false, loading: Loading });

export const STUDIO_REGISTRY: Record<string, ComponentType<StudioGameProps>> = {
  // Slots
  'nymfo-starfall': lazy(() => import('./slots/Starfall')),
  'nymfo-verdant-grid': lazy(() => import('./slots/VerdantGrid')),
  'nymfo-ember-lines': lazy(() => import('./slots/EmberLines')),
  // Originals (components/studio/originals/<Name>Game.tsx)
  'nymfo-crash': lazy(() => import('./originals/CrashGame')),
  'nymfo-mines': lazy(() => import('./originals/MinesGame')),
  'nymfo-plinko': lazy(() => import('./originals/PlinkoGame')),
  'nymfo-dice': lazy(() => import('./originals/DiceGame')),
  'nymfo-roulette': lazy(() => import('./originals/RouletteGame')),
  'nymfo-blackjack': lazy(() => import('./originals/BlackjackGame')),
};

export const isStudioGame = (gameId: string): boolean => Object.prototype.hasOwnProperty.call(STUDIO_REGISTRY, gameId);
