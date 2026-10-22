'use client';

import { useState } from 'react';
import { Bomb, Gem } from 'lucide-react';
import type { StudioGameProps } from '../types';
import { errorMessage, studioApi, type PublicRound } from './api';
import { winUnits } from '@/lib/studio/http';
import FairnessPanel from './FairnessPanel';
import { BetInput, GameShell, HistoryStrip, NumberField, OpenRoundNotice, PrimaryButton, ResultBanner, Stat, TurboToggle, formatMinor, sleep, toMinorString, useOpenRound, useRoundHistory, useStudioSession, useBetAmount } from './common';

interface MinesView {
  mines: number;
  revealed: number[];
  status: 'playing' | 'busted' | 'cashed_out';
  currentMultiplier: number;
  nextMultiplier: number;
  minePositions?: number[];
}

export default function MinesGame(props: StudioGameProps) {
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const openRound = useOpenRound(props, session, true);
  const [bet, setBet] = useBetAmount(session);
  const [mines, setMines] = useState(3);
  const [turbo, setTurbo] = useState(false);
  const [view, setView] = useState<MinesView | null>(null);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [last, setLast] = useState<PublicRound | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingCell, setPendingCell] = useState<number | null>(null);
  const [shown, setShown] = useState<Set<number>>(new Set());

  const minor = toMinorString(bet);
  const playing = view?.status === 'playing' && roundId !== null;
  const done = view !== null && view.status !== 'playing';

  const apply = (round: PublicRound, v: MinesView, balance: string | null) => {
    setView(v);
    if (v.status !== 'playing') {
      setLast(round);
      history.push(round);
      setRoundId(null);
      session.applyBalance(balance);
    }
  };

  const start = async () => {
    if (!minor) return;
    setBusy(true);
    session.setError(null);
    setShown(new Set());
    setLast(null);
    try {
      const r = await studioApi.start(props, minor, { mines });
      session.applyBalance(r.balance);
      setRoundId(r.round.id);
      setView(r.view as unknown as MinesView);
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (cell: number) => {
    if (!playing || busy || !roundId || view?.revealed.includes(cell)) return;
    setBusy(true);
    setPendingCell(cell);
    session.setError(null);
    try {
      const r = await studioApi.action(props, roundId, { type: 'reveal', cell });
      const v = r.view as unknown as MinesView;
      if (v.status === 'busted' && v.minePositions && !turbo) {
        // Se destapa primero la casilla elegida y luego el resto de minas.
        setView({ ...v, status: 'playing', minePositions: undefined });
        await sleep(350);
      }
      apply(r.round, v, r.balance);
      if (v.status !== 'playing' && v.minePositions) {
        const rest = v.minePositions.filter((m) => m !== cell);
        if (turbo) setShown(new Set(v.minePositions));
        else {
          setShown(new Set([cell]));
          for (const m of rest) {
            await sleep(60);
            setShown((s) => new Set(s).add(m));
          }
        }
      }
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setPendingCell(null);
      setBusy(false);
    }
  };

  const cashout = async () => {
    if (!playing || busy || !roundId) return;
    setBusy(true);
    try {
      const r = await studioApi.action(props, roundId, { type: 'cashout' });
      const v = r.view as unknown as MinesView;
      apply(r.round, v, r.balance);
      setShown(new Set(v.minePositions ?? []));
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const safeCount = view ? 25 - view.mines : 25 - mines;
  const potential = playing && minor && view ? formatMinor(winUnits(BigInt(minor), view.currentMultiplier)) : '—';

  const aside = (
    <>
      <OpenRoundNotice state={openRound} />
      <BetInput value={bet} onChange={setBet} disabled={playing || busy} />
      <NumberField id="mines-count" label="Minas" value={mines} onChange={(v) => setMines(Math.round(v))} min={1} max={24} disabled={playing || busy} />
      <div className="flex flex-wrap gap-1" role="group" aria-label="Minas rápidas">
        {[1, 3, 5, 10, 24].map((n) => (
          <button key={n} type="button" disabled={playing || busy} onClick={() => setMines(n)} className="rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700 disabled:opacity-50">
            {n}
          </button>
        ))}
      </div>
      <TurboToggle value={turbo} onChange={setTurbo} />
      {playing ? (
        <PrimaryButton tone="stop" disabled={busy || (view?.revealed.length ?? 0) === 0} onClick={cashout} aria-label="Retirar ganancias">
          Retirar {potential !== '—' ? potential : ''}
        </PrimaryButton>
      ) : (
        <PrimaryButton disabled={!minor || busy || !session.ready || !!openRound.open} onClick={start} aria-label="Empezar ronda de minas">
          {busy ? 'Iniciando…' : 'Apostar'}
        </PrimaryButton>
      )}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  const won = last ? BigInt(last.win) > BigInt(0) : null;
  return (
    <GameShell title="Abyss Mines" session={session} aside={aside}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Multiplicador" value={`${(view?.currentMultiplier ?? 1).toFixed(2)}×`} tone={playing ? 'win' : undefined} />
          <Stat label="Siguiente" value={playing && view ? `${view.nextMultiplier.toFixed(2)}×` : '—'} />
          <Stat label="Gemas / minas" value={`${safeCount - (view ? view.revealed.filter((c) => !view.minePositions?.includes(c)).length : 0)} / ${view?.mines ?? mines}`} />
        </div>
        <div className="mx-auto grid max-w-md grid-cols-5 gap-1.5 sm:gap-2" role="grid" aria-label="Tablero de minas 5 por 5">
          {Array.from({ length: 25 }, (_, i) => {
            const isMine = view?.minePositions?.includes(i) && (done ? shown.has(i) : false);
            const isGem = view?.revealed.includes(i) && !(done && view.minePositions?.includes(i));
            const ghostGem = done && !view?.revealed.includes(i) && !view?.minePositions?.includes(i);
            const hit = done && isMine && last && BigInt(last.win) === BigInt(0) && shown.size > 0 && i === Array.from(shown)[0];
            return (
              <button
                key={i}
                type="button"
                role="gridcell"
                disabled={!playing || busy || !!view?.revealed.includes(i)}
                onClick={() => reveal(i)}
                aria-label={isMine ? `Casilla ${i + 1}: mina` : isGem ? `Casilla ${i + 1}: gema` : `Casilla ${i + 1}: oculta`}
                className={`flex aspect-square items-center justify-center rounded-lg border text-white transition duration-200 ${
                  isMine ? (hit ? 'border-rose-400 bg-rose-600' : 'border-rose-900 bg-rose-950') : isGem ? 'border-emerald-400 bg-emerald-600/80' : 'border-white/10 bg-slate-800 hover:-translate-y-0.5 hover:bg-slate-700'
                } ${ghostGem ? 'opacity-40' : ''} ${pendingCell === i ? 'animate-pulse' : ''} disabled:cursor-default`}
              >
                {isMine ? <Bomb size={22} aria-hidden /> : isGem || ghostGem ? <Gem size={22} aria-hidden /> : null}
              </button>
            );
          })}
        </div>
        <ResultBanner win={done && last ? !!won : null} text={last ? (won ? `¡Retiraste ${Number(last.multiplier).toFixed(2)}×: +${formatMinor(last.win, last.currency)}!` : '¡Mina! Sin premio.') : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
