'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Coins, ShieldCheck, Swords, Trophy, Users } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { ErrorState, Skeleton } from '@/components/lobby/States';
import { LeviathanArt } from '@/components/lobby/LeviathanArt';
import { useAsync } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';
import { useCasino } from '@/hooks/useCasino';
import { hhmm, lev, odds, prizePool, SPORT_ICON, type LevGame } from '@/lib/leviathan';

/** Cuenta regresiva corta. */
function left(ms: number) {
  if (ms <= 0) return '0:00';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m}:${String(s).padStart(2, '0')}`;
}
const dayTime = (iso: string) => new Date(iso).toLocaleString('es-CO', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** Leviathan: concursos de fichas sobre partidos reales. Portada, concursos, partidos que vienen y salas de amigos. */
export default function LeviathanLobby() {
  const { t } = useT();
  const router = useRouter();
  const { tryMinor, currency } = useCasino();
  const games = useAsync(() => lev.lobby(), 'lev-lobby');
  const mine = useAsync(() => lev.mine().catch(() => []), 'lev-mine');
  const upcoming = useAsync(() => lev.upcoming().catch(() => []), 'lev-upcoming');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState({ title: '', entry: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      router.push(`/lobby/leviathan/${await fn()}`);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t('No se pudo completar'));
    } finally {
      setBusy(false);
    }
  };
  const active = (mine.data ?? []).filter((g) => g.status === 'OPEN' || g.status === 'RUNNING');
  const featured = games.data?.[0];

  return (
    <div className="space-y-8">
      {/* Portada */}
      <section className="relative overflow-hidden rounded-3xl border border-[var(--nf-primary)]/30 p-6 sm:p-8"
        style={{ background: 'radial-gradient(90% 120% at 0% 0%, rgba(14,165,233,.35), transparent 60%), radial-gradient(80% 120% at 100% 100%, rgba(234,179,8,.25), transparent 60%), linear-gradient(160deg,#05132b,#020817)' }}>
        <LeviathanArt className="pointer-events-none absolute -right-10 bottom-0 h-48 w-auto opacity-35 sm:right-4 sm:h-72 sm:opacity-90" />
        <div className="relative max-w-xl space-y-3">
          <p className="text-xs font-bold uppercase tracking-[.35em] text-[var(--nf-primary)]">{t('Concursos deportivos')}</p>
          <h1 className="text-4xl font-black leading-none sm:text-5xl" style={{ background: 'linear-gradient(90deg,#fde68a,#f5b83d 45%,#38bdf8)', WebkitBackgroundClip: 'text', color: 'transparent' }}>LEVIATHAN</h1>
          <p className="text-base opacity-90 sm:text-lg">{t('Apuesta tus fichas en partidos reales y sube al podio. Los 3 mejores se llevan el pozo.')}</p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs font-semibold">
            <span className="rounded-full bg-white/10 px-3 py-1">⚽ {t('Partidos reales')}</span>
            <span className="rounded-full bg-white/10 px-3 py-1">🏆 60 · 25 · 15 %</span>
            <span className="rounded-full bg-white/10 px-3 py-1">🛡️ {t('Si no se llena, te devolvemos la entrada')}</span>
          </div>
          {featured && (
            <Link href={`/lobby/leviathan/${featured.id}`} className="mt-2 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-extrabold text-black shadow-lg transition hover:scale-105"
              style={{ background: 'linear-gradient(90deg,var(--nf-primary),var(--nf-accent))' }}>
              <Swords aria-hidden className="h-4 w-4" /> {featured.status === 'OPEN' ? `${t('Entrar')} · ${t('cierra en')} ${left(Date.parse(featured.entriesCloseAt) - now)}` : t('Ver el concurso en juego')}
            </Link>
          )}
        </div>
      </section>

      {/* Cómo se juega */}
      <section aria-label={t('Cómo se juega')} className="grid gap-3 sm:grid-cols-4">
        {[
          { icon: Users, title: t('Inscríbete'), text: t('Pagas la entrada una sola vez.') },
          { icon: Coins, title: t('Recibe 1.000 fichas'), text: t('Todos arrancan igual.') },
          { icon: Swords, title: t('Apuesta en partidos'), text: t('Entre 3 y 15 apuestas antes de cada pitazo.') },
          { icon: Trophy, title: t('Sube al podio'), text: t('Más fichas al final = premio en efectivo.') },
        ].map(({ icon: I, title, text }, i) => (
          <div key={title} className="nf-panel flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,var(--nf-primary),var(--nf-accent))' }}><I aria-hidden className="h-5 w-5" /></span>
            <div><p className="text-sm font-bold">{i + 1}. {title}</p><p className="text-xs opacity-70">{text}</p></div>
          </div>
        ))}
      </section>

      {!!active.length && (
        <section className="space-y-3">
          <h2 className="text-xl font-extrabold">{t('Mis concursos')}</h2>
          <ul className="grid gap-3 md:grid-cols-2">{active.map((g) => <GameCard key={g.id} g={g} chips={g.me.chips} now={now} />)}</ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold">{t('Concursos abiertos')}</h2>
        {games.error ? <ErrorState message={games.error} onRetry={games.reload} />
          : games.loading ? <div role="status" aria-label={t('Cargando')} className="grid gap-3 md:grid-cols-2"><Skeleton className="h-36" /><Skeleton className="h-36" /></div>
          : games.data?.length ? <ul className="grid gap-3 md:grid-cols-2">{games.data.map((g) => <GameCard key={g.id} g={g} now={now} />)}</ul>
          : <div className="nf-panel flex flex-wrap items-center gap-4" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,.12), rgba(234,179,8,.08))' }}>
              <span className="text-4xl" aria-hidden>⏳</span>
              <div className="min-w-0 flex-1"><p className="font-bold">{t('El próximo concurso abre muy pronto')}</p><p className="text-sm opacity-70">{t('Mira los partidos que vienen abajo, o arma una sala con tus amigos ahora mismo.')}</p></div>
            </div>}
      </section>

      {/* Partidos que vienen */}
      {!!upcoming.data?.length && (
        <section className="space-y-3">
          <h2 className="text-xl font-extrabold">{upcoming.data.some((e) => e.real) ? t('Partidos reales que vienen') : t('Partidos que vienen')}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.data.map((e) => (
              <li key={e.id} className="nf-panel min-w-0 space-y-2">
                <div className="flex items-center justify-between text-xs opacity-70"><span className="truncate">{SPORT_ICON[e.sport] ?? '🏟️'} {e.league}</span><span className="shrink-0 capitalize">{dayTime(e.startsAt)}</span></div>
                <p className="font-bold">{e.home} <span className="opacity-50">vs</span> {e.away}</p>
                <div className="flex gap-1.5">
                  {e.odds.map((o) => (
                    <span key={o.key} className="flex flex-1 items-center justify-between rounded-lg bg-black/40 px-2 py-1 text-xs">
                      <span className="opacity-70">{o.key === '1' ? '1' : o.key === 'X' ? 'X' : '2'}</span><b className="font-mono">{odds(o.oddsE2)}</b>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Salas de amigos */}
      <section className="space-y-3">
        <h2 className="text-xl font-extrabold">{t('Juega con tus amigos')}</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <form className="nf-panel space-y-2" onSubmit={(e) => { e.preventDefault(); void run(async () => (await lev.joinCode(code.trim().toUpperCase())).game.id); }}>
            <h3 className="font-bold">{t('Entrar con código')}</h3>
            <input aria-label={t('Código de sala')} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-center font-mono text-xl uppercase tracking-[.4em]" maxLength={5} placeholder="ABC23" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" disabled={busy || code.trim().length !== 5} className="nf-btn w-full justify-center disabled:opacity-50">{t('Entrar a la sala')}</button>
          </form>
          <form className="nf-panel space-y-2" onSubmit={(e) => {
            e.preventDefault();
            const entry = room.entry.trim() ? tryMinor(room.entry) : BigInt(0);
            if (entry === null) return setMsg(t('Revisa el monto de la entrada'));
            void run(async () => (await lev.createFriends({ title: room.title.trim() || t('Sala de amigos'), entry: entry.toString(), maxPlayers: 20 })).id);
          }}>
            <h3 className="font-bold">{t('Crear sala privada')}</h3>
            <input aria-label={t('Nombre de la sala')} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2" maxLength={80} placeholder={t('Los del barrio')} value={room.title} onChange={(e) => setRoom({ ...room, title: e.target.value })} />
            <input aria-label={t('Entrada')} inputMode="decimal" className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2" placeholder={t(`Entrada en ${currency} (vacío = gratis)`)} value={room.entry} onChange={(e) => setRoom({ ...room, entry: e.target.value })} />
            <button type="submit" disabled={busy} className="nf-btn w-full justify-center font-bold disabled:opacity-50" style={{ background: 'var(--nf-primary)', color: '#000' }}>{t('Crear y compartir código')}</button>
          </form>
        </div>
        {msg && <p role="alert" className="text-center text-sm text-red-300">{msg}</p>}
        <p className="flex items-center justify-center gap-1.5 text-xs opacity-60"><ShieldCheck aria-hidden className="h-4 w-4" />{t('Compites contra otros jugadores, no contra el casino.')}</p>
      </section>
    </div>
  );
}

function GameCard({ g, chips, now }: { g: LevGame; chips?: string; now: number }) {
  const { t } = useT();
  const open = g.status === 'OPEN';
  const fill = Math.min(100, Math.round((g.players / Math.max(1, g.maxPlayers)) * 100));
  return (
    <li className="min-w-0">
      <Link href={`/lobby/leviathan/${g.id}`} className="group relative block overflow-hidden rounded-2xl border border-white/10 p-4 transition hover:border-[var(--nf-primary)]"
        style={{ background: 'radial-gradient(120% 140% at 100% 0%, rgba(234,179,8,.16), transparent 55%), radial-gradient(120% 140% at 0% 100%, rgba(14,165,233,.18), transparent 55%), var(--nf-surface)' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-widest" style={{ color: open ? 'var(--nf-accent)' : 'var(--nf-primary)' }}>{open ? t('Inscripciones abiertas') : t('En juego')}</p>
            <p className="truncate text-lg font-extrabold">{g.title}</p>
          </div>
          <span className="shrink-0 rounded-lg bg-black/40 px-2.5 py-1 font-mono text-sm font-bold tabular-nums">{open ? left(Date.parse(g.entriesCloseAt) - now) : `${t('Termina')} ${hhmm(g.endsAt)}`}</span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-black/30 p-2"><div className="opacity-60">{t('Entrada')}</div><b className="text-sm">{BigInt(g.entry) > BigInt(0) ? formatMoney(g.entry, g.currency) : t('Gratis')}</b></div>
          <div className="rounded-lg bg-black/30 p-2"><div className="opacity-60">{t('Premios')}</div><b className="text-sm">{g.players ? formatMoney(prizePool(g).toString(), g.currency) : t('Crece')}</b></div>
          <div className="rounded-lg bg-black/30 p-2"><div className="opacity-60">{chips !== undefined ? t('Mis fichas') : t('Partidos')}</div><b className="text-sm">{chips ?? g.eventCount ?? '—'}</b></div>
        </div>
        {!!g.events?.length && <p className="mt-2 truncate text-xs opacity-70">{g.events.map((e) => `${e.home} vs ${e.away}`).join(' · ')}</p>}
        <div className="mt-3 flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10"><span className="block h-full rounded-full" style={{ width: `${Math.max(4, fill)}%`, background: 'linear-gradient(90deg,var(--nf-primary),var(--nf-accent))' }} /></span>
          <span className="text-xs opacity-70">{g.players}/{g.maxPlayers}</span>
          <span className="rounded-lg px-3 py-1 text-xs font-extrabold text-black transition group-hover:scale-105" style={{ background: 'linear-gradient(90deg,var(--nf-primary),var(--nf-accent))' }}>{open ? t('Entrar') : t('Ver')}</span>
        </div>
      </Link>
    </li>
  );
}
