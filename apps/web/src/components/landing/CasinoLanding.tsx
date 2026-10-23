"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, BadgeCheck, ChevronDown, Crown, Fingerprint, Gamepad2, Headphones, HeartHandshake, Lock, ShieldCheck, Smartphone, Sparkles, Trophy, UserPlus, Wallet, Zap } from "lucide-react";
import { assetUrl } from "@/lib/lobby/api";
import { LanguageSwitcher, useT } from "@/lib/i18n";
import { useGames, useJackpots } from "@/lib/lobby/hooks";
import { LiveFeedProvider, formatMultiplier, timeOf, useLiveBets } from "@/lib/lobby/liveBets";
import { fallbackThumb, formatMoney, toNumber } from "@/lib/lobby/format";
import type { FeedBet, Game, GameQuery } from "@/lib/lobby/types";
import "./casino-landing.css";

export interface CasinoLandingProps {
  /** Texto del bono de bienvenida (LANDING_BONUS). Sin configurar no se muestra ninguna oferta. */
  bonus?: string;
  /** Texto de la licencia para el pie (LANDING_LICENSE). */
  license?: string;
  /** Enlace al bot de Telegram del casino (LANDING_TELEGRAM_URL): pedidos, recargas y soporte. */
  telegram?: string;
}

/** Logo de Telegram (avión de papel) para los botones. */
function TelegramIcon({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.3a1.5 1.5 0 0 0-2.05-1.1L2.9 9.93c-1.2.48-1.18 2.2.04 2.64l4.03 1.46 1.6 5.08c.24.78 1.22 1.02 1.8.45l2.3-2.24 4.33 3.2c.86.63 2.08.16 2.3-.88l2.64-15.34zM9.8 14.2l-.6 3.3-1.1-3.7 9.6-6.5-7.9 6.9z"/></svg>
  );
}

const LOGO = "/brand/abyss-logo.webp";
const LOGO_FULL = "/brand/abyss-logo-principal.webp";
const MARK = "/brand/abyss-icon.webp";

/** Banderas en SVG (los emoji de bandera no se ven en Windows). */
const FLAGS: Record<string, React.ReactNode> = {
  CO: <><rect width="30" height="10" fill="#fcd116" /><rect y="10" width="30" height="5" fill="#003893" /><rect y="15" width="30" height="5" fill="#ce1126" /></>,
  MX: <><rect width="10" height="20" fill="#006847" /><rect x="10" width="10" height="20" fill="#fff" /><rect x="20" width="10" height="20" fill="#ce1126" /><circle cx="15" cy="10" r="2.6" fill="#8c5a2b" /></>,
  AR: <><rect width="30" height="20" fill="#74acdf" /><rect y="6.67" width="30" height="6.67" fill="#fff" /><circle cx="15" cy="10" r="2.2" fill="#f6b40e" /></>,
  US: <><rect width="30" height="20" fill="#b22234" />{[1, 3, 5, 7, 9, 11].map((n) => <rect key={n} y={(n * 20) / 13} width="30" height={20 / 13} fill="#fff" />)}<rect width="13" height={(7 * 20) / 13} fill="#3c3b6e" /></>,
  EN: <><rect width="30" height="20" fill="#fff" /><rect x="12.5" width="5" height="20" fill="#ce1124" /><rect y="7.5" width="30" height="5" fill="#ce1124" /></>,
};
const Flag = ({ code }: { code: string }) => <svg className="cx-flag" viewBox="0 0 30 20" aria-hidden>{FLAGS[code]}</svg>;
const LIVE_IN = [{ code: "CO", name: "Colombia" }, { code: "MX", name: "México" }, { code: "AR", name: "Argentina" }];
const SOON = [{ code: "US", name: "USA" }, { code: "EN", name: "Inglaterra" }];

const NAV = [
  { href: "/lobby", label: "Casino" },
  { href: "/lobby/category/originals", label: "Originals" },
  { href: "/lobby/category/slots", label: "Slots" },
  { href: "/lobby/category/live", label: "En vivo" },
  { href: "/lobby/tournaments", label: "Torneos" },
  { href: "/lobby/vip", label: "VIP" },
];

