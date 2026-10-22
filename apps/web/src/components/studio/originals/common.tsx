'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Minus, Plus, Zap } from 'lucide-react';
import type { StudioGameProps } from '../types';
import { errorMessage, prepare, studioApi, type PublicRound } from './api';
import { formatMinor as formatMinorUnits, minorToEditable, operatorCurrency, toMinorUnits } from '@/lib/modules';
import { betBounds, betSteps, defaultBetIndex, withinBetBounds } from '@/lib/bets';

/* ───────────── dinero (unidades mínimas; decimales según la moneda del operador) ───────────── */

export function formatMinor(minor: string | bigint | null | undefined, currency = ''): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  if (typeof minor === 'string' && !/^-?\d+$/.test(minor)) return '—';
  return formatMinorUnits(minor, currency || undefined);
}

/** "12.5" → "1250" (COP: "5000" → "500000", acepta '.' de miles). Devuelve null si no es un monto válido y positivo. */
export function toMinorString(input: string, currency = ''): string | null {
  const v = toMinorUnits(input, currency || undefined);
  // Fuera de minBet/maxBet del operador no es una apuesta enviable.
  return v !== null && v > BigInt(0) && withinBetBounds(v) ? v.toString() : null;
}

export const fromMinorInput = (minor: bigint, currency = ''): string => minorToEditable(minor, currency || undefined);

/** Monto de apuesta inicial: primer monto rápido ≥ apuesta mínima, en la moneda del jugador (se fija al cargar el saldo). */
export function useBetAmount(session: StudioSession): [string, (v: string) => void] {
  const [bet, setBet] = useState('');
  const [touched, setTouched] = useState(false);
  const { ready, currency } = session;
  const initial = (() => {
    if (!ready) return '';
    const list = betSteps(currency);
    return fromMinorInput(BigInt(list[defaultBetIndex(list, betBounds().min)] ?? list[0]), currency);
  })();
  // Mientras el usuario no edite, el valor sigue al monto por defecto (que depende de la moneda cargada).
  const value = touched ? bet : initial;
  return [
    value,
    (v: string) => {
      setTouched(true);
      setBet(v);
    },
  ];
}

/* ───────────── hook de sesión de juego ───────────── */

export interface StudioSession {
  balance: string | null;
  currency: string;
  ready: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  /** Aplica el saldo devuelto por el servidor (si viene). */
  applyBalance: (b: string | null | undefined) => void;
  refresh: () => Promise<void>;
}

export function useStudioSession(props: StudioGameProps): StudioSession {
  const [balance, setBalance] = useState<string | null>(null);
  const [currency, setCurrency] = useState(operatorCurrency());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mode, session, gameId } = props;

  const refresh = useCallback(async () => {
    try {
      await prepare({ mode, session });
      const b = await studioApi.balance({ gameId, mode, session });
      setBalance(b.balance);
      setCurrency(b.currency);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReady(true);
    }
  }, [mode, session, gameId]);

  useEffect(() => {
    // Disparo asíncrono: el setState ocurre tras la respuesta, no en el cuerpo del efecto.
    const id = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(id);
  }, [refresh]);

  const applyBalance = useCallback((b: string | null | undefined) => {
    if (typeof b === 'string') setBalance(b);
  }, []);

  return { balance, currency, ready, error, setError, applyBalance, refresh };
}

/** Historial de rondas del jugador para este juego (se actualiza con push()). */
export function useRoundHistory(props: StudioGameProps, limit = 20) {
  const [rounds, setRounds] = useState<PublicRound[]>([]);
  const [loading, setLoading] = useState(true);
  const { mode, session, gameId } = props;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await prepare({ mode, session });
        const r = await studioApi.rounds({ gameId, mode, session }, limit);
        if (alive) setRounds(r.rounds.filter((x) => x.status === 'SETTLED'));
      } catch {
        /* el historial es opcional */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mode, session, gameId, limit]);

  const push = useCallback(
    (r: PublicRound) => setRounds((prev) => [r, ...prev.filter((x) => x.id !== r.id)].slice(0, limit)),
    [limit],
  );
  return { rounds, loading, push };
}

/**
 * Ronda interactiva abierta de una visita anterior (el servidor no devuelve su vista):
 * se ofrece cerrarla (liquidación del servidor) antes de apostar de nuevo.
 */
