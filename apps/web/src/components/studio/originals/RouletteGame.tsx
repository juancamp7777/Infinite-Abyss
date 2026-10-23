'use client';
import { useT } from "@/lib/i18n";

import { useCallback, useMemo, useRef, useState } from 'react';
import type { StudioGameProps } from '../types';
import { betSteps } from '@/lib/bets';
import { errorMessage, studioApi, type PublicRound } from './api';
import FairnessPanel from './FairnessPanel';
import { GameShell, HistoryStrip, NumberField, PrimaryButton, ResultBanner, TurboToggle, formatMinor, sleep, useRoundHistory, useStudioSession, usePrefersReducedMotion } from './common';

type BetType = 'straight' | 'dozen' | 'column' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high';
interface Spot {
  key: string;
  type: BetType;
  value?: number;
}
interface RouletteOutcome {
  number: number;
  color: 'red' | 'black' | 'green';
  bets: Array<{ type: string; amount: string; win: string }>;
}

const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const colorOf = (n: number) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
const FILL = { green: '#059669', red: '#dc2626', black: '#1e293b' } as const;
const STEP = 360 / 37;

const OUTSIDE: Array<Spot & { label: string }> = [
  { key: 'low', type: 'low', label: '1–18' },
  { key: 'even', type: 'even', label: 'Par' },
  { key: 'red', type: 'red', label: 'Rojo' },
  { key: 'black', type: 'black', label: 'Negro' },
  { key: 'odd', type: 'odd', label: 'Impar' },
  { key: 'high', type: 'high', label: '19–36' },
];

const spotOf = (key: string): Spot => {
  if (key.startsWith('n')) return { key, type: 'straight', value: Number(key.slice(1)) };
  if (key.startsWith('d')) return { key, type: 'dozen', value: Number(key.slice(1)) };
  if (key.startsWith('c')) return { key, type: 'column', value: Number(key.slice(1)) };
  return { key, type: key as BetType };
};

function Wheel({ rotation, ms }: { rotation: number; ms: number }) {
  const { t } = useT();
  const R = 100;
  const polar = (a: number, r: number) => [Math.sin((a * Math.PI) / 180) * r, -Math.cos((a * Math.PI) / 180) * r];
  return (
    <svg viewBox="-110 -110 220 220" className="mx-auto w-full max-w-[260px]" role="img" aria-label={t("Rueda de ruleta europea")}>
      <g style={{ transform: `rotate(${rotation}deg)`, transition: `transform ${ms}ms cubic-bezier(0.15, 0.6, 0.1, 1)` }}>
        <circle r="108" fill="#78350f" />
        {WHEEL.map((n, i) => {
          const a0 = i * STEP - STEP / 2;
          const a1 = a0 + STEP;
          const [x0, y0] = polar(a0, R);
          const [x1, y1] = polar(a1, R);
          const [tx, ty] = polar(i * STEP, R - 10);
          return (
            <g key={n}>
              <path d={`M0 0 L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z`} fill={FILL[colorOf(n)]} stroke="#fbbf24" strokeWidth="0.4" />
              <text x={tx} y={ty} fontSize="7" fill="#fff" textAnchor="middle" dominantBaseline="middle" transform={`rotate(${i * STEP} ${tx} ${ty})`}>
                {n}
              </text>
            </g>
          );
        })}
        <circle r="60" fill="#0f172a" stroke="#fbbf24" strokeWidth="1" />
        <circle r="8" fill="#fbbf24" />
      </g>
      <polygon points="0,-108 -6,-98 6,-98" fill="#fff" />
    </svg>
  );
}

