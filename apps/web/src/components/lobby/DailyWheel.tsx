'use client';
import { useT } from "@/lib/i18n";
import { useState } from 'react';
import { api, errorMessage } from '@/lib/lobby/api';
import type { WheelStatus } from '@/lib/lobby/types';
import { rewardLabel } from '@/lib/lobby/format';

export function DailyWheel({ status, onSpun }: { status: WheelStatus; onSpun: () => void }) {
  const { t } = useT();
  const [angle, setAngle] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prizes = status.prizes; const n = Math.max(1, prizes.length); const seg = 360 / n;
  const grad = prizes.map((_, k) => `hsl(${(k * 360) / n},65%,${k % 2 ? 40 : 52}%) ${k * seg}deg ${(k + 1) * seg}deg`).join(',');
  const spin = async () => {
    setSpinning(true); setErr(null); setResult(null);
    try {
      const r = await api.spinWheel();
      const idx = Math.max(0, prizes.findIndex((p) => p.id === r.prize.id));
      setAngle((a) => a + 360 * 5 + (360 - (idx * seg + seg / 2)) - (a % 360));
      setTimeout(() => { setResult(`¡${r.prize.label}! (${rewardLabel(r.prize.reward)})`); setSpinning(false); onSpun(); }, 4200);
    } catch (e) { setErr(errorMessage(e)); setSpinning(false); }
  };
  const next = status.nextSpinAt ? new Date(status.nextSpinAt).toLocaleString('es') : null;
  return (
    <div className="nf-panel flex flex-col items-center gap-3">
      <div className="relative h-56 w-56" role="img" aria-label={`Rueda con ${n} premios`}>
        <div aria-hidden className="absolute -top-1 left-1/2 z-10 h-0 w-0 -translate-x-1/2 border-x-8 border-t-[16px] border-x-transparent" style={{ borderTopColor: 'var(--nf-accent)' }} />
        <div className="h-full w-full rounded-full border-4" style={{ background: `conic-gradient(${grad || 'var(--nf-primary) 0 360deg'})`, borderColor: 'var(--nf-accent)', transform: `rotate(${angle}deg)`, transition: spinning ? 'transform 4s cubic-bezier(.15,.7,.1,1)' : 'none' }} />
      </div>
      <ul className="flex flex-wrap justify-center gap-1 text-[11px] opacity-80">{prizes.map((p) => <li key={p.id} className="rounded bg-white/10 px-1.5 py-0.5">{p.label}</li>)}</ul>
      {!status.enabled ? <p className="text-sm opacity-70">{t("La rueda no está disponible.")}</p>
        : <button type="button" className="nf-btn nf-btn-primary" disabled={!status.canSpin || spinning} onClick={spin}>{spinning ? t("Girando…") : status.canSpin ? t("Girar rueda diaria") : t("Vuelve más tarde")}</button>}
      {!status.canSpin && next && <p className="text-xs opacity-70">Próximo giro: {next}</p>}
      <p role="status" className="min-h-5 text-sm font-semibold">{result}</p>
      {err && <p role="alert" className="text-sm text-red-400">{err}</p>}
    </div>
  );
}
