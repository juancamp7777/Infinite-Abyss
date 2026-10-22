'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { StudioGameProps } from '../types';
import { errorMessage, prepare, studioApi, type FairnessView, type PublicRound, type RotateResponse, type VerifyResponse } from './api';

const short = (s: string, n = 14) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s);

/** Panel provably fair compartido: hash del servidor, client seed, nonce, rotar y verificar. */
export default function FairnessPanel({ game, lastRound, defaultOpen = false }: { game: StudioGameProps; lastRound?: PublicRound | null; defaultOpen?: boolean }) {
  const { gameId, mode, session } = game;
  const [view, setView] = useState<FairnessView | null>(null);
  const [seedInput, setSeedInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prev, setPrev] = useState<RotateResponse['previous'] | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);

  const g = useCallback((): StudioGameProps => ({ gameId, mode, session }), [gameId, mode, session]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await prepare({ mode, session });
        const v = await studioApi.fairness({ gameId, mode, session });
        if (alive) {
          setView(v);
          setSeedInput(v.clientSeed);
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [gameId, mode, session]);

  // Tras cada ronda el nonce avanza: se refresca la vista.
  const lastId = lastRound?.id;
  useEffect(() => {
    if (!lastId) return;
    studioApi.fairness({ gameId, mode, session }).then(setView).catch(() => undefined);
  }, [lastId, gameId, mode, session]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSeed = () =>
    run(async () => {
      const v = await studioApi.setClientSeed(g(), seedInput.trim());
      setView(v);
      setSeedInput(v.clientSeed);
    });

  const rotate = () =>
    run(async () => {
      const r = await studioApi.rotate(g());
      setPrev(r.previous);
      setView(r.current);
      setSeedInput(r.current.clientSeed);
      setResult(null);
    });

  // Una ronda es verificable cuando su semilla ya fue revelada (tras rotar).
  const round = lastRound && prev && lastRound.serverSeedHash === prev.serverSeedHash ? lastRound : null;
  const revealed = prev ?? null;
  const verify = () =>
    run(async () => {
      if (!revealed) return;
      const target = round ?? null;
      const v = await studioApi.verify(g(), {
        serverSeed: revealed.serverSeed,
        serverSeedHash: revealed.serverSeedHash,
        clientSeed: target?.clientSeed ?? revealed.clientSeed,
        nonce: target?.nonce ?? 0,
        gameId,
        params: target?.params,
        rtp: target?.rtp,
        roundId: target?.id,
      });
      setResult(v);
    });

  return (
    <details className="rounded-xl border border-white/10 bg-slate-900/60 p-3 text-sm" open={defaultOpen}>
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-slate-200">
        <ShieldCheck size={16} className="text-emerald-400" aria-hidden /> Provably fair
      </summary>
      <div className="mt-3 space-y-3">
        {error && (
          <p role="alert" className="rounded bg-rose-950/60 px-2 py-1 text-xs text-rose-200">
            {error}
          </p>
        )}
        {!view && !error && <p className="text-xs text-slate-500">Cargando…</p>}
        {view && (
          <dl className="space-y-1 text-xs">
            <div>
              <dt className="text-slate-400">Hash de la semilla del servidor (SHA-256)</dt>
              <dd className="break-all font-mono" title={view.serverSeedHash}>
                {short(view.serverSeedHash, 20)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Nonce actual</dt>
              <dd className="font-mono">{view.nonce}</dd>
            </div>
          </dl>
        )}
        <div>
          <label htmlFor={`cs-${gameId}`} className="mb-1 block text-xs text-slate-400">
            Client seed
          </label>
          <div className="flex gap-1">
            <input
              id={`cs-${gameId}`}
              value={seedInput}
              maxLength={64}
              onChange={(e) => setSeedInput(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950 px-2 py-1.5 font-mono text-xs outline-none focus:border-emerald-400"
            />
            <button type="button" disabled={busy || !seedInput.trim() || seedInput === view?.clientSeed} onClick={saveSeed} className="rounded-lg bg-slate-800 px-3 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50">
              Guardar
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy || !view} onClick={rotate} aria-label="Rotar semilla del servidor y revelar la anterior" className="flex-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50">
            Rotar semilla
          </button>
          <button type="button" disabled={busy || !revealed} onClick={verify} className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            Verificar
          </button>
        </div>
        {revealed && (
          <div className="rounded-lg bg-slate-950 p-2 text-xs">
            <p className="text-slate-400">Semilla anterior revelada (rondas con nonce 0–{revealed.lastNonce}):</p>
            <p className="break-all font-mono" aria-label="Semilla del servidor revelada">
              {revealed.serverSeed}
            </p>
          </div>
        )}
        {!revealed && <p className="text-xs text-slate-500">Rota la semilla para revelar la anterior y verificar tus últimas rondas.</p>}
        {result && (
          <div role="status" className="rounded-lg bg-slate-950 p-2 text-xs">
            <p className={result.hashMatches === false ? 'text-rose-300' : 'text-emerald-300'}>
              {result.hashMatches === false ? 'El hash NO coincide' : 'El hash coincide'}
              {result.round ? (result.round.outcomeMatches === false ? ' · resultado distinto' : ' · resultado reproducido') : ''}
            </p>
            <p className="mt-1 break-all font-mono text-slate-400">{JSON.stringify(result.outcome)}</p>
          </div>
        )}
      </div>
    </details>
  );
}
