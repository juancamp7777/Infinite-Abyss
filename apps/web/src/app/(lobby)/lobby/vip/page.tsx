'use client';
import { useState } from 'react';
import { DailyWheel } from '@/components/lobby/DailyWheel';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { MissionsPanel } from '@/components/lobby/MissionsPanel';
import { ErrorState, Skeleton } from '@/components/lobby/States';
import { VipProgressBar } from '@/components/lobby/VipProgressBar';
import { api, errorMessage } from '@/lib/lobby/api';
import { DEFAULT_CURRENCY } from '@/lib/lobby/config';
import { useAsync } from '@/lib/lobby/hooks';
import { benefitsText, formatInt, formatMoney, rewardLabel } from '@/lib/lobby/format';

export default function VipPage() {
  const { vip, refresh, balance } = useLobby();
  const missions = useAsync(() => api.missions().then((r) => r.missions), 'vip-missions');
  const streak = useAsync(() => api.streak(), 'streak');
  const wheel = useAsync(() => api.wheel(), 'wheel');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cur = balance?.currency ?? DEFAULT_CURRENCY;
  const claim = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api.claimRakeback(); setMsg({ ok: true, text: `Rakeback reclamado: ${formatMoney(r.amount, r.currency)}` }); refresh(); }
    catch (e) { setMsg({ ok: false, text: errorMessage(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-extrabold">VIP y recompensas</h1>
      <section aria-label="Nivel VIP" className="nf-panel space-y-3">
        {!vip ? <Skeleton className="h-24" /> : (
          <>
            <VipProgressBar vip={vip} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div><h2 className="font-bold">Nivel actual: {vip.level.name}</h2><p className="text-sm opacity-80">Rakeback {(vip.level.rakebackBps / 100).toFixed(2)}%</p>{benefitsText(vip.level.benefits) && <p className="text-sm opacity-80">{benefitsText(vip.level.benefits)}</p>}</div>
              {vip.next && <div><h2 className="font-bold">Siguiente: {vip.next.name}</h2><p className="text-sm opacity-80">Requiere {formatInt(vip.next.pointsRequired)} pts</p>{benefitsText(vip.next.benefits) && <p className="text-sm opacity-80">{benefitsText(vip.next.benefits)}</p>}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
              <p className="text-sm">Rakeback pendiente: <b>{formatMoney(vip.rakeback.pending, cur)}</b></p>
              <button type="button" className="nf-btn nf-btn-primary" disabled={!vip.rakeback.claimable || busy} onClick={claim}>{busy ? '…' : vip.rakeback.claimedThisPeriod ? 'Ya reclamado este periodo' : 'Reclamar rakeback'}</button>
              {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? '' : 'text-red-400'}`}>{msg.text}</p>}
            </div>
          </>
        )}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Misiones" className="space-y-2">
          <h2 className="text-lg font-bold">Misiones</h2>
          <MissionsPanel missions={missions.data} loading={missions.loading} error={missions.error} onRetry={missions.reload} onChange={() => { missions.reload(); refresh(); }} />
        </section>
        <section aria-label="Rueda diaria" className="space-y-2">
          <h2 className="text-lg font-bold">Rueda diaria</h2>
          {wheel.error ? <ErrorState message={wheel.error} onRetry={wheel.reload} /> : wheel.data ? <DailyWheel status={wheel.data} onSpun={() => { wheel.reload(); refresh(); }} /> : <Skeleton className="h-72" />}
        </section>
      </div>
      <section aria-label="Racha de login" className="space-y-2">
        <h2 className="text-lg font-bold">Racha de login</h2>
        {streak.error ? <ErrorState message={streak.error} onRetry={streak.reload} /> : !streak.data ? <Skeleton className="h-20" /> : (
          <div className="nf-panel space-y-2">
            <p className="text-sm">Racha actual: <b>{streak.data.current}</b> días · Mejor: <b>{streak.data.best}</b>{streak.data.loggedToday && ' · ¡Hoy ya cuenta!'}</p>
            <ul className="flex flex-wrap gap-2">{streak.data.rewards.map((r) => (
              <li key={r.day} className={`rounded-lg border px-2 py-1 text-xs ${streak.data!.current >= r.day ? 'border-[var(--nf-accent)]' : 'border-white/10 opacity-70'}`}>Día {r.day}: {rewardLabel(r.reward, cur)}</li>))}</ul>
          </div>
        )}
      </section>
    </div>
  );
}
