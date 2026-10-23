'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Copy } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ErrorState, Skeleton } from '@/components/lobby/States';
import { formatMoney } from '@/lib/lobby/format';
import { hhmm, lev, odds, prizePool, SPORT_ICON, STATUS_LABEL, type LevDetail, type LevSelection } from '@/lib/leviathan';

const MARKET: Record<string, string> = { MATCH_RESULT: 'Ganador', TOTAL: 'Total' };
const BET_STATUS: Record<string, string> = { OPEN: 'En juego', WON: 'Ganada', LOST: 'Perdida', VOID: 'Anulada' };

/** Concurso de Leviathan: inscripción, partidos con cuotas, boleto, tabla y mis apuestas (se actualiza solo). */
export default function LeviathanGame() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const { reloadMe } = useAuth();
  const [d, setD] = useState<LevDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'bet' | 'rank' | 'mine'>('bet');
  const [slip, setSlip] = useState<{ sel: LevSelection; event: string } | null>(null);
  const [stake, setStake] = useState('100');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await lev.detail(id));
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('No se pudo cargar el concurso'));
    }
  }, [id, t]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (err && !d) return <ErrorState message={err} onRetry={() => void load()} />;
  if (!d) return <div role="status" aria-label={t('Cargando')} className="space-y-2"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  const g = d.game;
  const running = g.status === 'RUNNING';
  const chips = d.me ? BigInt(d.me.chips) : BigInt(0);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
      void reloadMe();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setMsg({ ok: false, text: t('La cuota cambió. Revisa la nueva y confirma de nuevo.') });
        await load();
      } else setMsg({ ok: false, text: e instanceof ApiError ? e.message : t('No se pudo completar') });
    } finally {
      setBusy(false);
    }
  };
  const stakeN = /^\d+$/.test(stake) ? BigInt(stake) : BigInt(0);

  return (
    <div className="space-y-4">
      <Link href="/lobby/leviathan" className="inline-flex items-center gap-1 text-sm opacity-80 hover:opacity-100"><ArrowLeft aria-hidden className="h-4 w-4" />Leviathan</Link>

      <header className="nf-panel space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-extrabold">{g.title}</h1>
          <span className="nf-badge" style={{ background: running ? 'var(--nf-primary)' : 'var(--nf-accent)' }}>{t(STATUS_LABEL[g.status])}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Stat label={t('Premios')} value={formatMoney(prizePool(g).toString(), g.currency)} />
          <Stat label={t('Jugadores')} value={`${g.players}/${g.maxPlayers}`} />
          <Stat label={g.status === 'OPEN' ? t('Empieza') : t('Termina')} value={hhmm(g.status === 'OPEN' ? g.entriesCloseAt : g.endsAt)} />
          {d.me ? <Stat label={t('Mis fichas')} value={`${d.me.chips} · ${d.me.bets}/${g.maxBets} ${t('apuestas')}`} /> : <Stat label={t('Entrada')} value={BigInt(g.entry) > BigInt(0) ? formatMoney(g.entry, g.currency) : t('Gratis')} />}
        </div>
        {g.roomCode && (
          <button type="button" className="nf-btn" onClick={() => { void navigator.clipboard?.writeText(g.roomCode!); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
            <Copy aria-hidden className="h-4 w-4" /> {t('Código de sala')}: <b className="font-mono tracking-widest">{g.roomCode}</b> {copied && `· ${t('Copiado')}`}
          </button>
        )}
        {d.me && <p className="text-xs opacity-70">{t('Para cobrar premio necesitas hacer entre')} {g.minBets} {t('y')} {g.maxBets} {t('apuestas')}.</p>}
        {!d.me && g.status === 'OPEN' && (
          <button type="button" disabled={busy} className="nf-btn w-full justify-center font-bold disabled:opacity-50" style={{ background: 'var(--nf-primary)', color: '#000' }}
            onClick={() => void act(() => lev.join(g.id), t('¡Estás dentro! Tienes 1.000 fichas.'))}>
            {t('Inscribirme')} {BigInt(g.entry) > BigInt(0) ? `· ${formatMoney(g.entry, g.currency)}` : `· ${t('Gratis')}`}
          </button>
        )}
        {d.me && g.status === 'OPEN' && <p className="text-sm">{t('Ya estás inscrito. Las apuestas se abren cuando empiece el concurso.')}</p>}
        {g.status === 'SETTLED' && d.me && <p className="text-sm font-bold">{t('Terminaste en el puesto')} {d.me.rank}{d.me.prize && BigInt(d.me.prize) > BigInt(0) ? ` · ${t('Ganaste')} ${formatMoney(d.me.prize, g.currency)}` : ''}</p>}
        {g.status === 'CANCELLED' && <p className="text-sm">{t('Este concurso se canceló y la entrada se devolvió a tu saldo.')}</p>}
      </header>

      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-center text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</p>}

      <div role="tablist" className="flex gap-2">
        {([['bet', 'Partidos'], ['rank', 'Ranking'], ['mine', 'Mis apuestas']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="nf-btn flex-1 justify-center" style={tab === k ? { background: 'var(--nf-primary)', color: '#000' } : undefined}>{t(l)}</button>
        ))}
      </div>

      {tab === 'bet' && (
        <ul className="space-y-3">
          {d.events.map((e) => {
            const open = running && !!d.me && e.status === 'SCHEDULED' && new Date(e.startsAt) > new Date();
            return (
              <li key={e.id} className="nf-panel space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-bold">{SPORT_ICON[e.sport] ?? '🏟️'} {e.home} <span className="opacity-60">vs</span> {e.away}</span>
                  <span className="opacity-70">{e.status === 'FINISHED' ? `${t('Final')} ${e.homeScore}-${e.awayScore}` : e.status === 'LIVE' ? t('En vivo') : hhmm(e.startsAt)} · {e.league}</span>
                </div>
                {(['MATCH_RESULT', 'TOTAL'] as const).map((m) => (
                  <div key={m} className="flex flex-wrap items-center gap-2">
                    <span className="w-14 text-xs opacity-60">{t(MARKET[m])}</span>
                    {e.selections.filter((s) => s.market === m).map((s) => (
                      <button key={s.id} type="button" disabled={!open} onClick={() => { setSlip({ sel: s, event: `${e.home} vs ${e.away}` }); setMsg(null); }}
                        className={`nf-btn flex-1 justify-between disabled:cursor-not-allowed ${s.result === 'WON' ? 'ring-1 ring-emerald-400' : ''} ${!open && s.result !== 'WON' ? 'opacity-50' : ''}`}>
                        <span className="truncate text-xs">{s.label}</span><b className="font-mono">{odds(s.oddsE2)}</b>
                      </button>
                    ))}
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {tab === 'rank' && (
        <ol className="nf-panel divide-y divide-white/5">
          {d.leaderboard.map((r) => (
            <li key={r.position} className={`flex items-center justify-between py-2 text-sm ${r.isMe ? 'font-bold' : ''}`}>
              <span>{r.position}. {r.name}{r.isMe && ` (${t('tú')})`}</span>
              <span className="font-mono">{r.chips} {t('fichas')}{r.prize && BigInt(r.prize) > BigInt(0) ? ` · ${formatMoney(r.prize, g.currency)}` : ''}</span>
            </li>
          ))}
          {!d.leaderboard.length && <li className="py-2 text-sm opacity-70">{t('Todavía no hay jugadores.')}</li>}
        </ol>
      )}

      {tab === 'mine' && (
        <ul className="nf-panel divide-y divide-white/5">
          {d.myBets.map((b) => {
            const sel = d.events.flatMap((e) => e.selections.map((s) => ({ s, e }))).find((x) => x.s.id === b.selectionId);
            return (
              <li key={b.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 truncate">{sel ? `${sel.s.label} · ${sel.e.home} vs ${sel.e.away}` : b.selectionId}</span>
                <span className="shrink-0 font-mono">{b.stake} @ {odds(b.oddsE2)} → {b.returnChips} · {t(BET_STATUS[b.status] ?? b.status)}</span>
              </li>
            );
          })}
          {!d.myBets.length && <li className="py-2 text-sm opacity-70">{t('Aún no tienes apuestas en este concurso.')}</li>}
        </ul>
      )}

      {slip && (
        <div role="dialog" aria-label={t('Boleto de apuesta')} className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md space-y-3 rounded-2xl border border-white/15 bg-[#0b1830] p-4 shadow-2xl lg:bottom-6">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0"><p className="truncate text-xs opacity-70">{slip.event}</p><p className="font-bold">{slip.sel.label} · <span className="font-mono">{odds(slip.sel.oddsE2)}</span></p></div>
            <button type="button" className="opacity-60 hover:opacity-100" aria-label={t('Cerrar')} onClick={() => setSlip(null)}>✕</button>
          </div>
          <label className="block text-xs opacity-70" htmlFor="lev-stake">{t('Fichas a apostar')} ({t('tienes')} {chips.toString()})</label>
          <input id="lev-stake" inputMode="numeric" className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono" value={stake} onChange={(e) => setStake(e.target.value.replace(/\D/g, ''))} />
          <div className="flex gap-2">{['50', '100', '250'].map((v) => <button key={v} type="button" className="nf-btn flex-1 justify-center" onClick={() => setStake(v)}>{v}</button>)}<button type="button" className="nf-btn flex-1 justify-center" onClick={() => setStake(chips.toString())}>{t('Todo')}</button></div>
          <p className="text-sm">{t('Si aciertas recibes')} <b className="font-mono">{((stakeN * BigInt(slip.sel.oddsE2) * BigInt(2) + BigInt(100)) / BigInt(200)).toString()}</b> {t('fichas')}</p>
          <button type="button" disabled={busy || stakeN <= BigInt(0) || stakeN > chips} className="nf-btn w-full justify-center font-bold disabled:opacity-50" style={{ background: 'var(--nf-primary)', color: '#000' }}
            onClick={() => void act(async () => { await lev.bet(g.id, { selectionId: slip.sel.id, stake: stakeN.toString(), oddsE2: slip.sel.oddsE2 }); setSlip(null); }, t('Apuesta registrada'))}>
            {t('Apostar')}
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-black/30 p-2"><div className="text-xs opacity-60">{label}</div><div className="font-bold">{value}</div></div>;
}
