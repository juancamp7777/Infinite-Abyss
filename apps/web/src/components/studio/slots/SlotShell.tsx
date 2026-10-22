'use client';

/**
 * Shell común de las slots de Studios: saldo, apuesta, giro, turbo, autoplay, bonus buy, historial,
 * celebraciones y panel provably fair. La animación la hace la escena Canvas; el resultado, el servidor.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { History, Loader2, RotateCw, ShieldCheck, ShoppingCart, Volume2, VolumeX, Zap, X, Minus, Plus, Play, Square } from 'lucide-react';
import { Stage, sound } from '../engine';
import FairnessPanel from '../originals/FairnessPanel';
import type { PublicRound } from '../originals/api';
import type { StudioGameProps } from '../types';
import { formatMinor, toMinorUnits } from '@/lib/modules';
import { betBounds, betSteps, defaultBetIndex } from '@/lib/bets';
import { errorMessage, prepare, slotApi, winUnits, type SlotRound } from '@/lib/studio/api';
import type { SceneCtl, SceneFactory, SlotScene } from './scene';

const AUTO_OPTIONS = [10, 25, 50, 100];
const TIERS = [
  { min: 50, name: 'EPIC WIN', tier: 3, color: '#ff5cf0' },
  { min: 25, name: 'MEGA WIN', tier: 2, color: '#ffb02e' },
  { min: 10, name: 'BIG WIN', tier: 1, color: '#ffe066' },
];

export interface SlotShellProps<O extends { totalWin: number }> {
  game: StudioGameProps;
  title: string;
  accent: string;
  createScene: SceneFactory<O>;
  bonusBuy?: { cost: number } | null;
  /** Texto accesible de la descripción del juego. */
  description: string;
}

interface Celebration {
  name: string;
  color: string;
  units: bigint;
  mult: number;
  duration: number;
}

const useSound = () => useSyncExternalStore(sound.subscribe.bind(sound), () => sound.enabled, () => false);

