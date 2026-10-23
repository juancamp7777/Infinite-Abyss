'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { EmptyState, ErrorState, Skeleton } from '@/components/lobby/States';
import { useAsync } from '@/lib/lobby/hooks';
import { formatMoney } from '@/lib/lobby/format';
import { useCasino } from '@/hooks/useCasino';
import { hhmm, lev, prizePool, STATUS_LABEL, type LevGame } from '@/lib/leviathan';

/** Leviathan: concursos de fichas sobre partidos. Lobby, mis concursos y salas de amigos. */
export default function LeviathanLobby() {
  const { t } = useT();
  const router = useRouter();
  const { tryMinor, currency } = useCasino();
  const games = useAsync(() => lev.lobby(), 'lev-lobby');
  const mine = useAsync(() => lev.mine().catch(() => []), 'lev-mine');
  const [code, setCode] = useState('');
  const [room, setRoom] = useState({ title: '', entry: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="space-y-6">
      <header className="nf-panel space-y-2" style={{ background: 'linear-gradient(135deg, rgba(14,165,233,.18), rgba(234,179,8,.12))' }}>
        <h1 className="text-2xl font-extrabold">⚔️ Leviathan</h1>
        <p className="text-sm opacity-80">{t('Paga la entrada, recibe 1.000 fichas y apuéstalas en los partidos del concurso. Al final, los que terminen con más fichas se reparten el pozo: 60 %, 25 % y 15 %.')}</p>
        <p className="text-xs opacity-60">{t('Compites contra otros jugadores, no contra el casino. Si no se completan los jugadores, te devolvemos la entrada.')}</p>
      </header>

      {!!mine.data?.length && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">{t('Mis concursos')}</h2>
          <ul className="grid gap-3 md:grid-cols-2">{mine.data.map((g) => <GameCard key={g.id} g={g} chips={g.me.chips} />)}</ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-bold">{t('Concursos abiertos')}</h2>
        {games.error ? <ErrorState message={games.error} onRetry={games.reload} />
          : games.loading ? <div role="status" aria-label={t('Cargando')} className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
          : !games.data?.length ? <EmptyState title={t('No hay concursos abiertos ahora')} hint={t('Crea una sala con tus amigos o vuelve en un rato.')} />
          : <ul className="grid gap-3 md:grid-cols-2">{games.data.map((g) => <GameCard key={g.id} g={g} />)}</ul>}
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <form className="nf-panel space-y-2" onSubmit={(e) => { e.preventDefault(); void run(async () => (await lev.joinCode(code.trim().toUpperCase())).game.id); }}>
          <h2 className="font-bold">{t('Entrar a una sala de amigos')}</h2>
          <input aria-label={t('Código de sala')} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 font-mono uppercase tracking-[.3em]" maxLength={5} placeholder="ABC23" value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit" disabled={busy || code.trim().length !== 5} className="nf-btn w-full disabled:opacity-50">{t('Entrar con código')}</button>
        </form>
        <form className="nf-panel space-y-2" onSubmit={(e) => {
          e.preventDefault();
          const entry = room.entry.trim() ? tryMinor(room.entry) : BigInt(0);
          if (entry === null) return setMsg(t('Revisa el monto de la entrada'));
          void run(async () => (await lev.createFriends({ title: room.title.trim() || t('Sala de amigos'), entry: entry.toString(), maxPlayers: 20 })).id);
        }}>
          <h2 className="font-bold">{t('Crear sala de amigos')}</h2>
          <input aria-label={t('Nombre de la sala')} className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2" maxLength={80} placeholder={t('Los del barrio')} value={room.title} onChange={(e) => setRoom({ ...room, title: e.target.value })} />
          <input aria-label={t('Entrada')} inputMode="decimal" className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2" placeholder={t(`Entrada en ${currency} (vacío = gratis)`)} value={room.entry} onChange={(e) => setRoom({ ...room, entry: e.target.value })} />
          <button type="submit" disabled={busy} className="nf-btn w-full disabled:opacity-50">{t('Crear y compartir código')}</button>
        </form>
      </section>
      {msg && <p role="alert" className="text-center text-sm text-red-300">{msg}</p>}
    </div>
  );
}

function GameCard({ g, chips }: { g: LevGame; chips?: string }) {
  const { t } = useT();
  return (
    <li>
      <Link href={`/lobby/leviathan/${g.id}`} className="nf-panel block space-y-1 hover:border-[var(--nf-primary)]">
        <div className="flex items-center justify-between gap-2">
          <p className="font-bold">{g.title}</p>
          <span className="nf-badge" style={{ background: g.status === 'RUNNING' ? 'var(--nf-primary)' : 'var(--nf-accent)' }}>{t(STATUS_LABEL[g.status])}</span>
        </div>
        <p className="text-sm">
          {t('Entrada')}: <b>{BigInt(g.entry) > BigInt(0) ? formatMoney(g.entry, g.currency) : t('Gratis')}</b> · {t('Premios')}: <b>{formatMoney(prizePool(g).toString(), g.currency)}</b>
        </p>
        <p className="text-xs opacity-70">
          {g.players}/{g.maxPlayers} {t('jugadores')} · {g.status === 'OPEN' ? `${t('Empieza')} ${hhmm(g.entriesCloseAt)}` : `${t('Termina')} ${hhmm(g.endsAt)}`}
          {chips !== undefined && ` · ${t('Mis fichas')}: ${chips}`}
        </p>
      </Link>
    </li>
  );
}