/** Filas del lobby: solo se muestran las que tienen juegos. */
const ROWS: Array<{ key: string; kicker: string; title: string; query: GameQuery; more: string; fair?: boolean }> = [
  { key: "originals", kicker: "Exclusivos", title: "Abyss Originals", query: { category: "originals", sort: "popular", pageSize: 12 }, more: "/lobby/category/originals", fair: true },
  { key: "slots", kicker: "Tragamonedas", title: "Slots", query: { category: "slots", sort: "popular", pageSize: 12 }, more: "/lobby/category/slots" },
  { key: "table", kicker: "Clásicos", title: "Mesa", query: { category: "table", sort: "popular", pageSize: 12 }, more: "/lobby/category/table" },
  { key: "live", kicker: "Crupieres reales", title: "Casino en vivo", query: { category: "live", sort: "popular", pageSize: 12 }, more: "/lobby/category/live" },
];

const STEPS = [
  { icon: UserPlus, title: "Crea tu cuenta", text: "Solo email y contraseña. Menos de un minuto." },
  { icon: Wallet, title: "Deposita en tu moneda", text: "Con los medios de pago de tu país, sin conversiones raras." },
  { icon: Gamepad2, title: "Juega y retira", text: "Verificas tu identidad una vez y retiras a tu cuenta." },
];

/** Métodos de pago que acepta el casino, con su color de marca. */
const METHODS: Record<string, { name: string; color: string; ink?: string }> = {
  nequi: { name: "Nequi", color: "#e5007d" },
  daviplata: { name: "Daviplata", color: "#ed1c27" },
  pse: { name: "PSE", color: "#0f4c9a" },
  mercadopago: { name: "Mercado Pago", color: "#00b1ea" },
  binance: { name: "Binance", color: "#f3ba2f", ink: "#1a1300" },
};
const PAYMENTS: Array<{ code: string; country: string; currency: string; methods: string[] }> = [
  { code: "CO", country: "Colombia", currency: "COP", methods: ["nequi", "daviplata", "pse", "mercadopago", "binance"] },
  { code: "MX", country: "México", currency: "MXN", methods: ["mercadopago", "binance"] },
  { code: "AR", country: "Argentina", currency: "ARS", methods: ["mercadopago", "binance"] },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "¿Cómo deposito?", a: "Entra a Caja o escríbenos por Telegram y elige Nequi, Daviplata, PSE, Mercado Pago o Binance según tu país. Si pagas por transferencia, subes el comprobante y nuestro sistema lo verifica contra el banco para acreditarte cuanto antes." },
  { q: "¿Cuánto tardan los retiros?", a: "Los procesamos en cuanto tu cuenta está verificada. El tiempo final depende del medio de pago que elijas; siempre ves el estado de tu retiro en tu cuenta." },
  { q: "¿Tengo que verificar mi identidad?", a: "Sí, una sola vez antes de tu primer retiro. Es por tu seguridad y por ley: así nadie más puede retirar tu dinero." },
  { q: "¿Qué es provably fair?", a: "En nuestros Originals cada resultado sale de una semilla del servidor (que ves cifrada antes de jugar) combinada con tu propia semilla. Después de jugar puedes comprobar tú mismo que el resultado no se alteró." },
  { q: "¿Puedo jugar desde el celular?", a: "Sí. Funciona en cualquier navegador y puedes instalarlo como app en iPhone o Android, con avisos de tus bonos y retiros." },
  { q: "¿Cómo funciona el VIP?", a: "Cada apuesta suma puntos. Al subir de nivel desbloqueas rakeback y beneficios que crecen contigo." },
  { q: "¿Puedo poner límites o pausar mi cuenta?", a: "Sí. En tu cuenta defines límites de depósito y de tiempo de sesión, o te autoexcluyes por el tiempo que quieras." },
  { q: "¿Cómo contacto a soporte?", a: "Por el chat del casino o por nuestro Telegram, 24/7, con personas reales. Por Telegram también puedes pedir tu recarga." },
];

