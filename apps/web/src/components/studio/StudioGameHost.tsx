'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { STUDIO_REGISTRY } from './registry';
import type { StudioGameProps } from './types';

/** Monta el juego de Studios según su id; muestra un estado claro si el juego no existe. */
export default function StudioGameHost(props: StudioGameProps) {
  const { status } = useAuth();
  // El operador (decimales, moneda y montos de apuesta) se resuelve con el host actual antes de montar el juego.
  const { status: themeStatus } = useTheme();
  const Game = Object.prototype.hasOwnProperty.call(STUDIO_REGISTRY, props.gameId) ? STUDIO_REGISTRY[props.gameId] : null;
  if (!Game) {
    return (
      <div className="grid h-dvh place-items-center bg-slate-950 p-6 text-center text-slate-200" role="alert">
        <div>
          <h1 className="mb-2 text-xl font-bold">Juego no disponible</h1>
          <p className="mb-4 text-sm text-slate-400">
            No existe el juego «{props.gameId}» en Abyss Studios.
          </p>
          <Link href="/" className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold hover:bg-slate-700">
            Volver al lobby
          </Link>
        </div>
      </div>
    );
  }
  // Dinero real sin sesión de lanzamiento del Hub: esperar a que se resuelva la sesión del jugador.
  if (props.mode === 'real' && !props.session && status === 'loading') {
    return <div role="status" aria-live="polite" className="grid h-dvh place-items-center bg-slate-950 text-slate-300">Verificando sesión…</div>;
  }
  if (themeStatus === 'loading') {
    return <div role="status" aria-live="polite" className="grid h-dvh place-items-center bg-slate-950 text-slate-300">Cargando juego…</div>;
  }
  return <Game {...props} />;
}
