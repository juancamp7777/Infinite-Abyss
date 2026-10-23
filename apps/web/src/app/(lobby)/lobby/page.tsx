'use client';
import { useT } from "@/lib/i18n";
import { Fragment, type ReactNode } from 'react';
import Link from 'next/link';
import { Crown, Dices, Flame, Gamepad2, Layers, Radio, Sparkles, Trophy } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { BannerCarousel } from '@/components/lobby/BannerCarousel';
import { GameRow } from '@/components/lobby/GameRow';
import { JackpotTicker } from '@/components/lobby/JackpotTicker';
import { LastWins } from '@/components/lobby/LastWins';
import { LiveBets } from '@/components/lobby/LiveBets';
import { useLobby } from '@/components/lobby/LobbyProvider';
import { MissionsPanel } from '@/components/lobby/MissionsPanel';
import { PromoCard } from '@/components/lobby/PromoCard';
import { Skeleton } from '@/components/lobby/States';
import { api } from '@/lib/lobby/api';
import { useAsync, useGames, useJackpots } from '@/lib/lobby/hooks';
import { formatInt, formatMoney } from '@/lib/lobby/format';
import { LiveFeedProvider } from '@/lib/lobby/liveBets';
import type { ReefSection } from '@/lib/reef';

const QUICK = [
  { label: 'Originals', href: '/lobby/category/originals', icon: Gamepad2 },
  { label: 'Slots', href: '/lobby/category/slots', icon: Layers },
  { label: 'Casino en vivo', href: '/lobby/category/live', icon: Radio },
  { label: 'Mesa', href: '/lobby/category/table', icon: Dices },
  { label: 'Nuevos', href: '/lobby/category/new', icon: Sparkles },
  { label: 'Populares', href: '/lobby/category/popular', icon: Flame },
];

/** Mosaico de accesos grandes (plantillas tipo club). */
const TILES = [
  { label: 'Slots', href: '/lobby/category/slots', icon: Layers },
  { label: 'En vivo', href: '/lobby/category/live', icon: Radio },
  { label: 'Originals', href: '/lobby/category/originals', icon: Gamepad2 },
  { label: 'Top', href: '/lobby/category/popular', icon: Flame },
  { label: 'VIP', href: '/lobby/vip', icon: Crown },
];

const DEFAULT_ORDER: ReefSection[] = ['hero', 'last_wins', 'originals', 'slots', 'popular', 'new', 'live', 'live_bets', 'tournaments'];

/** Fila de proveedores (enlaza a la página de cada uno). */
function ProviderStrip() {
  const { t } = useT();
  const p = useAsync(() => api.providers().then((r) => r.items), 'providers');
  if (p.loading) return <Skeleton className="h-10" />;
  if (p.error || !p.data?.length) return null;
  return (
    <section aria-label={t("Proveedores")} className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{t("Proveedores")}</h2>
        <Link href="/lobby/category/providers" className="text-sm font-semibold text-[var(--nf-muted)] hover:text-[var(--nf-text)]">{t("Ver todos")}</Link>
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1">
        {p.data.map((x) => <li key={x.id}><Link href={`/lobby/provider/${x.id}`} className="nf-chip">{t(x.name)}</Link></li>)}
      </ul>
    </section>
  );
}

/** Columna lateral del hero: club VIP (o invitación a registrarse) y rueda diaria. */
function SideCards() {
  const { t } = useT();
  const { status } = useAuth();
  const { vip } = useLobby();
  const authed = status === 'authenticated';
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
      {authed ? (
        <PromoCard title={vip ? `VIP ${vip.level.name}` : t("Club VIP")} href="/lobby/vip" cta={t("Mis recompensas")} art="/brand/art/crown.svg" tone="gold">
          {vip ? (
            <span className="block space-y-1.5">
              <span className="block">{vip.next ? t("Faltan {n} pts para {level}", { n: formatInt(vip.pointsToNext), level: vip.next.name }) : t("Nivel máximo alcanzado")}</span>
              <span className="nf-bar block max-w-40" role="progressbar" aria-label={t("Progreso VIP")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(vip.progressPct)}>
                <span className="block h-full" style={{ width: `${Math.max(0, Math.min(100, vip.progressPct))}%`, background: 'linear-gradient(90deg,var(--nf-primary),var(--nf-accent))' }} />
              </span>
            </span>
          ) : t("Sube de nivel y gana rakeback en cada apuesta.")}
        </PromoCard>
      ) : (
        <PromoCard title={t("Únete al abismo")} href="/register" cta={t("Crear cuenta")} art="/brand/art/crown.svg" tone="gold">
          {t("Club VIP con rakeback, misiones diarias y torneos desde el primer día.")}
        </PromoCard>
      )}
      <PromoCard title={t("Rueda diaria")} href="/lobby/vip" cta={authed ? t("Girar") : t("Ver premios")} art="/brand/art/wheel.svg" tone="cyan">
        {t("Un giro gratis cada día con premios en puntos y bonos.")}
      </PromoCard>
    </div>
  );
}