const TIER_LABEL: Record<string, string> = { mini: "MINI", minor: "MENOR", major: "MAYOR", grand: "GRAN", mega: "MEGA" };
const tierLabel = (key: string) => TIER_LABEL[key.toLowerCase()] ?? key.toUpperCase();
const i = (n: number) => ({ "--i": n }) as CSSProperties;

/** Hilos de luz morados y dorados que ondulan detrás del hero (se pausa fuera de pantalla y con movimiento reducido). */
function useLightStrands() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const strands = Array.from({ length: 26 }, (_, n) => ({
      gold: n % 5 === 0,
      amp: 0.08 + Math.random() * 0.14,
      freq: 0.6 + Math.random() * 1.4,
      speed: 0.12 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
      offset: (n / 26 - 0.5) * 0.5,
      width: 0.6 + Math.random() * 1.6,
    }));
    let w = 0, h = 0, raf = 0, visible = true, mx = 0.5;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = c.clientWidth; h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const cx = w * (0.62 + (mx - 0.5) * 0.08);
      for (const s of strands) {
        ctx.beginPath();
        for (let x = -20; x <= w + 20; x += 14) {
          const u = x / w;
          const pinch = Math.exp(-((x - cx) ** 2) / (2 * (w * 0.22) ** 2));
          const y = h * (0.5 + s.offset * (1 - pinch * 0.85)) + Math.sin(u * Math.PI * 2 * s.freq + t * s.speed + s.phase) * h * s.amp * (0.4 + pinch);
          if (x === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = s.gold ? "rgba(244,183,63,0.32)" : "rgba(139,92,246,0.22)";
        ctx.lineWidth = s.width;
        ctx.shadowColor = s.gold ? "rgba(255,217,120,0.9)" : "rgba(192,132,252,0.9)";
        ctx.shadowBlur = 12;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    };
    const loop = (ms: number) => {
      draw(ms / 1000);
      raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
    };
    const restart = () => { if (!raf && visible && !document.hidden && !reduce) raf = requestAnimationFrame(loop); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; restart(); });
    const onMove = (e: PointerEvent) => { mx = e.clientX / window.innerWidth; };
    resize();
    if (reduce) draw(0); else raf = requestAnimationFrame(loop);
    io.observe(c);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", restart);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", restart);
    };
  }, []);
  return ref;
}