export function useOpenRound(props: StudioGameProps, session: StudioSession, enabled: boolean) {
  const [open, setOpen] = useState<PublicRound | null>(null);
  const [closing, setClosing] = useState(false);
  const { mode, session: sid, gameId } = props;
  const { ready } = session;

  useEffect(() => {
    if (!enabled || !ready) return;
    let alive = true;
    studioApi
      .active({ gameId, mode, session: sid })
      .then((r) => alive && setOpen(r.round))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, ready, gameId, mode, sid]);

  const close = useCallback(async () => {
    if (!open) return;
    setClosing(true);
    try {
      const r = await studioApi.settle({ gameId, mode, session: sid }, open.id);
      session.applyBalance(r.balance);
      setOpen(null);
      if (r.balance === null) await session.refresh();
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setClosing(false);
    }
  }, [open, gameId, mode, sid, session]);

  return { open, closing, close, clear: () => setOpen(null) };
}

export function OpenRoundNotice({ state }: { state: ReturnType<typeof useOpenRound> }) {
  if (!state.open) return null;
  return (
    <div role="alert" className="rounded-lg border border-amber-500/40 bg-amber-950/50 p-3 text-sm text-amber-200">
      <p>Tienes una ronda abierta de una visita anterior. Ciérrala para continuar (se liquida con el resultado actual del servidor).</p>
      <button type="button" disabled={state.closing} onClick={state.close} className="mt-2 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-950 disabled:opacity-50">
        {state.closing ? 'Cerrando…' : 'Cerrar ronda abierta'}
      </button>
    </div>
  );
}

/** Ref con el último valor, útil para bucles de autoplay. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ───────────── UI compartida ───────────── */