export default function SlotShell<O extends { totalWin: number }>({ game, title, accent, createScene, bonusBuy, description }: SlotShellProps<O>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const sceneRef = useRef<SlotScene<O> | null>(null);
  const factoryRef = useRef(createScene);
  const soundOn = useSound();

  const [boot, setBoot] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bootError, setBootError] = useState('');
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [currency, setCurrency] = useState('');
  const [betIdx, setBetIdx] = useState(0);
  // Montos de apuesta (unidades mínimas) según la moneda y los límites del operador.
  const [steps, setSteps] = useState<string[]>(() => betSteps(''));
  const [busy, setBusy] = useState(false);
  const [turbo, setTurbo] = useState(false);
  const [winMult, setWinMult] = useState(0);
  const [winAmount, setWinAmount] = useState<bigint>(BigInt(0));
  const [fs, setFs] = useState<{ left: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<SlotRound<O>[]>([]);
  const [panel, setPanel] = useState<'none' | 'history' | 'fair'>('none');
  const [buyOpen, setBuyOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoLeft, setAutoLeft] = useState(0);
  const [stopWin, setStopWin] = useState('0');
  const [stopBelow, setStopBelow] = useState('0');
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [celeValue, setCeleValue] = useState(BigInt(0));
  const [lastRound, setLastRound] = useState<SlotRound<O> | null>(null);

  // Refs con el estado vigente para los bucles asíncronos (autoplay).
  const balanceRef = useRef(balance);
  const betRef = useRef(steps[betIdx] ?? steps[0]);
  const turboRef = useRef(turbo);
  const busyRef = useRef(false);
  const autoRef = useRef({ active: false, left: 0 });
  const stopWinRef = useRef(0);
  const stopBelowRef = useRef(BigInt(0));
  const celeClose = useRef<(() => void) | null>(null);
  const skipRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    balanceRef.current = balance;
    betRef.current = steps[betIdx] ?? steps[0];
    turboRef.current = turbo;
  }, [balance, steps, betIdx, turbo]);

  const bet = steps[betIdx] ?? steps[0];
  const stake = BigInt(bet);
  const buyCost = bonusBuy ? stake * BigInt(bonusBuy.cost) : BigInt(0);

  const baseScale = useCallback((): number => {
    const stage = stageRef.current;
    if (!stage) return 1;
    if (stage.reducedMotion) return 6;
    if (skipRef.current) return 14;
    return turboRef.current ? 2.4 : 1;
  }, []);

  const loadAll = useCallback(async () => {
    setBoot('loading');
    setBootError('');
    try {
      await prepare(game);
      const b = await slotApi.balance(game);
      setBalance(BigInt(b.balance));
      setCurrency(b.currency);
      const list = betSteps(b.currency);
      setSteps(list);
      setBetIdx(defaultBetIndex(list, betBounds().min));
      slotApi
        .rounds(game, 20)
        .then((r) => setHistory(r.rounds as SlotRound<O>[]))
        .catch(() => undefined);
      setBoot('ready');
    } catch (e) {
      setBootError(errorMessage(e));
      setBoot('error');
    }
  }, [game]);

  useEffect(() => {
    aliveRef.current = true;
    void loadAll();
    return () => {
      aliveRef.current = false;
    };
  }, [loadAll]);

  // Canvas + escena.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = new Stage(canvas);
    stageRef.current = stage;
    sceneRef.current = factoryRef.current(stage);
    stage.start();
    return () => {
      sceneRef.current?.destroy();
      sceneRef.current = null;
      stage.destroy();
      stageRef.current = null;
    };
  }, []);

  const closeCelebration = useCallback(() => {
    celeClose.current?.();
    celeClose.current = null;
    setCelebration(null);
  }, []);

  const celebrate = useCallback(
    (round: SlotRound<O>): Promise<void> => {
      const t = TIERS.find((x) => round.multiplier >= x.min);
      if (!t) return Promise.resolve();
      const units = BigInt(round.win);
      const reduced = !!stageRef.current?.reducedMotion;
      const duration = reduced ? 0 : (turboRef.current ? 1400 : 2600) + t.tier * 600;
      sceneRef.current?.celebrate(t.tier);
      sound.play('big');
      setCelebration({ name: t.name, color: t.color, units, mult: round.multiplier, duration });
      setCeleValue(reduced ? units : BigInt(0));
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => closeCelebration(), duration + (autoRef.current.active ? 900 : 4500));
        celeClose.current = () => {
          window.clearTimeout(timer);
          resolve();
        };
      });
    },
    [closeCelebration],
  );

  // Contador de la celebración.
  useEffect(() => {
    if (!celebration || celebration.duration === 0) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / celebration.duration);
      const e = 1 - Math.pow(1 - k, 3);
      setCeleValue((celebration.units * BigInt(Math.round(e * 10000))) / BigInt(10000));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [celebration]);

  /** Un giro completo. Devuelve el multiplicador ganado o null si falló. */
  const spin = useCallback(
    async (buy: boolean): Promise<number | null> => {
      if (busyRef.current || !sceneRef.current || !stageRef.current) return null;
      const amount = BigInt(betRef.current);
      const cost = buy && bonusBuy ? amount * BigInt(bonusBuy.cost) : amount;
      if (balanceRef.current < cost) {
        setError('Saldo insuficiente para esta apuesta');
        return null;
      }
      busyRef.current = true;
      skipRef.current = false;
      setBusy(true);
      setError('');
      setWinMult(0);
      setWinAmount(BigInt(0));
      setFs(null);
      setBalance(balanceRef.current - cost);
      sound.play('click');
      let round: SlotRound<O> | null = null;
      try {
        const res = await slotApi.play<O>(game, amount.toString(), buy);
        round = res.round;
        const stage = stageRef.current;
        if (stage) stage.timeScale = baseScale();
        const ctl: SceneCtl = {
          turbo: turboRef.current,
          onWin: (m) => {
            setWinMult(m);
            setWinAmount(winUnits(amount, m));
          },
          onFreeSpins: (info) => setFs(info),
          sfx: (n, i) => sound.play(n, i),
        };
        await sceneRef.current.play(round.outcome, ctl);
        setWinMult(round.multiplier);
        setWinAmount(BigInt(round.win));
        if (res.balance != null) setBalance(BigInt(res.balance));
        else setBalance((b) => b + BigInt(round!.win));
        setHistory((h) => [round!, ...h].slice(0, 30));
        setLastRound(round);
        if (stage) stage.timeScale = 1;
        skipRef.current = false;
        await celebrate(round);
        return round.multiplier;
      } catch (e) {
        setError(errorMessage(e));
        if (stageRef.current) stageRef.current.timeScale = 1;
        // Resincroniza el saldo con el servidor (el débito puede o no haberse aplicado).
        slotApi
          .balance(game)
          .then((b) => aliveRef.current && setBalance(BigInt(b.balance)))
          .catch(() => undefined);
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
        setFs(null);
      }
    },
    [bonusBuy, game, baseScale, celebrate],
  );

  const stopAuto = useCallback(() => {
    autoRef.current.active = false;
    autoRef.current.left = 0;
    setAutoLeft(0);
  }, []);

  const startAuto = useCallback(
    async (n: number) => {
      stopWinRef.current = Math.max(0, parseFloat(stopWin) || 0);
      stopBelowRef.current = toMinorUnits(stopBelow, currency) ?? BigInt(0);
      autoRef.current = { active: true, left: n };
      setAutoLeft(n);
      setAutoOpen(false);
      while (autoRef.current.active && autoRef.current.left > 0 && aliveRef.current) {
        const m = await spin(false);
        if (m === null) break;
        autoRef.current.left -= 1;
        setAutoLeft(autoRef.current.left);
        if (stopWinRef.current > 0 && m >= stopWinRef.current) break;
        if (stopBelowRef.current > BigInt(0) && balanceRef.current < stopBelowRef.current) break;
        if (balanceRef.current < BigInt(betRef.current)) break;
      }
      stopAuto();
    },
    [spin, stopAuto, stopWin, stopBelow, currency],
  );

  const skip = () => {
    if (!busyRef.current || skipRef.current) return;
    skipRef.current = true;
    if (stageRef.current) stageRef.current.timeScale = baseScale();
  };

  const onSpinClick = () => {
    if (autoRef.current.active) {
      stopAuto();
      return;
    }
    if (busyRef.current) {
      // Segundo toque durante el giro: saltar la animación.
      skip();
      return;
    }
    void spin(false);
  };

  // Espacio = girar; Escape cierra diálogos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setBuyOpen(false);
        setAutoOpen(false);
        setPanel('none');
        return;
      }
      if (e.code !== 'Space') return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(el.tagName)) return;
      e.preventDefault();
      if (celeClose.current) {
        closeCelebration();
        return;
      }
      if (buyOpen || boot !== 'ready') return;
      onSpinClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyOpen, boot, closeCelebration]);

  const confirmBuy = () => {
    setBuyOpen(false);
    void spin(true);
  };

  const changeBet = (d: number) => setBetIdx((i) => Math.min(steps.length - 1, Math.max(0, i + d)));
  const auto = autoLeft > 0;
  const money = (v: bigint) => formatMinor(v, currency || undefined);
  const accentStyle = { '--accent': accent } as React.CSSProperties;

  return (
    <div className="flex h-dvh w-full flex-col bg-slate-950 text-slate-100 select-none" style={accentStyle}>
      <header className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
        <h1 className="truncate text-base font-extrabold tracking-wide" style={{ color: accent }}>
          {title}
          {game.mode === 'demo' && <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">DEMO</span>}
        </h1>
        <div className="flex items-center gap-1">
          <div className="mr-2 text-right leading-tight" aria-live="polite">
            <div className="text-[10px] uppercase text-slate-400">Saldo</div>
            <div className="font-mono text-sm font-bold" aria-label={`Saldo ${money(balance)} ${currency}`}>
              {money(balance)} <span className="text-[10px] text-slate-400">{currency}</span>
            </div>
          </div>
          <IconBtn label={soundOn ? 'Silenciar sonido' : 'Activar sonido'} onClick={() => sound.setEnabled(!soundOn)}>
            {soundOn ? <Volume2 size={18} /> : <VolumeX size={18} />}
          </IconBtn>
          <IconBtn label="Historial de giros" active={panel === 'history'} onClick={() => setPanel(panel === 'history' ? 'none' : 'history')}>
            <History size={18} />
          </IconBtn>
          <IconBtn label="Provably fair" active={panel === 'fair'} onClick={() => setPanel(panel === 'fair' ? 'none' : 'fair')}>
            <ShieldCheck size={18} />
          </IconBtn>
        </div>
      </header>

      <main className="relative min-h-0 flex-1" aria-label={description}>
        <div className="absolute inset-0" onClick={skip}>
          <canvas ref={canvasRef} className="block h-full w-full touch-manipulation" role="img" aria-label={description} />
        </div>
        {boot === 'loading' && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/70" role="status">
            <Loader2 className="animate-spin" aria-hidden />
            <span className="sr-only">Cargando juego</span>
          </div>
        )}
        {boot === 'error' && (
          <div className="absolute inset-0 grid place-items-center bg-slate-950/90 p-6 text-center" role="alert">
            <div>
              <p className="mb-3 text-sm text-rose-300">{bootError}</p>
              <button type="button" onClick={() => void loadAll()} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold hover:bg-slate-700">
                Reintentar
              </button>
            </div>
          </div>
        )}
        {fs && (
          <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-white/20 bg-black/60 px-4 py-1 text-sm font-bold" style={{ color: accent }} role="status">
            Giros gratis {fs.total - fs.left}/{fs.total}
          </div>
        )}
        {error && (
          <p role="alert" className="absolute inset-x-3 bottom-2 mx-auto max-w-md rounded-lg bg-rose-950/90 px-3 py-2 text-center text-sm text-rose-100">
            {error}
          </p>
        )}

        {celebration && (
          <button type="button" onClick={closeCelebration} aria-label="Cerrar celebración" className="absolute inset-0 grid place-items-center bg-black/55 text-center outline-none" style={{ cursor: 'pointer' }}>
            <span>
              <span className="block text-4xl font-black tracking-widest sm:text-6xl" style={{ color: celebration.color, textShadow: `0 0 24px ${celebration.color}` }}>
                {celebration.name}
              </span>
              <span className="mt-2 block font-mono text-3xl font-extrabold text-white sm:text-5xl" aria-live="polite">
                {money(celeValue)} <span className="text-lg text-slate-300">{currency}</span>
              </span>
              <span className="mt-1 block text-sm text-slate-300">{celebration.mult.toLocaleString('es', { maximumFractionDigits: 2 })}x · toca para continuar</span>
            </span>
          </button>
        )}

        {panel !== 'none' && (
          <aside className="absolute inset-x-0 bottom-0 z-10 max-h-[70%] overflow-y-auto rounded-t-2xl border-t border-white/10 bg-slate-950/95 p-3 backdrop-blur" aria-label={panel === 'history' ? 'Historial' : 'Provably fair'}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-bold">{panel === 'history' ? 'Historial de giros' : 'Provably fair'}</h2>
              <IconBtn label="Cerrar panel" onClick={() => setPanel('none')}>
                <X size={16} />
              </IconBtn>
            </div>
            {panel === 'history' ? (
              history.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">Aún no hay giros. ¡Haz tu primera apuesta!</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400">
                    <tr>
                      <th className="py-1">Hora</th>
                      <th>Apuesta</th>
                      <th>Multi</th>
                      <th className="text-right">Ganancia</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {history.map((r) => (
                      <tr key={r.id} className={r.multiplier > 0 ? 'text-emerald-300' : 'text-slate-400'}>
                        <td className="py-0.5">{new Date(r.createdAt).toLocaleTimeString()}</td>
                        <td>{money(BigInt(r.bet))}</td>
                        <td>{r.multiplier.toLocaleString('es', { maximumFractionDigits: 2 })}x</td>
                        <td className="text-right">{money(BigInt(r.win))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : (
              <FairnessPanel defaultOpen game={game} lastRound={lastRound as unknown as PublicRound | null} />
            )}
          </aside>
        )}
      </main>

      <footer className="border-t border-white/10 bg-slate-900/80 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-[6.5rem] leading-tight" aria-live="polite">
            <div className="text-[10px] uppercase text-slate-400">Ganancia</div>
            <div className={`font-mono text-lg font-extrabold ${winAmount > BigInt(0) ? 'text-emerald-300' : 'text-slate-300'}`}>{money(winAmount)}</div>
            {winMult > 0 && <div className="text-[10px] text-slate-400">{winMult.toLocaleString('es', { maximumFractionDigits: 2 })}x</div>}
          </div>

          <div className="flex items-center gap-1" role="group" aria-label="Selector de apuesta">
            <IconBtn label="Bajar apuesta" disabled={busy || betIdx === 0} onClick={() => changeBet(-1)}>
              <Minus size={16} />
            </IconBtn>
            <div className="min-w-[5rem] text-center leading-tight">
              <div className="text-[10px] uppercase text-slate-400">Apuesta</div>
              <div className="font-mono text-base font-bold">{money(stake)}</div>
            </div>
            <IconBtn label="Subir apuesta" disabled={busy || betIdx === steps.length - 1} onClick={() => changeBet(1)}>
              <Plus size={16} />
            </IconBtn>
          </div>

          <div className="flex items-center gap-2">
            {bonusBuy && (
              <button type="button" aria-label={`Comprar bonus por ${money(buyCost)}`} disabled={busy || boot !== 'ready'} onClick={() => setBuyOpen(true)} className="flex h-11 items-center gap-1 rounded-xl border border-white/15 bg-slate-800 px-3 text-xs font-bold hover:bg-slate-700 disabled:opacity-40">
                <ShoppingCart size={16} aria-hidden /> <span className="hidden sm:inline">Bonus</span> {bonusBuy.cost}x
              </button>
            )}
            <button type="button" aria-label="Modo turbo" aria-pressed={turbo} onClick={() => setTurbo((v) => !v)} className={`grid h-11 w-11 place-items-center rounded-xl border border-white/15 ${turbo ? 'bg-amber-500 text-black' : 'bg-slate-800 hover:bg-slate-700'}`}>
              <Zap size={18} />
            </button>
            <div className="relative">
              <button
                type="button"
                aria-label={auto ? 'Detener autoplay' : 'Configurar autoplay'}
                aria-haspopup="dialog"
                aria-expanded={autoOpen}
                disabled={boot !== 'ready' || (busy && !auto)}
                onClick={() => (auto ? stopAuto() : setAutoOpen((v) => !v))}
                className={`flex h-11 items-center gap-1 rounded-xl border border-white/15 px-3 text-xs font-bold disabled:opacity-40 ${auto ? 'bg-rose-600' : 'bg-slate-800 hover:bg-slate-700'}`}
              >
                {auto ? <Square size={14} aria-hidden /> : <Play size={14} aria-hidden />} {auto ? autoLeft : 'Auto'}
              </button>
              {autoOpen && (
                <div role="dialog" aria-label="Autoplay" className="absolute bottom-14 right-0 z-20 w-64 rounded-xl border border-white/10 bg-slate-950 p-3 text-xs shadow-xl">
                  <p className="mb-2 font-bold">Número de giros</p>
                  <div className="mb-3 grid grid-cols-4 gap-1">
                    {AUTO_OPTIONS.map((n) => (
                      <button key={n} type="button" onClick={() => void startAuto(n)} className="rounded-lg bg-slate-800 py-2 font-bold hover:bg-slate-700">
                        {n}
                      </button>
                    ))}
                  </div>
                  <label className="mb-2 block">
                    <span className="text-slate-400">Parar si una ganancia supera (x apuesta, 0 = no)</span>
                    <input inputMode="decimal" value={stopWin} onChange={(e) => setStopWin(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 outline-none focus:border-[var(--accent)]" />
                  </label>
                  <label className="block">
                    <span className="text-slate-400">Parar si el saldo baja de ({currency}, 0 = no)</span>
                    <input inputMode="decimal" value={stopBelow} onChange={(e) => setStopBelow(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900 px-2 py-1.5 outline-none focus:border-[var(--accent)]" />
                  </label>
                </div>
              )}
            </div>
            <button
              type="button"
              aria-label={busy ? 'Saltar animación' : 'Girar'}
              disabled={boot !== 'ready'}
              onClick={onSpinClick}
              className="grid h-14 w-14 place-items-center rounded-full text-black shadow-lg transition-transform active:scale-95 disabled:opacity-50"
              style={{ background: `radial-gradient(circle at 30% 30%, #fff, ${accent})`, boxShadow: `0 0 18px ${accent}` }}
            >
              <RotateCw size={26} className={busy ? 'animate-spin' : ''} aria-hidden />
            </button>
          </div>
        </div>
      </footer>

      {buyOpen && bonusBuy && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Confirmar bonus buy">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 text-center">
            <h2 className="mb-1 text-lg font-extrabold" style={{ color: accent }}>
              Comprar bonus
            </h2>
            <p className="mb-4 text-sm text-slate-300">
              Pagas <b>{bonusBuy.cost}x</b> tu apuesta y entras directo a los giros gratis.
            </p>
            <p className="mb-4 font-mono text-2xl font-black">
              {money(buyCost)} <span className="text-sm text-slate-400">{currency}</span>
            </p>
            {balance < buyCost && <p className="mb-3 text-sm text-rose-300">Saldo insuficiente.</p>}
            <div className="flex gap-2">
              <button type="button" autoFocus onClick={() => setBuyOpen(false)} className="flex-1 rounded-xl bg-slate-800 py-3 text-sm font-bold hover:bg-slate-700">
                Cancelar
              </button>
              <button type="button" disabled={balance < buyCost} onClick={confirmBuy} className="flex-1 rounded-xl py-3 text-sm font-extrabold text-black disabled:opacity-40" style={{ background: accent }}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children, active, disabled }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={`grid h-10 w-10 place-items-center rounded-xl border border-white/10 disabled:opacity-40 ${active ? 'bg-white/20' : 'bg-slate-800/80 hover:bg-slate-700'}`}>
      {children}
    </button>
  );
}