/** Revela con suavidad los bloques .cx-reveal al entrar en pantalla (también los que aparecen después, al cargar datos). */
function useReveal() {
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("cx-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    const scan = () => document.querySelectorAll(".cx-reveal:not(.cx-in)").forEach((el) => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, []);
}

function GameTile({ game, fair }: { game: Game; fair?: boolean }) {
  const { t } = useT();
  const [broken, setBroken] = useState(false);
  const thumb = assetUrl(game.images.thumb || game.images.banner);
  const src = !broken && thumb ? thumb : fallbackThumb(game.title, game.providerId);
  return (
    <Link href={`/lobby/game/${game.id}`} className="cx-game" aria-label={`Jugar ${game.title}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      {game.isNew && <span className="cx-badge">{t("NUEVO")}</span>}
      {fair && game.rtp > 0 && <span className="cx-rtp">RTP {game.rtp}%</span>}
      <span className="cx-game-play" aria-hidden>{t("Jugar")}</span>
    </Link>
  );
}

function GameRow({ row }: { row: (typeof ROWS)[number] }) {
  const { t } = useT();
  const { items, loading } = useGames(row.query);
  if (!loading && items.length === 0) return null;
  return (
    <div className="cx-row">
      <div className="cx-head cx-reveal">
        <div>
          <p className="cx-kicker">{t(row.kicker)}</p>
          <h3 className="cx-h3">{t(row.title)}{row.fair && <span className="cx-fair"><BadgeCheck aria-hidden size={14} />{t("Provably fair")}</span>}</h3>
        </div>
        <Link href={row.more} className="cx-more">{t("Ver todos")} <ArrowRight aria-hidden size={16} /></Link>
      </div>
      <div className="cx-rail" aria-busy={loading}>
        {loading && items.length === 0 && Array.from({ length: 6 }, (_, n) => <div key={n} className="cx-skel" />)}
        {items.map((g) => <GameTile key={g.id} game={g} fair={row.fair} />)}
      </div>
    </div>
  );
}

/** Cinta de ganadores reales del feed en vivo (nombres ya enmascarados por el servidor). */
function Winners({ wins }: { wins: FeedBet[] }) {
  const { t } = useT();
  if (wins.length === 0) return null;
  const item = (b: FeedBet, k: string) => (
    <span key={k} className="cx-win"><Trophy aria-hidden size={14} color="#f4b73f" /><strong>{b.player}</strong> {t("ganó")} <b>{formatMoney(b.win, b.currency)}</b> {t("en")} {b.gameTitle}</span>
  );
  return (
    <div className="cx-winners" aria-label={t("Ganadores recientes")}>
      <div className="cx-winners-track">
        {wins.map((b) => item(b, b.id))}
        <span aria-hidden style={{ display: "contents" }}>{wins.map((b) => item(b, `d${b.id}`))}</span>
      </div>
    </div>
  );
}

const BET_TABS = [{ key: "all", label: "Todas" }, { key: "high", label: "Grandes apuestas" }, { key: "lucky", label: "Golpes de suerte" }] as const;

/** Tabla de jugadas en vivo, como en los casinos grandes: confianza a la vista. */
function LiveBets({ lists }: { lists: Record<(typeof BET_TABS)[number]["key"], FeedBet[]> }) {
  const { t } = useT();
  const [tab, setTab] = useState<(typeof BET_TABS)[number]["key"]>("all");
  const rows = lists[tab].slice(0, 10);
  return (
    <div className="cx-bets cx-reveal">
      <div className="cx-tabs" role="tablist" aria-label={t("Jugadas en vivo")}>
        {BET_TABS.map((bt) => <button key={bt.key} type="button" role="tab" aria-selected={bt.key === tab} className="cx-tab" onClick={() => setTab(bt.key)}>{t(bt.label)}</button>)}
      </div>
      <div className="cx-table" role="table" aria-label={t("Últimas jugadas")}>
        <div className="cx-tr cx-th" role="row"><span role="columnheader">{t("Juego")}</span><span role="columnheader">{t("Jugador")}</span><span role="columnheader" className="cx-hide-sm">{t("Hora")}</span><span role="columnheader" className="cx-hide-sm">{t("Apuesta")}</span><span role="columnheader">{t("Multiplicador")}</span><span role="columnheader">{t("Pago")}</span></div>
        {rows.length === 0 && <div className="cx-empty">{t("Las jugadas aparecen aquí en tiempo real.")}</div>}
        {rows.map((b) => {
          const won = toNumber(b.win) > 0;
          return (
            <div key={b.id} className="cx-tr" role="row">
              <span role="cell" className="cx-ellipsis">{b.gameTitle}</span>
              <span role="cell" className="cx-ellipsis">{b.player}</span>
              <span role="cell" className="cx-hide-sm">{timeOf(b.at)}</span>
              <span role="cell" className="cx-hide-sm">{formatMoney(b.amount, b.currency)}</span>
              <span role="cell">{formatMultiplier(b.multiplier)}</span>
              <span role="cell" className={won ? "cx-up" : "cx-down"}>{won ? "+" : ""}{formatMoney(b.win, b.currency)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Hero({ bonus, telegram }: { bonus?: string; telegram?: string }) {
  const { t } = useT();
  const canvas = useLightStrands();
  const { data: jackpots } = useJackpots();
  const top = useMemo(() => {
    let best: { amount: string; currency: string; name: string } | null = null;
    for (const j of jackpots ?? []) for (const l of j.levels) if (!best || toNumber(l.amount) > toNumber(best.amount)) best = { amount: l.amount, currency: j.currency, name: tierLabel(l.key) };
    return best;
  }, [jackpots]);
  return (
    <header className="cx-hero">
      <canvas ref={canvas} className="cx-canvas" aria-hidden />
      <div className="cx-wrap cx-hero-grid">
        <div>
          <div className="cx-countries cx-reveal">
            <span className="cx-chip"><i aria-hidden />{LIVE_IN.map((c) => <span key={c.code} className="cx-country"><Flag code={c.code} />{t(c.name)}</span>)}</span>
            <span className="cx-chip cx-chip-soon">{t("Próximamente")}{SOON.map((c) => <span key={c.code} className="cx-country"><Flag code={c.code} />{t(c.name)}</span>)}</span>
          </div>
          <h1 className="cx-h1 cx-reveal" style={i(1)}>{t("Juega en")} <em>{t("otra dimensión.")}</em></h1>
          <p className="cx-lead cx-reveal" style={i(2)}>{t("Slots, mesas y nuestros Originals provably fair. Deposita en tu moneda con los medios de pago de tu país, juega desde el celular y retira a tu cuenta.")}</p>
          <div className="cx-cta cx-reveal" style={i(3)}>
            <Link href="/register" className="cx-btn cx-btn-gold">{t("Jugar ahora")} <ArrowRight aria-hidden size={18} /></Link>
            {bonus
              ? <Link href="/register" className="cx-btn cx-btn-ghost"><Sparkles aria-hidden size={18} />{bonus}</Link>
              : !telegram && <Link href="#juegos" className="cx-btn cx-btn-ghost"><Gamepad2 aria-hidden size={18} />{t("Ver juegos")}</Link>}
            {telegram && <a href={telegram} target="_blank" rel="noopener noreferrer" className="cx-btn cx-btn-tg"><TelegramIcon />{t("Recarga por Telegram")}</a>}
          </div>
          <div className="cx-proof cx-reveal" style={i(4)}>
            <span><Zap aria-hidden size={16} />{t("Retiros a tu cuenta")}</span>
            <span><ShieldCheck aria-hidden size={16} />{t("Provably fair")}</span>
            <span><Headphones aria-hidden size={16} />{t("Soporte 24/7")}</span>
          </div>
        </div>
        <div className="cx-ring cx-reveal" style={i(2)}>
          <span className="cx-orbit" aria-hidden />
          <div className="cx-ring-in" aria-live="polite">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_FULL} alt="Infinite Abyss" className={top ? "cx-ring-logo cx-ring-logo-sm" : "cx-ring-logo"} />
            {top ? (
              <><small>{top.name} JACKPOT</small><strong>{formatMoney(top.amount, top.currency)}</strong><span>{t("Crece con cada apuesta")}</span></>
            ) : (
              <span>{t("Slots · Mesa · Originals")}</span>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Jackpots() {
  const { t } = useT();
  const { data } = useJackpots();
  const j = data?.find((x) => x.levels.length > 0);
  if (!j) return null;
  const levels = [...j.levels].sort((a, b) => toNumber(a.amount) - toNumber(b.amount));
  return (
    <div className="cx-row">
      <div className="cx-head cx-reveal"><div><p className="cx-kicker">{t("Jackpots en vivo")}</p><h3 className="cx-h3">{j.name}</h3></div></div>
      <div className="cx-jps">
        {levels.map((l, n) => (
          <div key={l.key} className={`cx-jp cx-reveal${n === levels.length - 1 ? " cx-jp-top" : ""}`} style={i(n)}>
            <small>{tierLabel(l.key)}</small><strong>{formatMoney(l.amount, j.currency)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function PayBadge({ id }: { id: string }) {
  const m = METHODS[id];
  return <span className="cx-pay" style={{ "--pay": m.color, "--pay-ink": m.ink ?? "#fff" } as CSSProperties}>{m.name}</span>;
}

function Payments() {
  const { t } = useT();
  const [code, setCode] = useState(PAYMENTS[0].code);
  const p = PAYMENTS.find((x) => x.code === code) ?? PAYMENTS[0];
  return (
    <div className="cx-panel cx-reveal">
      <p className="cx-kicker">{t("Pagos")}</p>
      <h3 className="cx-h3">{t("Deposita como ya pagas")}</h3>
      <p className="cx-muted">{t("Elige tu país: juegas y retiras en {cur}, sin conversiones. Con Binance también puedes depositar en cripto.", { cur: p.currency })}</p>
      <div className="cx-tabs" role="tablist" aria-label={t("País")} style={{ marginTop: "1.2rem" }}>
        {PAYMENTS.map((x) => <button key={x.code} type="button" role="tab" aria-selected={x.code === code} className="cx-tab cx-country" onClick={() => setCode(x.code)}><Flag code={x.code} />{t(x.country)}</button>)}
      </div>
      <ul className="cx-methods" role="tabpanel">
        {p.methods.map((m) => <li key={m}><PayBadge id={m} /></li>)}
      </ul>
      <p className="cx-soon">{t("Próximamente")}{SOON.map((c) => <span key={c.code} className="cx-country"><Flag code={c.code} />{t(c.name)}</span>)}</p>
    </div>
  );
}

export function CasinoLanding({ bonus, license, telegram }: CasinoLandingProps) {
  useReveal();
  return (
    <LiveFeedProvider>
      <CasinoPage bonus={bonus} license={license} telegram={telegram} />
    </LiveFeedProvider>
  );
}

function CasinoPage({ bonus, license, telegram }: CasinoLandingProps) {
  const { t } = useT();
  const { lists } = useLiveBets();
  const wins = useMemo(() => {
    const seen = new Set<string>();
    return [...lists.high, ...lists.lucky, ...lists.all]
      .filter((b) => toNumber(b.win) > toNumber(b.amount) && !seen.has(b.id) && seen.add(b.id))
      .slice(0, 16);
  }, [lists]);
  return (
    <div className="cx">
      <nav className="cx-nav" aria-label={t("Principal")}>
        <div className="cx-wrap cx-nav-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <Link href="/" className="cx-brand" aria-label="Infinite Abyss, inicio"><img src={LOGO} alt="Infinite Abyss" /></Link>
          <div className="cx-links">{NAV.map((n) => <Link key={n.href} href={n.href}>{t(n.label)}</Link>)}</div>
          <div className="cx-auth">
            <LanguageSwitcher className="cx-lang" />
            {telegram && <a href={telegram} target="_blank" rel="noopener noreferrer" className="cx-btn cx-btn-tg cx-btn-sm cx-tg-nav" aria-label={t("Escríbenos por Telegram")}><TelegramIcon size={16} /><span>{t("Telegram")}</span></a>}
            <Link href="/login" className="cx-btn cx-btn-ghost cx-btn-sm">{t("Ingresar")}</Link>
            <Link href="/register" className="cx-btn cx-btn-gold cx-btn-sm">{t("Registrarse")}</Link>
          </div>
        </div>
      </nav>

      <main>
        <Hero bonus={bonus} telegram={telegram} />
        <Winners wins={wins} />

        <section id="juegos" className="cx-section">
          <div className="cx-wrap">
            <div className="cx-reveal" style={{ marginBottom: "2rem" }}><p className="cx-kicker">{t("Lobby")}</p><h2 className="cx-h2">{t("Elige tu próxima jugada")}</h2></div>
            <Jackpots />
            {ROWS.map((r) => <GameRow key={r.key} row={r} />)}
            <div className="cx-reveal" style={{ textAlign: "center", marginTop: "1rem" }}><Link href="/lobby" className="cx-btn cx-btn-ghost">{t("Ir al lobby completo")} <ArrowRight aria-hidden size={18} /></Link></div>
          </div>
        </section>

        <section className="cx-section cx-band">
          <div className="cx-wrap">
            <div className="cx-reveal" style={{ textAlign: "center" }}><p className="cx-kicker">{t("Cómo funciona")}</p><h2 className="cx-h2">{t("Empieza a jugar en 3 pasos")}</h2></div>
            <ol className="cx-steps">
              {STEPS.map(({ icon: Icon, title, text }, n) => (
                <li key={title} className="cx-step cx-reveal" style={i(n)}>
                  <span className="cx-step-n">{n + 1}</span>
                  <Icon aria-hidden size={28} className="cx-step-icon" />
                  <b>{t(title)}</b><p>{t(text)}</p>
                </li>
              ))}
            </ol>
            <div className="cx-reveal" style={{ textAlign: "center", marginTop: "2rem" }}><Link href="/register" className="cx-btn cx-btn-gold">{t("Crear mi cuenta")} <ArrowRight aria-hidden size={18} /></Link></div>
          </div>
        </section>

        <section className="cx-section">
          <div className="cx-wrap cx-split">
            <div>
              <div className="cx-reveal"><p className="cx-kicker">{t("En vivo")}</p><h2 className="cx-h2">{t("Lo que se está jugando ahora")}</h2><p className="cx-muted" style={{ marginTop: ".6rem" }}>{t("Cada jugada real del casino, al instante. Sin trucos.")}</p></div>
              <LiveBets lists={lists} />
            </div>
            <Payments />
          </div>
        </section>

        <section className="cx-section" style={{ paddingTop: 0 }}>
          <div className="cx-wrap cx-duo">
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(52 211 153 / .28)" } as CSSProperties}>
              <Fingerprint aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">{t("Provably fair")}</p>
              <h3>{t("Compruébalo tú mismo")}</h3>
              <p>{t("En los Originals ves la semilla cifrada antes de jugar, pones la tuya y al final verificas cada resultado. Nadie puede cambiarlo, ni nosotros.")}</p>
              <Link href="/lobby/category/originals" className="cx-btn cx-btn-ghost cx-btn-sm" style={{ alignSelf: "flex-start" }}>{t("Jugar Originals")} <ArrowRight aria-hidden size={16} /></Link>
            </div>
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(139 92 246 / .45)", ...i(1) } as CSSProperties}>
              <Trophy aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">{t("Torneos")}</p>
              <h3>{t("Compite cada semana")}</h3>
              <p>{t("Suma puntos con tus juegos favoritos, sube en la tabla en vivo y llévate premios.")}</p>
              <Link href="/lobby/tournaments" className="cx-btn cx-btn-ghost cx-btn-sm" style={{ alignSelf: "flex-start" }}>{t("Ver torneos")} <ArrowRight aria-hidden size={16} /></Link>
            </div>
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(244 183 63 / .35)", ...i(2) } as CSSProperties}>
              <Crown aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">{t("Club VIP")}</p>
              <h3>{t("Cada jugada te sube de nivel")}</h3>
              <p>{t("Rakeback, bonos y beneficios que crecen contigo, desde tu primer depósito.")}</p>
              <Link href="/lobby/vip" className="cx-btn cx-btn-gold cx-btn-sm" style={{ alignSelf: "flex-start" }}>{t("Conocer el VIP")} <ArrowRight aria-hidden size={16} /></Link>
            </div>
          </div>
        </section>

        <section className="cx-section cx-band">
          <div className="cx-wrap cx-split">
            <div className="cx-reveal">
              <p className="cx-kicker">{t("Seguridad y juego responsable")}</p>
              <h2 className="cx-h2">{t("Tu dinero y tu tiempo, bajo tu control")}</h2>
              <ul className="cx-checks">
                <li><Lock aria-hidden size={18} /><span><b>{t("Cuenta protegida.")}</b> {t("Datos cifrados y verificación de identidad antes de retirar.")}</span></li>
                <li><HeartHandshake aria-hidden size={18} /><span><b>{t("Límites a tu medida.")}</b> {t("Depósito, tiempo de sesión y autoexclusión desde tu cuenta.")}</span></li>
                <li><Smartphone aria-hidden size={18} /><span><b>{t("App en tu celular.")}</b> {t("Instálala en iPhone o Android y recibe avisos de tus retiros.")}</span></li>
                <li><Headphones aria-hidden size={18} /><span><b>{t("Personas reales 24/7.")}</b> {t("Soporte por el chat del casino a cualquier hora.")}</span></li>
              </ul>
            </div>
            <div className="cx-faq cx-reveal" style={i(1)}>
              <p className="cx-kicker">{t("Preguntas frecuentes")}</p>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{t(f.q)}<ChevronDown aria-hidden size={18} /></summary>
                  <p>{t(f.a)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="cx-section">
          <div className="cx-wrap">
            <div className="cx-final cx-reveal">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={MARK} alt="" className="cx-final-mark" />
              <h2 className="cx-h2">{t("El abismo te espera.")}</h2>
              <p className="cx-muted">{t("Crea tu cuenta y empieza a jugar hoy.")}</p>
              <div className="cx-cta" style={{ justifyContent: "center", marginTop: "1.4rem" }}>
                <Link href="/register" className="cx-btn cx-btn-gold">{t("Jugar ahora")} <ArrowRight aria-hidden size={18} /></Link>
                {telegram && <a href={telegram} target="_blank" rel="noopener noreferrer" className="cx-btn cx-btn-tg"><TelegramIcon />{t("Pide por Telegram")}</a>}
              </div>
            </div>
          </div>
        </section>

        <section className="cx-section" style={{ paddingTop: 0 }}>
          <div className="cx-wrap">
            <div className="cx-ops cx-reveal">
              <div>
                <p className="cx-kicker">{t("Para operadores")}</p>
                <h2 className="cx-h2">{t("¿Tienes un casino o quieres lanzar el tuyo?")}</h2>
                <p className="cx-muted" style={{ marginTop: ".8rem", maxWidth: "36rem" }}>{t("Este casino corre sobre Infinite Abyss: tu marca, juegos, caja con IA que verifica comprobantes, CRM con WhatsApp y Telegram, bots, equipo y un operador IA que vigila todo 24/7.")}</p>
              </div>
              <Link href="/plataforma" className="cx-btn cx-btn-gold cx-btn-xl">{t("Conoce la plataforma")} <ArrowRight aria-hidden size={22} /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="cx-footer">
        <div className="cx-wrap cx-footer-grid">
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} alt="Infinite Abyss" className="cx-footer-logo" />
            <p style={{ display: "flex", alignItems: "center", maxWidth: "30rem" }}><span className="cx-18" aria-label={t("Solo mayores de 18")}>18+</span>{t("Juega con responsabilidad. El juego es entretenimiento, no una forma de ganar dinero. Prohibido para menores de edad.")}</p>
            {license && <p style={{ marginTop: ".8rem" }}>{license}</p>}
          </div>
          <div><h4>{t("Jugar")}</h4><ul>{NAV.slice(0, 4).map((n) => <li key={n.href}><Link href={n.href}>{t(n.label)}</Link></li>)}</ul></div>
          <div><h4>{t("Ayuda")}</h4><ul><li><Link href="/webchat">{t("Soporte 24/7")}</Link></li>{telegram && <li><a href={telegram} target="_blank" rel="noopener noreferrer">{t("Telegram")}</a></li>}<li><Link href="/account">{t("Mi cuenta y límites")}</Link></li><li><Link href="/plataforma">{t("Para operadores")}</Link></li></ul></div>
        </div>
        <div className="cx-wrap cx-paystrip" aria-label={t("Métodos de pago")}>{Object.keys(METHODS).map((m) => <PayBadge key={m} id={m} />)}</div>
        <div className="cx-wrap cx-footer-bottom">
          <span>© {new Date().getFullYear()} Infinite Abyss</span>
          <Link href="/plataforma">{t("¿Tienes un casino? Conoce la plataforma →")}</Link>
        </div>
      </footer>
      {telegram && <a href={telegram} target="_blank" rel="noopener noreferrer" className="cx-tg-fab" aria-label={t("Escríbenos por Telegram")}><TelegramIcon size={28} /></a>}
    </div>
  );
}