export function GameShell({ title, session, children, aside }: { title: string; session: StudioSession; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className="mx-auto w-full max-w-6xl rounded-2xl border border-white/10 bg-slate-950 p-3 text-slate-100 shadow-xl sm:p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold tracking-wide sm:text-xl">{title}</h2>
        <div className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm" aria-live="polite" aria-label="Saldo">
          <span className="text-slate-400">Saldo: </span>
          <span className="font-mono font-semibold text-emerald-400">{session.ready ? formatMinor(session.balance, session.currency) : 'Cargando…'}</span>
        </div>
      </header>
      {session.error && (
        <div role="alert" className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-sm text-rose-200">
          <span>{session.error}</span>
          <button type="button" onClick={() => session.setError(null)} className="shrink-0 text-xs underline" aria-label="Cerrar aviso de error">
            Cerrar
          </button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="order-2 space-y-3 lg:order-1">{aside}</div>
        <div className="order-1 min-w-0 lg:order-2">{children}</div>
      </div>
    </section>
  );
}

export function BetInput({ value, onChange, disabled, label = 'Apuesta' }: { value: string; onChange: (v: string) => void; disabled?: boolean; label?: string }) {
  const cur = operatorCurrency();
  const raw = toMinorUnits(value);
  const parsed = raw !== null && raw > BigInt(0) ? raw : null;
  const bounds = betBounds();
  const valid = parsed !== null && withinBetBounds(parsed);
  const scale = (f: number) => {
    if (parsed === null) return;
    const n = (parsed * BigInt(Math.round(f * 100))) / BigInt(100);
    const clamped = bounds.max !== null && n > bounds.max ? bounds.max : bounds.min !== null && n < bounds.min ? bounds.min : n;
    onChange(fromMinorInput(clamped > BigInt(1) ? clamped : BigInt(1)));
  };
  const quick = betSteps(cur).slice(0, 5);
  return (
    <div>
      <label htmlFor="bet-amount" className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
        {label}
      </label>
      <div className="flex items-stretch gap-1">
        <input
          id="bet-amount"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!valid}
          aria-describedby="bet-amount-hint"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-400 disabled:opacity-50"
        />
        <button type="button" disabled={disabled} onClick={() => scale(0.5)} aria-label="Reducir apuesta a la mitad" className="rounded-lg bg-slate-800 px-3 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50">
          ½
        </button>
        <button type="button" disabled={disabled} onClick={() => scale(2)} aria-label="Duplicar apuesta" className="rounded-lg bg-slate-800 px-3 text-xs font-semibold hover:bg-slate-700 disabled:opacity-50">
          2×
        </button>
      </div>
      <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Montos rápidos">
        {quick.map((q) => (
          <button key={q} type="button" disabled={disabled} onClick={() => onChange(fromMinorInput(BigInt(q)))} className="rounded-md bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            {formatMinor(q)}
          </button>
        ))}
      </div>
      <p id="bet-amount-hint" className={`mt-1 text-[11px] ${valid ? 'text-slate-500' : 'text-rose-300'}`}>
        {valid || parsed === null
          ? parsed === null
            ? 'Escribe un monto válido.'
            : bounds.min !== null || bounds.max !== null
              ? `Apuesta${bounds.min !== null ? ` mínima ${formatMinor(bounds.min)}` : ''}${bounds.max !== null ? `${bounds.min !== null ? ',' : ''} máxima ${formatMinor(bounds.max)}` : ''}.`
              : ''
          : `Fuera de los límites${bounds.min !== null ? `: mínima ${formatMinor(bounds.min)}` : ''}${bounds.max !== null ? `, máxima ${formatMinor(bounds.max)}` : ''}.`}
      </p>
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  const dec = (step.toString().split('.')[1] ?? '').length;
  const fix = (n: number) => Number(n.toFixed(dec));
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400">
        {label}
      </label>
      <div className="flex items-stretch gap-1">
        <button type="button" disabled={disabled} onClick={() => onChange(clamp(fix(value - step)))} aria-label={`Disminuir ${label}`} className="rounded-lg bg-slate-800 px-2 hover:bg-slate-700 disabled:opacity-50">
          <Minus size={14} />
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            type="number"
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(Number(e.target.value))}
            onBlur={() => onChange(clamp(fix(value)))}
            className="w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-400 disabled:opacity-50"
          />
          {suffix && <span className="pointer-events-none absolute right-8 top-1/2 -translate-y-1/2 text-xs text-slate-500">{suffix}</span>}
        </div>
        <button type="button" disabled={disabled} onClick={() => onChange(clamp(fix(value + step)))} aria-label={`Aumentar ${label}`} className="rounded-lg bg-slate-800 px-2 hover:bg-slate-700 disabled:opacity-50">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({ label, value, options, onChange, disabled }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-slate-400">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${o.value === value ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-200 hover:bg-slate-700'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TurboToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label="Modo turbo"
      onClick={() => onChange(!value)}
      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm ${value ? 'border-amber-400 bg-amber-400/10 text-amber-300' : 'border-white/10 bg-slate-900 text-slate-300'}`}
    >
      <span className="flex items-center gap-2">
        <Zap size={14} /> Modo turbo
      </span>
      <span className="font-mono text-xs">{value ? 'ON' : 'OFF'}</span>
    </button>
  );
}

export function PrimaryButton({ children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'go' | 'stop' }) {
  const { tone = 'go', className = '', ...rest } = p;
  const color = tone === 'go' ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400' : 'bg-amber-500 text-slate-950 hover:bg-amber-400';
  return (
    <button type="button" {...rest} className={`w-full rounded-xl px-4 py-3 text-base font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${color} ${className}`}>
      {children}
    </button>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'win' | 'lose' }) {
  return (
    <div className="rounded-lg bg-slate-900 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`font-mono text-base font-semibold ${tone === 'win' ? 'text-emerald-400' : tone === 'lose' ? 'text-rose-400' : ''}`}>{value}</div>
    </div>
  );
}

/** Fichas con el multiplicador de las últimas rondas. */
export function HistoryStrip({ rounds, loading }: { rounds: PublicRound[]; loading?: boolean }) {
  if (loading) return <p className="text-xs text-slate-500">Cargando historial…</p>;
  if (rounds.length === 0) return <p className="text-xs text-slate-500">Aún no hay rondas. ¡Haz tu primera apuesta!</p>;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Historial de rondas">
      {rounds.slice(0, 20).map((r) => {
        const win = BigInt(r.win) > BigInt(0);
        return (
          <li key={r.id} title={`Apuesta ${formatMinor(r.bet)} · Ganancia ${formatMinor(r.win)}`} className={`rounded-md px-2 py-1 font-mono text-xs font-semibold ${win ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
            {Number(r.multiplier).toFixed(2)}×
          </li>
        );
      })}
    </ul>
  );
}

export function ResultBanner({ win, text }: { win: boolean | null; text: string }) {
  if (win === null) return <div className="h-6" aria-hidden />;
  return (
    <div role="status" className={`rounded-lg px-3 py-1.5 text-center text-sm font-semibold ${win ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
      {text}
    </div>
  );
}

/** Respeta prefers-reduced-motion: los juegos acortan sus animaciones. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
