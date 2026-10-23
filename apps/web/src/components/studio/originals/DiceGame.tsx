'use client';
import { useT } from "@/lib/i18n";

import { useCallback, useRef, useState } from 'react';
import type { StudioGameProps } from '../types';
import { errorMessage, studioApi, type PublicRound } from './api';
import FairnessPanel from './FairnessPanel';
import { BetInput, GameShell, HistoryStrip, NumberField, PrimaryButton, ResultBanner, Segmented, Stat, TurboToggle, formatMinor, sleep, toMinorString, useRoundHistory, useStudioSession, usePrefersReducedMotion, useBetAmount } from './common';

interface DiceOutcome {
  roll: number;
  target: number;
  over: boolean;
  winChance: number;
  payout: number;
  win: boolean;
}

export default function DiceGame(props: StudioGameProps) {
  const { t } = useT();
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const reduced = usePrefersReducedMotion();
  const [bet, setBet] = useBetAmount(session);
  const [over, setOver] = useState(true);
  const [target, setTarget] = useState(50);
  const [turbo, setTurbo] = useState(false);
  const [autoCount, setAutoCount] = useState(10);
  const [autoLeft, setAutoLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<PublicRound | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const stopRef = useRef(false);

  const chance = over ? 99.99 - target : target;
  const chanceOk = chance >= 1 && chance <= 98;
  const mult = chanceOk ? Math.floor(((0.99 / (chance / 100)) * 10000) + 1e-6) / 10000 : 0;
  const minor = toMinorString(bet);
  const out = last?.outcome as DiceOutcome | undefined;

  const roll = useCallback(async (): Promise<boolean> => {
    if (!minor || !chanceOk) return false;
    try {
      const r = await studioApi.play(props, minor, { target, over });
      const o = r.round.outcome as DiceOutcome;
      session.applyBalance(r.balance);
      // La animación solo muestra el resultado devuelto por el servidor.
      if (!turbo && !reduced) {
        const steps = 8;
        for (let i = 0; i < steps; i++) {
          setShown(Math.floor(Math.random() * 10000) / 100);
          await sleep(45);
        }
      }
      setShown(o.roll);
      setLast(r.round);
      history.push(r.round);
      return true;
    } catch (e) {
      session.setError(errorMessage(e));
      return false;
    }
  }, [minor, chanceOk, props, target, over, turbo, reduced, session, history]);

  const single = async () => {
    setBusy(true);
    session.setError(null);
    await roll();
    setBusy(false);
  };

  const auto = async () => {
    setBusy(true);
    stopRef.current = false;
    session.setError(null);
    for (let i = autoCount; i > 0 && !stopRef.current; i--) {
      setAutoLeft(i);
      if (!(await roll())) break;
      await sleep(turbo ? 60 : 450);
    }
    setAutoLeft(0);
    setBusy(false);
  };

  const pct = (n: number) => `${Math.max(0, Math.min(100, n))}%`;
  const aside = (
    <>
      <BetInput value={bet} onChange={setBet} disabled={busy} />
      <Segmented label="Modo" value={over ? 'over' : 'under'} onChange={(v) => setOver(v === 'over')} disabled={busy} options={[{ value: 'over', label: t("Más de") }, { value: 'under', label: t("Menos de") }]} />
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Probabilidad" value={`${chanceOk ? chance.toFixed(2) : '—'}%`} />
        <Stat label="Multiplicador" value={chanceOk ? `${mult.toFixed(4)}×` : '—'} />
      </div>
      <TurboToggle value={turbo} onChange={setTurbo} />
      <NumberField id="dice-auto" label={t("Apuestas automáticas")} value={autoCount} onChange={(v) => setAutoCount(Math.round(v))} min={1} max={200} disabled={busy} />
      {autoLeft > 0 ? (
        <PrimaryButton tone="stop" onClick={() => (stopRef.current = true)}>
          Detener autoplay ({autoLeft})
        </PrimaryButton>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <PrimaryButton disabled={busy || !minor || !chanceOk || !session.ready} onClick={single} aria-label={t("Lanzar dado")}>
            {busy ? t("Lanzando…") : t("Apostar")}
          </PrimaryButton>
          <PrimaryButton disabled={busy || !minor || !chanceOk || !session.ready} onClick={auto} aria-label={t("Iniciar autoplay")}>
            {t("Auto")}
          </PrimaryButton>
        </div>
      )}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  return (
    <GameShell title={t("Abyss Dice")} session={session} aside={aside}>
      <div className="space-y-4">
        <div className="rounded-2xl bg-slate-900 p-4 sm:p-8">
          <div className="mb-6 text-center" aria-live="polite">
            <div className={`font-mono text-6xl font-black tabular-nums sm:text-7xl ${out ? (out.win ? 'text-emerald-400' : 'text-rose-400') : 'text-slate-300'}`}>{shown === null ? '—' : shown.toFixed(2)}</div>
          </div>
          <div className="relative px-1 pb-6 pt-2">
            <div className="relative h-4 overflow-hidden rounded-full bg-slate-800" aria-hidden>
              <div className={`absolute inset-y-0 ${over ? 'right-0' : 'left-0'} bg-emerald-500/70`} style={{ width: pct(chance) }} />
              <div className={`absolute inset-y-0 ${over ? 'left-0' : 'right-0'} bg-rose-500/50`} style={{ width: pct(100 - chance) }} />
            </div>
            {shown !== null && (
              <div className="pointer-events-none absolute top-0 -translate-x-1/2 transition-[left] duration-200" style={{ left: pct(shown) }} aria-hidden>
                <div className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold text-slate-900">▼</div>
              </div>
            )}
            <input
              type="range"
              min={1}
              max={98.99}
              step={0.01}
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(Number(e.target.value))}
              aria-label={`Objetivo del dado: ${over ? 'más de' : 'menos de'} ${target.toFixed(2)}`}
              className="absolute left-0 top-1 h-6 w-full cursor-pointer opacity-0"
            />
            <div className="pointer-events-none absolute top-0 -translate-x-1/2" style={{ left: pct(target) }} aria-hidden>
              <div className="h-6 w-3 rounded bg-sky-400 shadow" />
            </div>
            <div className="mt-3 flex justify-between font-mono text-xs text-slate-500">
              <span>0</span>
              <span>25</span>
              <span>50</span>
              <span>75</span>
              <span>100</span>
            </div>
          </div>
          <div className="mx-auto max-w-xs">
            <NumberField id="dice-target" label={over ? 'Más de' : t("Menos de")} value={target} onChange={setTarget} min={1} max={98.99} step={0.01} disabled={busy} />
          </div>
        </div>
        <ResultBanner win={out ? out.win : null} text={out && last ? (out.win ? `¡Ganaste ${formatMinor(last.win, last.currency)} (${out.payout.toFixed(2)}×)!` : `Salió ${out.roll.toFixed(2)}. Sin premio.`) : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
