'use client';
import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from 'react';
import type { Jackpot } from '@/lib/lobby/types';
import { formatMoney } from '@/lib/lobby/format';
import { parseMinor } from '@/lib/money';
import { Skeleton } from './States';

/** Número con animación de conteo hacia el valor objetivo (bigint; respeta prefers-reduced-motion). */
function Counting({ minor, currency }: { minor: string; currency: string }) {
  const target = parseMinor(minor);
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { from.current = target; setShown(target); return; }
    const start = performance.now(); const a = from.current; let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      // El progreso (0..1) es un factor de animación, no un monto: se aplica en bigint por milésimas.
      const permille = BigInt(Math.round((1 - Math.pow(1 - k, 3)) * 1000));
      const v = a + ((target - a) * permille) / BigInt(1000);
      from.current = v; setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <span className="tabular-nums">{formatMoney(shown, currency)}</span>;
}

const LABEL: Record<string, string> = { mini: 'Mini', minor: 'Minor', major: 'Major', mega: 'Mega', grand: 'Grand' };

export function JackpotTicker({ jackpots, loading, connected }: { jackpots: Jackpot[] | null; loading?: boolean; connected?: boolean }) {
  const { t } = useT();
  if (loading && !jackpots) return <div role="status" aria-label={t("Cargando jackpots")} className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>;
  const levels = (jackpots ?? []).flatMap((j) => j.levels.map((l) => ({ ...l, cur: j.currency, name: j.name, id: j.id })));
  if (levels.length === 0) return null;
  return (
    <section aria-label={t("Jackpots progresivos")} className="space-y-1">
      <div className="flex items-center gap-2 text-xs opacity-70"><span aria-hidden className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-zinc-500'}`} />{connected ? 'En vivo' : 'Sin conexión en vivo'}</div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {levels.map((l) => (
          <li key={`${l.id}-${l.key}`} className="nf-panel nf-jackpot">
            <p className="text-xs uppercase tracking-wider opacity-70">{LABEL[l.key] ?? l.key}</p>
            <p className="text-lg font-extrabold" style={{ color: 'var(--nf-accent)' }}><Counting minor={l.amount} currency={l.cur} /></p>
          </li>
        ))}
      </ul>
    </section>
  );
}
