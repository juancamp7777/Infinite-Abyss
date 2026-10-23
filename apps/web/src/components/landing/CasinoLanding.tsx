"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, BadgeCheck, ChevronDown, Crown, Fingerprint, Gamepad2, Headphones, HeartHandshake, Lock, ShieldCheck, Smartphone, Sparkles, Trophy, UserPlus, Wallet, Zap } from "lucide-react";
import { assetUrl } from "@/lib/lobby/api";
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
}

const LOGO = "/brand/infinite-abyss-logo.svg";
const MARK = "/brand/infinite-abyss-mark.svg";

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

const PAYMENTS: Array<{ code: string; country: string; currency: string; methods: string[] }> = [
  { code: "CO", country: "Colombia", currency: "COP", methods: ["Nequi", "Daviplata", "PSE", "Bancolombia", "Transferencia bancaria"] },
  { code: "MX", country: "México", currency: "MXN", methods: ["SPEI", "Transferencia bancaria", "Mercado Pago"] },
  { code: "AR", country: "Argentina", currency: "ARS", methods: ["Mercado Pago", "Transferencia CVU / CBU"] },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "¿Cómo deposito?", a: "Entra a Caja, elige el medio de pago de tu país y sigue los pasos. Si pagas por transferencia, subes el comprobante y nuestro sistema lo verifica contra el banco para acreditarte cuanto antes." },
  { q: "¿Cuánto tardan los retiros?", a: "Los procesamos en cuanto tu cuenta está verificada. El tiempo final depende del medio de pago que elijas; siempre ves el estado de tu retiro en tu cuenta." },
  { q: "¿Tengo que verificar mi identidad?", a: "Sí, una sola vez antes de tu primer retiro. Es por tu seguridad y por ley: así nadie más puede retirar tu dinero." },
  { q: "¿Qué es provably fair?", a: "En nuestros Originals cada resultado sale de una semilla del servidor (que ves cifrada antes de jugar) combinada con tu propia semilla. Después de jugar puedes comprobar tú mismo que el resultado no se alteró." },
  { q: "¿Puedo jugar desde el celular?", a: "Sí. Funciona en cualquier navegador y puedes instalarlo como app en iPhone o Android, con avisos de tus bonos y retiros." },
  { q: "¿Cómo funciona el VIP?", a: "Cada apuesta suma puntos. Al subir de nivel desbloqueas rakeback y beneficios que crecen contigo." },
  { q: "¿Puedo poner límites o pausar mi cuenta?", a: "Sí. En tu cuenta defines límites de depósito y de tiempo de sesión, o te autoexcluyes por el tiempo que quieras." },
  { q: "¿Cómo contacto a soporte?", a: "Por el chat del casino, 24/7, con personas reales." },
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
  const [broken, setBroken] = useState(false);
  const thumb = assetUrl(game.images.thumb || game.images.banner);
  const src = !broken && thumb ? thumb : fallbackThumb(game.title, game.providerId);
  return (
    <Link href={`/lobby/game/${game.id}`} className="cx-game" aria-label={`Jugar ${game.title}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      {game.isNew && <span className="cx-badge">NUEVO</span>}
      {fair && game.rtp > 0 && <span className="cx-rtp">RTP {game.rtp}%</span>}
      <span className="cx-game-play" aria-hidden>Jugar</span>
    </Link>
  );
}

function GameRow({ row }: { row: (typeof ROWS)[number] }) {
  const { items, loading } = useGames(row.query);
  if (!loading && items.length === 0) return null;
  return (
    <div className="cx-row">
      <div className="cx-head cx-reveal">
        <div>
          <p className="cx-kicker">{row.kicker}</p>
          <h3 className="cx-h3">{row.title}{row.fair && <span className="cx-fair"><BadgeCheck aria-hidden size={14} />Provably fair</span>}</h3>
        </div>
        <Link href={row.more} className="cx-more">Ver todos <ArrowRight aria-hidden size={16} /></Link>
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
  if (wins.length === 0) return null;
  const item = (b: FeedBet, k: string) => (
    <span key={k} className="cx-win"><Trophy aria-hidden size={14} color="#f4b73f" /><strong>{b.player}</strong> ganó <b>{formatMoney(b.win, b.currency)}</b> en {b.gameTitle}</span>
  );
  return (
    <div className="cx-winners" aria-label="Ganadores recientes">
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
  const [tab, setTab] = useState<(typeof BET_TABS)[number]["key"]>("all");
  const rows = lists[tab].slice(0, 10);
  return (
    <div className="cx-bets cx-reveal">
      <div className="cx-tabs" role="tablist" aria-label="Jugadas en vivo">
        {BET_TABS.map((t) => <button key={t.key} type="button" role="tab" aria-selected={t.key === tab} className="cx-tab" onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      <div className="cx-table" role="table" aria-label="Últimas jugadas">
        <div className="cx-tr cx-th" role="row"><span role="columnheader">Juego</span><span role="columnheader">Jugador</span><span role="columnheader" className="cx-hide-sm">Hora</span><span role="columnheader" className="cx-hide-sm">Apuesta</span><span role="columnheader">Multiplicador</span><span role="columnheader">Pago</span></div>
        {rows.length === 0 && <div className="cx-empty">Las jugadas aparecen aquí en tiempo real.</div>}
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

function Hero({ bonus }: { bonus?: string }) {
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
          <span className="cx-chip cx-reveal"><i aria-hidden />Casino online · Colombia · México · Argentina</span>
          <h1 className="cx-h1 cx-reveal" style={i(1)}>Juega en <em>otra dimensión.</em></h1>
          <p className="cx-lead cx-reveal" style={i(2)}>Slots, mesas y nuestros Originals provably fair. Deposita en tu moneda con los medios de pago de tu país, juega desde el celular y retira a tu cuenta.</p>
          <div className="cx-cta cx-reveal" style={i(3)}>
            <Link href="/register" className="cx-btn cx-btn-gold">Jugar ahora <ArrowRight aria-hidden size={18} /></Link>
            {bonus
              ? <Link href="/register" className="cx-btn cx-btn-ghost"><Sparkles aria-hidden size={18} />{bonus}</Link>
              : <Link href="#juegos" className="cx-btn cx-btn-ghost"><Gamepad2 aria-hidden size={18} />Ver juegos</Link>}
          </div>
          <div className="cx-proof cx-reveal" style={i(4)}>
            <span><Zap aria-hidden size={16} />Retiros a tu cuenta</span>
            <span><ShieldCheck aria-hidden size={16} />Provably fair</span>
            <span><Headphones aria-hidden size={16} />Soporte 24/7</span>
          </div>
        </div>
        <div className="cx-ring cx-reveal" style={i(2)}>
          <span className="cx-orbit" aria-hidden />
          <div className="cx-ring-in" aria-live="polite">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={MARK} alt="" className="cx-ring-mark" />
            {top ? (
              <><small>{top.name} JACKPOT</small><strong>{formatMoney(top.amount, top.currency)}</strong><span>Crece con cada apuesta</span></>
            ) : (
              <><small>INFINITE ABYSS</small><span>Slots · Mesa · Originals</span></>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Jackpots() {
  const { data } = useJackpots();
  const j = data?.find((x) => x.levels.length > 0);
  if (!j) return null;
  const levels = [...j.levels].sort((a, b) => toNumber(a.amount) - toNumber(b.amount));
  return (
    <div className="cx-row">
      <div className="cx-head cx-reveal"><div><p className="cx-kicker">Jackpots en vivo</p><h3 className="cx-h3">{j.name}</h3></div></div>
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

function Payments() {
  const [code, setCode] = useState(PAYMENTS[0].code);
  const p = PAYMENTS.find((x) => x.code === code) ?? PAYMENTS[0];
  return (
    <div className="cx-panel cx-reveal">
      <p className="cx-kicker">Pagos</p>
      <h3 className="cx-h3">Deposita como ya pagas</h3>
      <p className="cx-muted">Elige tu país: juegas y retiras en {p.currency}, sin conversiones.</p>
      <div className="cx-tabs" role="tablist" aria-label="País" style={{ marginTop: "1.2rem" }}>
        {PAYMENTS.map((x) => <button key={x.code} type="button" role="tab" aria-selected={x.code === code} className="cx-tab" onClick={() => setCode(x.code)}>{x.country}</button>)}
      </div>
      <ul className="cx-methods" role="tabpanel">
        {p.methods.map((m) => <li key={m}><Wallet aria-hidden size={16} />{m}</li>)}
      </ul>
    </div>
  );
}

export function CasinoLanding({ bonus, license }: CasinoLandingProps) {
  useReveal();
  return (
    <LiveFeedProvider>
      <CasinoPage bonus={bonus} license={license} />
    </LiveFeedProvider>
  );
}

function CasinoPage({ bonus, license }: CasinoLandingProps) {
  const { lists } = useLiveBets();
  const wins = useMemo(() => {
    const seen = new Set<string>();
    return [...lists.high, ...lists.lucky, ...lists.all]
      .filter((b) => toNumber(b.win) > toNumber(b.amount) && !seen.has(b.id) && seen.add(b.id))
      .slice(0, 16);
  }, [lists]);
  return (
    <div className="cx">
      <nav className="cx-nav" aria-label="Principal">
        <div className="cx-wrap cx-nav-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <Link href="/" className="cx-brand" aria-label="Infinite Abyss, inicio"><img src={LOGO} alt="Infinite Abyss" /></Link>
          <div className="cx-links">{NAV.map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}</div>
          <div className="cx-auth">
            <Link href="/login" className="cx-btn cx-btn-ghost cx-btn-sm">Ingresar</Link>
            <Link href="/register" className="cx-btn cx-btn-gold cx-btn-sm">Registrarse</Link>
          </div>
        </div>
      </nav>

      <main>
        <Hero bonus={bonus} />
        <Winners wins={wins} />

        <section id="juegos" className="cx-section">
          <div className="cx-wrap">
            <div className="cx-reveal" style={{ marginBottom: "2rem" }}><p className="cx-kicker">Lobby</p><h2 className="cx-h2">Elige tu próxima jugada</h2></div>
            <Jackpots />
            {ROWS.map((r) => <GameRow key={r.key} row={r} />)}
            <div className="cx-reveal" style={{ textAlign: "center", marginTop: "1rem" }}><Link href="/lobby" className="cx-btn cx-btn-ghost">Ir al lobby completo <ArrowRight aria-hidden size={18} /></Link></div>
          </div>
        </section>

        <section className="cx-section cx-band">
          <div className="cx-wrap">
            <div className="cx-reveal" style={{ textAlign: "center" }}><p className="cx-kicker">Cómo funciona</p><h2 className="cx-h2">Empieza a jugar en 3 pasos</h2></div>
            <ol className="cx-steps">
              {STEPS.map(({ icon: Icon, title, text }, n) => (
                <li key={title} className="cx-step cx-reveal" style={i(n)}>
                  <span className="cx-step-n">{n + 1}</span>
                  <Icon aria-hidden size={28} className="cx-step-icon" />
                  <b>{title}</b><p>{text}</p>
                </li>
              ))}
            </ol>
            <div className="cx-reveal" style={{ textAlign: "center", marginTop: "2rem" }}><Link href="/register" className="cx-btn cx-btn-gold">Crear mi cuenta <ArrowRight aria-hidden size={18} /></Link></div>
          </div>
        </section>

        <section className="cx-section">
          <div className="cx-wrap cx-split">
            <div>
              <div className="cx-reveal"><p className="cx-kicker">En vivo</p><h2 className="cx-h2">Lo que se está jugando ahora</h2><p className="cx-muted" style={{ marginTop: ".6rem" }}>Cada jugada real del casino, al instante. Sin trucos.</p></div>
              <LiveBets lists={lists} />
            </div>
            <Payments />
          </div>
        </section>

        <section className="cx-section" style={{ paddingTop: 0 }}>
          <div className="cx-wrap cx-duo">
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(52 211 153 / .28)" } as CSSProperties}>
              <Fingerprint aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">Provably fair</p>
              <h3>Compruébalo tú mismo</h3>
              <p>En los Originals ves la semilla cifrada antes de jugar, pones la tuya y al final verificas cada resultado. Nadie puede cambiarlo, ni nosotros.</p>
              <Link href="/lobby/category/originals" className="cx-btn cx-btn-ghost cx-btn-sm" style={{ alignSelf: "flex-start" }}>Jugar Originals <ArrowRight aria-hidden size={16} /></Link>
            </div>
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(139 92 246 / .45)", ...i(1) } as CSSProperties}>
              <Trophy aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">Torneos</p>
              <h3>Compite cada semana</h3>
              <p>Suma puntos con tus juegos favoritos, sube en la tabla en vivo y llévate premios.</p>
              <Link href="/lobby/tournaments" className="cx-btn cx-btn-ghost cx-btn-sm" style={{ alignSelf: "flex-start" }}>Ver torneos <ArrowRight aria-hidden size={16} /></Link>
            </div>
            <div className="cx-feature cx-reveal" style={{ "--c1": "rgb(244 183 63 / .35)", ...i(2) } as CSSProperties}>
              <Crown aria-hidden className="cx-feature-icon" />
              <p className="cx-kicker">Club VIP</p>
              <h3>Cada jugada te sube de nivel</h3>
              <p>Rakeback, bonos y beneficios que crecen contigo, desde tu primer depósito.</p>
              <Link href="/lobby/vip" className="cx-btn cx-btn-gold cx-btn-sm" style={{ alignSelf: "flex-start" }}>Conocer el VIP <ArrowRight aria-hidden size={16} /></Link>
            </div>
          </div>
        </section>

        <section className="cx-section cx-band">
          <div className="cx-wrap cx-split">
            <div className="cx-reveal">
              <p className="cx-kicker">Seguridad y juego responsable</p>
              <h2 className="cx-h2">Tu dinero y tu tiempo, bajo tu control</h2>
              <ul className="cx-checks">
                <li><Lock aria-hidden size={18} /><span><b>Cuenta protegida.</b> Datos cifrados y verificación de identidad antes de retirar.</span></li>
                <li><HeartHandshake aria-hidden size={18} /><span><b>Límites a tu medida.</b> Depósito, tiempo de sesión y autoexclusión desde tu cuenta.</span></li>
                <li><Smartphone aria-hidden size={18} /><span><b>App en tu celular.</b> Instálala en iPhone o Android y recibe avisos de tus retiros.</span></li>
                <li><Headphones aria-hidden size={18} /><span><b>Personas reales 24/7.</b> Soporte por el chat del casino a cualquier hora.</span></li>
              </ul>
            </div>
            <div className="cx-faq cx-reveal" style={i(1)}>
              <p className="cx-kicker">Preguntas frecuentes</p>
              {FAQ.map((f) => (
                <details key={f.q}>
                  <summary>{f.q}<ChevronDown aria-hidden size={18} /></summary>
                  <p>{f.a}</p>
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
              <h2 className="cx-h2">El abismo te espera.</h2>
              <p className="cx-muted">Crea tu cuenta y empieza a jugar hoy.</p>
              <Link href="/register" className="cx-btn cx-btn-gold" style={{ marginTop: "1.4rem" }}>Jugar ahora <ArrowRight aria-hidden size={18} /></Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="cx-footer">
        <div className="cx-wrap cx-footer-grid">
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO} alt="Infinite Abyss" className="cx-footer-logo" />
            <p style={{ display: "flex", alignItems: "center", maxWidth: "30rem" }}><span className="cx-18" aria-label="Solo mayores de 18">18+</span>Juega con responsabilidad. El juego es entretenimiento, no una forma de ganar dinero. Prohibido para menores de edad.</p>
            {license && <p style={{ marginTop: ".8rem" }}>{license}</p>}
          </div>
          <div><h4>Jugar</h4><ul>{NAV.slice(0, 4).map((n) => <li key={n.href}><Link href={n.href}>{n.label}</Link></li>)}</ul></div>
          <div><h4>Ayuda</h4><ul><li><Link href="/webchat">Soporte 24/7</Link></li><li><Link href="/account">Mi cuenta y límites</Link></li><li><Link href="/plataforma">Para operadores</Link></li></ul></div>
        </div>
        <div className="cx-wrap cx-footer-bottom">
          <span>© {new Date().getFullYear()} Infinite Abyss</span>
          <Link href="/plataforma">¿Tienes un casino? Conoce la plataforma →</Link>
        </div>
      </footer>
    </div>
  );
}