export default function RouletteGame(props: StudioGameProps) {
  const { t } = useT();
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const reduced = usePrefersReducedMotion();
  // Fichas según la moneda y los montos del operador; la seleccionada por defecto es la segunda.
  const CHIPS = useMemo(() => betSteps(session.currency).slice(0, 5).map((c) => BigInt(c)), [session.currency]);
  const [chipSel, setChip] = useState<bigint | null>(null);
  const chip = chipSel !== null && CHIPS.includes(chipSel) ? chipSel : CHIPS[Math.min(1, CHIPS.length - 1)];
  const [bets, setBets] = useState<Record<string, bigint>>({});
  const [turbo, setTurbo] = useState(false);
  const [autoCount, setAutoCount] = useState(5);
  const [autoLeft, setAutoLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [spinMs, setSpinMs] = useState(0);
  const [last, setLast] = useState<PublicRound | null>(null);
  const rotRef = useRef(0);
  const stopRef = useRef(false);

  const total = useMemo(() => Object.values(bets).reduce((a, b) => a + b, BigInt(0)), [bets]);
  const out = last?.outcome as RouletteOutcome | undefined;
  const bal = session.balance ? BigInt(session.balance) : BigInt(0);
  const locked = busy || autoLeft > 0;

  const place = (key: string) => {
    if (locked) return;
    setBets((b) => ({ ...b, [key]: (b[key] ?? BigInt(0)) + chip }));
  };
  const removeOne = (key: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (locked) return;
    setBets((b) => {
      const { [key]: cur, ...rest } = b;
      if (cur === undefined) return b;
      return cur > chip ? { ...b, [key]: cur - chip } : rest;
    });
  };

  const spin = useCallback(async (): Promise<boolean> => {
    if (total <= BigInt(0)) return false;
    try {
      const params = { bets: Object.entries(bets).map(([k, amt]) => {
          const sp = spotOf(k);
          return sp.value === undefined ? { type: sp.type, amount: amt.toString() } : { type: sp.type, value: sp.value, amount: amt.toString() };
        }) };
      const r = await studioApi.play(props, total.toString(), params);
      const o = r.round.outcome as RouletteOutcome;
      // La rueda se detiene en el número que decidió el servidor.
      const k = WHEEL.indexOf(o.number);
      const target = (360 - k * STEP) % 360;
      const ms = turbo || reduced ? 700 : 4200;
      const next = Math.floor(rotRef.current / 360) * 360 + (turbo || reduced ? 360 : 1800) + target;
      rotRef.current = next;
      setSpinMs(ms);
      setRotation(next);
      await sleep(ms + 150);
      session.applyBalance(r.balance);
      setLast(r.round);
      history.push(r.round);
      return true;
    } catch (e) {
      session.setError(errorMessage(e));
      return false;
    }
  }, [bets, total, props, turbo, reduced, session, history]);

  const single = async () => {
    setBusy(true);
    session.setError(null);
    await spin();
    setBusy(false);
  };

  const auto = async () => {
    setBusy(true);
    stopRef.current = false;
    session.setError(null);
    for (let i = autoCount; i > 0 && !stopRef.current; i--) {
      setAutoLeft(i);
      if (!(await spin())) break;
      await sleep(turbo ? 100 : 600);
    }
    setAutoLeft(0);
    setBusy(false);
  };

  const chipOn = (key: string) =>
    bets[key] ? (
      <span aria-hidden className="absolute -right-1 -top-1 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-slate-900 shadow">
        {formatMinor(bets[key])}
      </span>
    ) : null;
  const cell = 'relative flex items-center justify-center rounded text-xs font-bold text-white transition hover:brightness-125 disabled:opacity-60 sm:text-sm h-9 sm:h-11';
  const hit = out ? out.number : null;
  const spotLabel = (k: string, label: string) => `${label}${bets[k] ? `, apostado ${formatMinor(bets[k])}` : ''}`;

  const aside = (
    <>
      <div role="radiogroup" aria-label={t("Valor de la ficha")}>
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">{t("Ficha")}</div>
        <div className="flex gap-1">
          {CHIPS.map((c) => (
            <button key={c.toString()} type="button" role="radio" aria-checked={chip === c} onClick={() => setChip(c)} className={`flex-1 rounded-full border-2 py-2 text-xs font-bold ${chip === c ? 'border-amber-400 bg-amber-400 text-slate-900' : 'border-slate-600 bg-slate-800 text-slate-200'}`}>
              {formatMinor(c)}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-slate-500">{t("Clic derecho o mantén pulsado para quitar una ficha.")}</p>
      </div>
      <div className="rounded-lg bg-slate-900 px-3 py-2 text-sm">
        Apuesta total: <span className="font-mono font-semibold">{formatMinor(total, session.currency)}</span>
        {total > bal && session.ready && <p className="text-xs text-rose-300">{t("Saldo insuficiente")}</p>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={locked || total === BigInt(0)} onClick={() => setBets({})} className="rounded-lg bg-slate-800 py-2 text-sm font-semibold hover:bg-slate-700 disabled:opacity-50">
          Limpiar
        </button>
        <button type="button" disabled={locked || total === BigInt(0)} onClick={() => setBets((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v * BigInt(2)])))} className="rounded-lg bg-slate-800 py-2 text-sm font-semibold hover:bg-slate-700 disabled:opacity-50">
          Doblar
        </button>
      </div>
      <TurboToggle value={turbo} onChange={setTurbo} />
      <NumberField id="roulette-auto" label={t("Giros automáticos")} value={autoCount} onChange={(v) => setAutoCount(Math.round(v))} min={1} max={100} disabled={locked} />
      {autoLeft > 0 ? (
        <PrimaryButton tone="stop" onClick={() => (stopRef.current = true)}>
          Detener autoplay ({autoLeft})
        </PrimaryButton>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <PrimaryButton disabled={locked || total === BigInt(0) || total > bal || !session.ready} onClick={single} aria-label={t("Girar la ruleta")}>
            {busy ? 'Girando…' : 'Girar'}
          </PrimaryButton>
          <PrimaryButton disabled={locked || total === BigInt(0) || total > bal || !session.ready} onClick={auto} aria-label={t("Iniciar autoplay")}>
            Auto
          </PrimaryButton>
        </div>
      )}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  return (
    <GameShell title={t("Abyss Roulette")} session={session} aside={aside}>
      <div className="space-y-3">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-around">
          <Wheel rotation={rotation} ms={spinMs} />
          <div className="text-center" aria-live="polite">
            <div className="text-xs uppercase tracking-wider text-slate-400">{t("Número")}</div>
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border-4 border-amber-400 text-4xl font-black text-white" style={{ background: hit === null ? '#334155' : FILL[colorOf(hit)] }}>
              {hit ?? '—'}
            </div>
          </div>
        </div>
        <div className="overflow-x-auto pb-1">
          <div className="min-w-[560px] space-y-1 rounded-xl bg-emerald-900/40 p-2">
            <div className="grid grid-cols-[48px_1fr_56px] gap-1">
              <button type="button" aria-label={spotLabel('n0', 'Cero')} disabled={locked} onClick={() => place('n0')} onContextMenu={(e) => removeOne('n0', e)} className={`${cell} row-span-3 h-auto`} style={{ background: FILL.green }}>
                0{chipOn('n0')}
              </button>
              <div className="grid grid-cols-12 grid-rows-3 gap-1">
                {[3, 2, 1].flatMap((r) =>
                  Array.from({ length: 12 }, (_, c) => {
                    const n = c * 3 + r;
                    const k = `n${n}`;
                    return (
                      <button key={n} type="button" aria-label={spotLabel(k, `Número ${n}`)} disabled={locked} onClick={() => place(k)} onContextMenu={(e) => removeOne(k, e)} className={`${cell} ${hit === n ? 'ring-2 ring-white' : ''}`} style={{ background: FILL[colorOf(n)] }}>
                        {n}
                        {chipOn(k)}
                      </button>
                    );
                  }),
                )}
              </div>
              <div className="grid grid-rows-3 gap-1">
                {[3, 2, 1].map((v) => (
                  <button key={v} type="button" aria-label={spotLabel(`c${v}`, `Columna ${v}`)} disabled={locked} onClick={() => place(`c${v}`)} onContextMenu={(e) => removeOne(`c${v}`, e)} className={`${cell} bg-slate-700`}>
                    2:1{chipOn(`c${v}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="ml-[52px] mr-[60px] grid grid-cols-3 gap-1">
              {[1, 2, 3].map((v) => (
                <button key={v} type="button" aria-label={spotLabel(`d${v}`, `Docena ${v}`)} disabled={locked} onClick={() => place(`d${v}`)} onContextMenu={(e) => removeOne(`d${v}`, e)} className={`${cell} bg-slate-700`}>
                  {v === 1 ? '1ª 12' : v === 2 ? '2ª 12' : '3ª 12'}
                  {chipOn(`d${v}`)}
                </button>
              ))}
            </div>
            <div className="ml-[52px] mr-[60px] grid grid-cols-6 gap-1">
              {OUTSIDE.map((o) => (
                <button key={o.key} type="button" aria-label={spotLabel(o.key, o.label)} disabled={locked} onClick={() => place(o.key)} onContextMenu={(e) => removeOne(o.key, e)} className={`${cell} ${o.type === 'red' ? 'bg-red-600' : o.type === 'black' ? 'bg-slate-900' : 'bg-slate-700'}`}>
                  {o.label}
                  {chipOn(o.key)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <ResultBanner win={out && last ? BigInt(last.win) > BigInt(0) : null} text={out && last ? (BigInt(last.win) > BigInt(0) ? `Salió ${out.number} (${out.color === 'red' ? 'rojo' : out.color === 'black' ? 'negro' : 'verde'}). ¡Ganaste ${formatMinor(last.win, last.currency)}!` : `Salió ${out.number}. Sin premio.`) : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