function Lobby() {
  const { t } = useT();
  const { skin, site, refresh } = useLobby();
  const jp = useJackpots();
  const originals = useGames({ category: 'originals', pageSize: 16 });
  const slots = useGames({ category: 'slots', pageSize: 16 });
  const live = useGames({ category: 'live', pageSize: 16 });
  const fresh = useGames({ sort: 'new', pageSize: 16 });
  const popular = useGames({ sort: 'popular', pageSize: 16 });
  const tours = useAsync(() => api.tournaments().then((r) => r.tournaments), 'tours');
  const missions = useAsync(() => api.missions().then((r) => r.missions), 'missions');
  const activeTours = (tours.data ?? []).filter((tv) => tv.status === 'open' || tv.status === 'active' || tv.status === 'running').slice(0, 3);
  const tourList = activeTours.length ? activeTours : (tours.data ?? []).slice(0, 3);
  const icon = (I: typeof Gamepad2) => <I aria-hidden className="h-5 w-5 text-[var(--nf-primary)]" />;

  const sections: Record<ReefSection, ReactNode> = {
    hero: (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)]">
        <BannerCarousel banners={skin.banners} />
        <SideCards />
      </div>
    ),
    tiles: (
      <nav aria-label={t("Accesos rápidos")} className="nf-tiles">
        {TILES.map(({ label, href, icon: I }) => <Link key={href} href={href} className="nf-tile"><I aria-hidden />{t(label)}</Link>)}
      </nav>
    ),
    providers: <ProviderStrip />,
    last_wins: <LastWins games={[...originals.items, ...slots.items, ...popular.items, ...fresh.items, ...live.items]} />,
    originals: <GameRow title={t("Originals")} icon={icon(Gamepad2)} href="/lobby/category/originals" games={originals.items} loading={originals.loading} error={originals.error} />,
    slots: <GameRow title={t("Slots")} icon={icon(Layers)} href="/lobby/category/slots" games={slots.items} loading={slots.loading} error={slots.error} />,
    popular: <GameRow title={t("Populares")} icon={icon(Flame)} href="/lobby/category/popular" games={popular.items} loading={popular.loading} error={popular.error} />,
    new: <GameRow title={t("Nuevos lanzamientos")} icon={icon(Sparkles)} href="/lobby/category/new" games={fresh.items} loading={fresh.loading} error={fresh.error} />,
    live: live.items.length > 0 ? <GameRow title={t("Casino en vivo")} icon={icon(Radio)} href="/lobby/category/live" games={live.items} loading={live.loading} error={live.error} /> : null,
    live_bets: <LiveBets />,
    tournaments: (
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label={t("Torneos activos")} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-bold">{icon(Trophy)}Torneos</h2>
            <Link href="/lobby/tournaments" className="text-sm font-semibold text-[var(--nf-muted)] hover:text-[var(--nf-text)]">{t("Ver todos")}</Link>
          </div>
          {tours.loading ? <Skeleton className="h-20" /> : tours.error ? <p role="alert" className="text-sm text-[var(--nf-muted)]">{t("No se pudieron cargar los torneos.")}</p>
            : tourList.length === 0 ? <p className="nf-panel text-sm text-[var(--nf-muted)]">{t("No hay torneos por ahora.")}</p>
            : <ul className="space-y-2">{tourList.map((tv) => (
              <li key={tv.id}><Link href={`/lobby/tournaments/${tv.id}`} className="nf-panel block transition-colors hover:border-[var(--nf-primary)]">
                <p className="font-semibold">{tv.name}</p>
                <p className="text-xs text-[var(--nf-muted)]">{tv.players} jugadores · Premio 1.º: {formatMoney(tv.prizes[0]?.amount ?? '0', tv.currency)}</p>
              </Link></li>))}</ul>}
        </section>
        <section aria-label={t("Misiones")} className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">{t("Misiones")}</h2>
            <Link href="/lobby/vip" className="text-sm font-semibold text-[var(--nf-muted)] hover:text-[var(--nf-text)]">{t("Ver todas")}</Link>
          </div>
          <MissionsPanel missions={missions.data} loading={missions.loading} error={missions.error} limit={3} onRetry={missions.reload} onChange={() => { missions.reload(); refresh(); }} />
        </section>
      </div>
    ),
  };
  // Orden y visibilidad de la plantilla Reef publicada; sin plantilla, el orden clásico.
  const order = site?.config.home.sections.filter((s) => s.visible).map((s) => s.key) ?? DEFAULT_ORDER;
  const heroAt = order.indexOf('hero');

  return (
    <>
      <h1 className="sr-only">Casino {skin.name}</h1>
      {order.map((key, i) => (
        <Fragment key={key}>
          {sections[key]}
          {/* Las pestañas rápidas y el jackpot van justo después del hero (o al principio si se ocultó). */}
          {(i === heroAt || (heroAt < 0 && i === 0)) && (
            <>
              <nav aria-label={t("Categorías rápidas")} className="nf-tabs">
                {QUICK.map(({ label, href, icon: I }) => (
                  <Link key={href} href={href} className="nf-tab"><I aria-hidden className="h-4 w-4" />{t(label)}</Link>
                ))}
              </nav>
              <JackpotTicker jackpots={jp.data} loading={jp.loading} connected={jp.connected} />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}

export default function LobbyHome() {
  const { refresh } = useLobby();
  // Cada apuesta propia liquidada (en cualquier pestaña o dispositivo) vuelve a leer saldo y VIP.
  return <LiveFeedProvider onMine={refresh}><Lobby /></LiveFeedProvider>;
}
