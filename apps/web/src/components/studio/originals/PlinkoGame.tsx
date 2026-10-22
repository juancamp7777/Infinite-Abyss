'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioGameProps } from '../types';
import { errorMessage, studioApi, type PublicRound } from './api';
import FairnessPanel from './FairnessPanel';
import { BetInput, GameShell, HistoryStrip, NumberField, PrimaryButton, ResultBanner, Segmented, TurboToggle, formatMinor, sleep, toMinorString, useRoundHistory, useStudioSession, useBetAmount } from './common';

interface PlinkoOutcome {
  rows: number;
  risk: 'low' | 'medium' | 'high';
  path: number[];
  bin: number;
  payout: number;
}

interface Ball {
  id: string;
  path: number[];
  bin: number;
  start: number;
  stepMs: number;
  round: PublicRound;
  balance: string | null;
  landed: boolean;
}

interface Flash {
  bin: number;
  until: number;
  text: string;
  win: boolean;
}

const W = 640;
const H = 560;

export default function PlinkoGame(props: StudioGameProps) {
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const [bet, setBet] = useBetAmount(session);
  const [rows, setRows] = useState(12);
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium');
  const [turbo, setTurbo] = useState(false);
  const [autoCount, setAutoCount] = useState(10);
  const [autoLeft, setAutoLeft] = useState(0);
  const [pending, setPending] = useState(0);
  const [last, setLast] = useState<PublicRound | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballsRef = useRef<Ball[]>([]);
  const flashRef = useRef<Flash[]>([]);
  const rowsRef = useRef(rows);
  const stopRef = useRef(false);
  const sessionRef = useRef(session);
  const historyRef = useRef(history);

  useEffect(() => {
    rowsRef.current = rows;
    sessionRef.current = session;
    historyRef.current = history;
  });

  const minor = toMinorString(bet);

  // Bucle de dibujo: solo anima los resultados que ya decidió el servidor.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = (now: number) => {
      const n = rowsRef.current;
      const dx = (W - 80) / (n + 1);
      const dy = (H - 110) / (n + 1);
      const cx = W / 2;
      const top = 40;
      ctx.clearRect(0, 0, W, H);
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0f172a');
      g.addColorStop(1, '#020617');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      // pernos
      ctx.fillStyle = '#94a3b8';
      for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
          ctx.beginPath();
          ctx.arc(cx + (j - i / 2) * dx, top + i * dy, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // casillas
      flashRef.current = flashRef.current.filter((f) => f.until > now);
      for (let j = 0; j <= n; j++) {
        const edge = Math.abs(j - n / 2) / (n / 2);
        const hue = 150 - edge * 150;
        const fl = flashRef.current.find((f) => f.bin === j);
        const bw = dx * 0.88;
        const x = cx + (j - n / 2) * dx - bw / 2;
        const y = top + n * dy + 6;
        ctx.fillStyle = fl ? (fl.win ? '#34d399' : '#f43f5e') : `hsl(${hue} 70% ${fl ? 60 : 38}%)`;
        ctx.beginPath();
        ctx.roundRect(x, y + (fl ? 5 : 0), bw, 26, 5);
        ctx.fill();
        if (fl) {
          ctx.fillStyle = '#020617';
          ctx.font = 'bold 12px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(fl.text, x + bw / 2, y + 23);
        }
      }
      // bolas
      for (const b of ballsRef.current) {
        const t = (now - b.start) / b.stepMs;
        const total = b.path.length;
        if (t < 0) continue;
        let s = 0;
        const stepsDone = Math.min(total, Math.floor(t));
        for (let k = 0; k < stepsDone; k++) s += b.path[k];
        const f = Math.min(1, t - stepsDone);
        const x0 = (s - stepsDone / 2) * dx;
        const y0 = top + (stepsDone - 1) * dy;
        let bx = x0;
        let by = y0;
        if (stepsDone < total) {
          const dir = b.path[stepsDone] ? 0.5 : -0.5;
          bx = x0 + dir * dx * f;
          by = y0 + dy * f - Math.sin(Math.PI * f) * dy * 0.45;
          if (stepsDone === 0) by = top - dy * (1 - f) - Math.sin(Math.PI * f) * dy * 0.3;
        } else {
          by = top + total * dy - 4;
        }
        ctx.fillStyle = '#fbbf24';
        ctx.shadowColor = '#fbbf24';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(cx + bx, by, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (t >= total && !b.landed) {
          b.landed = true;
          const o = b.round.outcome as PlinkoOutcome;
          const win = o.payout >= 1;
          flashRef.current.push({ bin: o.bin, until: now + 1400, text: `${o.payout}×`, win });
          sessionRef.current.applyBalance(b.balance);
          historyRef.current.push(b.round);
          setLast(b.round);
          setPending((p) => Math.max(0, p - 1));
        }
      }
      ballsRef.current = ballsRef.current.filter((b) => !b.landed);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const drop = useCallback(async (): Promise<boolean> => {
    if (!minor) return false;
    try {
      const r = await studioApi.play(props, minor, { rows, risk });
      const o = r.round.outcome as PlinkoOutcome;
      setPending((p) => p + 1);
      ballsRef.current.push({ id: r.round.id, path: o.path, bin: o.bin, start: performance.now(), stepMs: turbo ? 45 : 120, round: r.round, balance: r.balance, landed: false });
      return true;
    } catch (e) {
      session.setError(errorMessage(e));
      return false;
    }
  }, [minor, props, rows, risk, turbo, session]);

  const single = () => {
    session.setError(null);
    void drop();
  };

  const auto = async () => {
    stopRef.current = false;
    session.setError(null);
    for (let i = autoCount; i > 0 && !stopRef.current; i--) {
      setAutoLeft(i);
      if (!(await drop())) break;
      await sleep(turbo ? 90 : 500);
    }
    setAutoLeft(0);
  };

  const locked = autoLeft > 0;
  const o = last?.outcome as PlinkoOutcome | undefined;
  const aside = (
    <>
      <BetInput value={bet} onChange={setBet} disabled={locked} />
      <Segmented label="Riesgo" value={risk} onChange={setRisk} disabled={locked} options={[{ value: 'low', label: 'Bajo' }, { value: 'medium', label: 'Medio' }, { value: 'high', label: 'Alto' }]} />
      <NumberField id="plinko-rows" label="Filas" value={rows} onChange={(v) => setRows(Math.round(v))} min={8} max={16} disabled={locked || pending > 0} />
      <TurboToggle value={turbo} onChange={setTurbo} />
      <NumberField id="plinko-auto" label="Apuestas automáticas" value={autoCount} onChange={(v) => setAutoCount(Math.round(v))} min={1} max={200} disabled={locked} />
      {locked ? (
        <PrimaryButton tone="stop" onClick={() => (stopRef.current = true)}>
          Detener autoplay ({autoLeft})
        </PrimaryButton>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <PrimaryButton disabled={!minor || !session.ready} onClick={single} aria-label="Soltar bola">
            Soltar
          </PrimaryButton>
          <PrimaryButton disabled={!minor || !session.ready} onClick={auto} aria-label="Iniciar autoplay">
            Auto
          </PrimaryButton>
        </div>
      )}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  return (
    <GameShell title="Nymfo Plinko" session={session} aside={aside}>
      <div className="space-y-3">
        <canvas ref={canvasRef} width={W} height={H} role="img" aria-label="Tablero de Plinko" className="aspect-[8/7] w-full rounded-2xl border border-white/10" />
        <ResultBanner win={o && last ? o.payout >= 1 : null} text={o && last ? `Casilla ${o.bin + 1}: ${o.payout}× · ${formatMinor(last.win, last.currency)}` : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
