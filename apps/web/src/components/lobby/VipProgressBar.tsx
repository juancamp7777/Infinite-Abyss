import Link from 'next/link';
import { Crown } from 'lucide-react';
import type { VipState } from '@/lib/lobby/types';
import { formatInt } from '@/lib/lobby/format';

export function VipProgressBar({ vip, compact }: { vip: VipState | null; compact?: boolean }) {
  if (!vip) return null;
  const pct = Math.max(0, Math.min(100, vip.progressPct));
  return (
    <Link href="/lobby/vip" className={`flex items-center gap-2 ${compact ? 'w-40' : 'w-full'}`} aria-label={`Nivel VIP ${vip.level.name}, ${Math.round(pct)}% hacia ${vip.next?.name ?? 'el máximo'}`}>
      <Crown aria-hidden className="h-4 w-4 shrink-0" style={{ color: 'var(--nf-accent)' }} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between text-[11px] leading-tight"><span className="truncate font-semibold">{vip.level.name}</span>{vip.next && <span className="opacity-60">{vip.next.name}</span>}</div>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="nf-bar"><div style={{ width: `${pct}%` }} /></div>
        {!compact && <p className="mt-1 text-xs opacity-70">{formatInt(vip.points)} pts{vip.next ? ` · faltan ${formatInt(vip.pointsToNext)}` : ' · nivel máximo'}</p>}
      </div>
    </Link>
  );
}
