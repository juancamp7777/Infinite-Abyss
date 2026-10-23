'use client';
import { useT } from "@/lib/i18n";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioGameProps } from '../types';
import { errorMessage, studioApi, type PublicRound } from './api';
import { winUnits } from '@/lib/studio/http';
import FairnessPanel from './FairnessPanel';
import { BetInput, GameShell, HistoryStrip, NumberField, OpenRoundNotice, PrimaryButton, ResultBanner, Stat, TurboToggle, formatMinor, sleep, toMinorString, useOpenRound, useRoundHistory, useStudioSession, useBetAmount } from './common';

interface CrashView {
  status: 'running' | 'cashed_out' | 'crashed';
  startedAt?: number;
  autoCashout?: number | null;
  cashout?: number | null;
  current?: number;
  crashPoint?: number;
}

/** Misma curva que el servidor, solo para animar entre consultas. */
const curve = (ms: number) => Math.max(1, Math.floor(100 * Math.exp(0.00006 * ms)) / 100);
const POLL_MS = 250;
const nowMs = () => performance.now();

export default function CrashGame(props: StudioGameProps) {
  const { t } = useT();
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const openRound = useOpenRound(props, session, true);
  const [bet, setBet] = useBetAmount(session);
  const [useAuto, setUseAuto] = useState(false);
  const [auto, setAuto] = useState(2);
  const [turbo, setTurbo] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'running' | 'cashing' | 'done'>('idle');
  const [display, setDisplay] = useState(1);
  const [view, setView] = useState<CrashView | null>(null);
  const [last, setLast] = useState<PublicRound | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roundIdRef = useRef<string | null>(null);
  const t0Ref = useRef(0);
  const capRef = useRef<number | null>(null);
  const pathRef = useRef<Array<[number, number]>>([]);
  const phaseRef = useRef(phase);
  const finalRef = useRef<{ crashed: boolean; at: number } | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  });

  const minor = toMinorString(bet);
  const running = phase === 'running' || phase === 'cashing';

  // Animación local: nunca decide el resultado, solo interpola hasta que el servidor confirma.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const W = canvas.width;
    const H = canvas.height;
    const draw = (now: number) => {
      const fin = finalRef.current;
      let m = 1;
      if (phaseRef.current === 'running' || phaseRef.current === 'cashing') {
        const el = (now - t0Ref.current) * (turbo ? 2 : 1);
        m = curve(el / (turbo ? 2 : 1));
        if (capRef.current) m = Math.min(m, capRef.current);
        pathRef.current.push([now - t0Ref.current, m]);
        setDisplay(m);
      } else if (fin) m = fin.at;
      ctx.clearRect(0, 0, W, H);
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0f172a');
      bg.addColorStop(1, '#020617');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(148,163,184,0.12)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (H / 5) * i);
        ctx.lineTo(W, (H / 5) * i);
        ctx.stroke();
      }
      const pts = pathRef.current;
      if (pts.length > 1) {
        const tMax = Math.max(6000, pts[pts.length - 1][0]);
        const mMax = Math.max(2, m * 1.15);
        const px = (t: number) => 30 + (t / tMax) * (W - 60);
        const py = (v: number) => H - 30 - ((v - 1) / (mMax - 1)) * (H - 70);
        const crashed = fin?.crashed;
        ctx.strokeStyle = crashed ? '#f43f5e' : '#34d399';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach(([t, v], i) => (i ? ctx.lineTo(px(t), py(v)) : ctx.moveTo(px(t), py(v))));
        ctx.stroke();
        const [lt, lv] = pts[pts.length - 1];
        ctx.fillStyle = crashed ? '#f43f5e' : '#fbbf24';
        ctx.beginPath();
        ctx.arc(px(lt), py(lv), crashed ? 9 : 6, 0, Math.PI * 2);
        ctx.fill();
        if (pts.length > 2) {
          ctx.lineTo(px(lt), H - 30);
          ctx.lineTo(px(pts[0][0]), H - 30);
          ctx.fillStyle = crashed ? 'rgba(244,63,94,0.12)' : 'rgba(52,211,153,0.12)';
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [turbo]);

  const finish = useCallback(
    (round: PublicRound, v: CrashView, balance: string | null) => {
      const crashed = v.status === 'crashed';
      const at = crashed ? (v.crashPoint ?? v.current ?? 1) : (v.cashout ?? v.current ?? 1);
      finalRef.current = { crashed, at };
      pathRef.current.push([performance.now() - t0Ref.current, at]);
      setDisplay(at);
      setView(v);
      setLast(round);
      history.push(round);
      session.applyBalance(balance);
      roundIdRef.current = null;
      setPhase('done');
    },
    [history, session],
  );

  const start = async () => {
    if (!minor) return;
    session.setError(null);
    setPhase('starting');
    finalRef.current = null;
    pathRef.current = [];
    setView(null);
    try {
      const params = useAuto ? { autoCashout: auto } : {};
      const r = await studioApi.start(props, minor, params);
      const v = r.view as unknown as CrashView;
      roundIdRef.current = r.round.id;
      session.applyBalance(r.balance);
      t0Ref.current = nowMs();
      capRef.current = useAuto ? auto : null;
      if (v.status !== 'running') return finish(r.round, v, r.balance);
      setView(v);
      setPhase('running');
    } catch (e) {
      session.setError(errorMessage(e));
      setPhase('idle');
    }
  };

  // Sondeo: el servidor resuelve el retiro automático y el crash con su reloj.
  useEffect(() => {
    if (phase !== 'running') return;
    let alive = true;
    (async () => {
      while (alive && roundIdRef.current) {
        await sleep(POLL_MS);
        if (!alive || !roundIdRef.current) break;
        try {
          const r = await studioApi.action(props, roundIdRef.current, { type: 'check' });
          const v = r.view as unknown as CrashView;
          if (v.status !== 'running') {
            if (alive) finish(r.round, v, r.balance);
            break;
          }
        } catch (e) {
          if (alive) session.setError(errorMessage(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const cashout = async () => {
    const id = roundIdRef.current;
    if (!id || phase !== 'running') return;
    setPhase('cashing');
    try {
      const r = await studioApi.action(props, id, { type: 'cashout' });
      finish(r.round, r.view as unknown as CrashView, r.balance);
    } catch (e) {
      session.setError(errorMessage(e));
      setPhase('running');
    }
  };

  const crashed = view?.status === 'crashed';
  const won = last ? BigInt(last.win) > BigInt(0) : null;
  const aside = (
    <>
      <OpenRoundNotice state={openRound} />
      <BetInput value={bet} onChange={setBet} disabled={running || phase === 'starting'} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={useAuto} disabled={running} onChange={(e) => setUseAuto(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
        {t("Retiro automático")}
      </label>
      {useAuto && <NumberField id="crash-auto" label={t("Retirar en")} value={auto} onChange={setAuto} min={1.01} max={1000} step={0.1} suffix="×" disabled={running} />}
      <TurboToggle value={turbo} onChange={setTurbo} />
      {running ? (
        <PrimaryButton tone="stop" disabled={phase === 'cashing'} onClick={cashout} aria-label={t("Retirar ganancias ahora")}>
          {phase === 'cashing' ? 'Retirando…' : `Retirar ${minor ? formatMinor(winUnits(BigInt(minor), display)) : ''}`}
        </PrimaryButton>
      ) : (
        <PrimaryButton disabled={!minor || !session.ready || phase === 'starting' || !!openRound.open} onClick={start} aria-label={t("Iniciar ronda de crash")}>
          {phase === 'starting' ? 'Iniciando…' : 'Apostar'}
        </PrimaryButton>
      )}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  return (
    <GameShell title={t("Abyss Crash")} session={session} aside={aside}>
      <div className="space-y-3">
        <div className="relative">
          <canvas ref={canvasRef} width={800} height={420} role="img" aria-label={t("Curva de multiplicador de Crash")} className="aspect-[40/21] w-full rounded-2xl border border-white/10" />
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-live="off">
            <div className={`font-mono text-5xl font-black tabular-nums drop-shadow sm:text-7xl ${crashed ? 'text-rose-400' : phase === 'done' ? 'text-emerald-400' : 'text-white'}`}>{display.toFixed(2)}×</div>
            {phase === 'done' && <div className="mt-1 text-sm font-semibold text-slate-200">{crashed ? 'Crash' : 'Retirado'}</div>}
            {phase === 'starting' && <div className="mt-1 text-sm text-slate-300">{t("Preparando ronda…")}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Apuesta" value={minor ? formatMinor(minor, session.currency) : '—'} />
          <Stat label={t("Ganancia potencial")} value={minor ? formatMinor(winUnits(BigInt(minor), display)) : '—'} tone={running ? 'win' : undefined} />
          <Stat label={t("Retiro auto")} value={useAuto ? `${auto.toFixed(2)}×` : 'Manual'} />
        </div>
        <ResultBanner win={phase === 'done' && last ? !!won : null} text={last ? (won ? `Retiraste a ${Number(last.multiplier).toFixed(2)}×: +${formatMinor(last.win, last.currency)}` : `Crash en ${(view?.crashPoint ?? 1).toFixed(2)}×. Sin premio.`) : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
