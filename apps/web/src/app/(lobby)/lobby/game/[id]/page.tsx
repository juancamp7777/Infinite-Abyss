'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Heart, Maximize2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { GameRow } from '@/components/lobby/GameRow';
import { ErrorState, Skeleton } from '@/components/lobby/States';
import { api, errorMessage } from '@/lib/lobby/api';
import { useAsync, useGames } from '@/lib/lobby/hooks';
import { pushRecent, useFavorites } from '@/lib/lobby/storage';
import type { Game } from '@/lib/lobby/types';

const VOL: Record<string, string> = { low: 'Baja', medium: 'Media', high: 'Alta', very_high: 'Muy alta' };

function Player({ game }: { game: Game }) {
  const { balance } = useLobby();
  const { status } = useAuth();
  const [mode, setMode] = useState<'demo' | 'real'>(game.hasDemo ? 'demo' : 'real');
  // El modo real exige sesión: sin ella se pide login (el demo funciona anónimo si el juego lo soporta).
  const needsLogin = mode === 'real' && status === 'anonymous';
  const [state, setState] = useState<{ url: string | null; error: string | null; loading: boolean }>({ url: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const fav = useFavorites();
  useEffect(() => {
    if (status === 'loading' || needsLogin) { setState({ url: null, error: null, loading: status === 'loading' }); return; }
    let alive = true;
    setState({ url: null, error: null, loading: true });
    api.launch(game.id, mode, balance?.currency).then(
      (r) => { if (alive) setState({ url: r.url, error: null, loading: false }); },
      (e) => { if (alive) setState({ url: null, error: errorMessage(e), loading: false }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id, mode, tick, status, needsLogin]);
  const canDemo = game.hasDemo;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Modo de juego" className="flex overflow-hidden rounded-lg border border-white/10">
          <button type="button" aria-pressed={mode === 'demo'} disabled={!canDemo} onClick={() => setMode('demo')} className={`px-3 py-1.5 text-sm ${mode === 'demo' ? 'nf-btn-primary' : ''} disabled:opacity-40`}>Demo</button>
          <button type="button" aria-pressed={mode === 'real'} onClick={() => setMode('real')} className={`px-3 py-1.5 text-sm ${mode === 'real' ? 'nf-btn-primary' : ''}`}>Dinero real</button>
        </div>
        <button type="button" className="nf-btn flex items-center gap-1" onClick={() => fav.toggle(game.id)} aria-pressed={fav.has(game.id)}><Heart aria-hidden className="h-4 w-4" fill={fav.has(game.id) ? 'currentColor' : 'none'} />Favorito</button>
        <button type="button" className="nf-btn ml-auto flex items-center gap-1" onClick={() => box.current?.requestFullscreen?.().catch(() => {})}><Maximize2 aria-hidden className="h-4 w-4" />Pantalla completa</button>
      </div>
      <div ref={box} className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black sm:aspect-video">
        {needsLogin && (
          <div className="absolute inset-0 grid place-items-center p-4 text-center" role="status">
            <div className="space-y-3">
              <p className="font-semibold">Inicia sesión para jugar con dinero real</p>
              <div className="flex justify-center gap-2">
                <Link href={`/login?next=${encodeURIComponent(`/lobby/game/${game.id}`)}`} className="nf-btn nf-btn-primary">Iniciar sesión</Link>
                <Link href="/register" className="nf-btn">Crear cuenta</Link>
              </div>
              {game.hasDemo && <button type="button" className="nf-btn" onClick={() => setMode('demo')}>Probar en demo</button>}
            </div>
          </div>
        )}
        {state.loading && <Skeleton className="absolute inset-0 rounded-none" />}
        {state.error && <div className="absolute inset-0 grid place-items-center p-4"><ErrorState message={state.error} onRetry={() => setTick((t) => t + 1)} /></div>}
        {state.url && <iframe key={state.url} src={state.url} title={game.title} className="h-full w-full border-0" allow="fullscreen; autoplay; clipboard-write" allowFullScreen sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />}
      </div>
    </div>
  );
}

function Related({ game }: { game: Game }) {
  const g = useGames({ category: game.category, pageSize: 13 });
  return <GameRow title="Juegos relacionados" games={g.items.filter((x) => x.id !== game.id).slice(0, 12)} loading={g.loading} error={g.error} />;
}

export default function GamePage() {
  const id = String(useParams<{ id: string }>().id);
  const g = useAsync(() => api.game(id), `game:${id}`);
  useEffect(() => { if (g.data) pushRecent(g.data.id); }, [g.data]);
  if (g.error) return <ErrorState message={g.error} onRetry={g.reload} />;
  if (!g.data) return <Skeleton className="aspect-video w-full" />;
  const game = g.data;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-extrabold">{game.title}</h1>
        <p className="text-sm opacity-70">{game.providerName}</p>
      </header>
      <Player game={game} />
      <dl className="nf-panel grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><dt className="opacity-60">RTP</dt><dd className="font-semibold">{game.rtp}%</dd></div>
        <div><dt className="opacity-60">Volatilidad</dt><dd className="font-semibold">{VOL[game.volatility] ?? game.volatility}</dd></div>
        <div><dt className="opacity-60">Mecánica</dt><dd className="font-semibold">{game.mechanic || '—'}</dd></div>
        <div><dt className="opacity-60">Categoría</dt><dd className="font-semibold capitalize">{game.category}</dd></div>
      </dl>
      <Related game={game} />
    </div>
  );
}
