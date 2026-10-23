"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, Crown, Gamepad2, Headphones, HeartHandshake, ShieldCheck, Sparkles, Trophy, Wallet, Zap } from "lucide-react";
import { useGames, useJackpots } from "@/lib/lobby/hooks";
import { LiveFeedProvider, useLiveBets } from "@/lib/lobby/liveBets";
import { formatMoney, hueOf, initials, toNumber } from "@/lib/lobby/format";
import type { Game, GameQuery } from "@/lib/lobby/types";
import "./casino-landing.css";

export interface CasinoLandingProps {
  /** Texto del bono de bienvenida (LANDING_BONUS). Sin configurar no se muestra ninguna oferta. */
  bonus?: string;
  /** Texto de la licencia para el pie (LANDING_LICENSE). */
  license?: string;
}

const NAV = [
  { href: "/lobby", label: "Casino" },
  { href: "/lobby/category/live", label: "En vivo" },
  { href: "/lobby/category/slots", label: "Slots" },
  { href: "/lobby/category/originals", label: "Originals" },
  { href: "/lobby/tournaments", label: "Torneos" },
  { href: "/lobby/vip", label: "VIP" },
];

const TABS: Array<{ key: string; label: string; query: GameQuery; more: string }> = [
  { key: "popular", label: "Populares", query: { sort: "popular", pageSize: 12 }, more: "/lobby/category/popular" },
  { key: "new", label: "Nuevos", query: { sort: "new", pageSize: 12 }, more: "/lobby/category/new" },
  { key: "slots", label: "Slots", query: { category: "slots", sort: "popular", pageSize: 12 }, more: "/lobby/category/slots" },
  { key: "originals", label: "Originals", query: { category: "originals", sort: "popular", pageSize: 12 }, more: "/lobby/category/originals" },
  { key: "live", label: "En vivo", query: { category: "live", sort: "popular", pageSize: 12 }, more: "/lobby/category/live" },
  { key: "table", label: "Mesa", query: { category: "table", sort: "popular", pageSize: 12 }, more: "/lobby/category/table" },
];

const TIER_LABEL: Record<string, string> = { mini: "MINI", minor: "MENOR", major: "MAYOR", grand: "GRAN", mega: "MEGA" };
const tierLabel = (key: string) => TIER_LABEL[key.toLowerCase()] ?? key.toUpperCase();

const TRUST = [
  { icon: Zap, title: "Retiros rápidos", text: "Tu dinero vuelve a tu cuenta sin vueltas, con verificación una sola vez." },
  { icon: Wallet, title: "Cripto y métodos locales", text: "USDT y los medios de pago de tu país, en tu moneda." },
  { icon: Headphones, title: "Soporte 24/7", text: "Personas reales en el chat del casino, a cualquier hora." },
  { icon: HeartHandshake, title: "Juego responsable", text: "Límites, pausas y autoexclusión cuando los necesites. Solo +18." },
];

/** Hilos de luz morados y dorados que ondulan detrás del hero (se pausa fuera de pantalla y con movimiento reducido). */
function useLightStrands() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const strands = Array.from({ length: 26 }, (_, i) => ({
      gold: i % 5 === 0,
      amp: 0.08 + Math.random() * 0.14,
      freq: 0.6 + Math.random() * 1.4,
      speed: 0.12 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
      offset: (i / 26 - 0.5) * 0.5,
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

/** Revela con suavidad los bloques .cx-reveal al entrar en pantalla. */
function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".cx-reveal");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("cx-in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function GameTile({ game }: { game: Game }) {
  const [broken, setBroken] = useState(false);
  const src = game.images.thumb || game.images.banner;
  return (
    <Link href={`/lobby/game/${game.id}`} className="cx-game" aria-label={`Jugar ${game.title}`}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      ) : (
        <div aria-hidden style={{ aspectRatio: "3 / 4", display: "grid", placeItems: "center", fontWeight: 900, fontSize: "2rem", background: `linear-gradient(160deg, hsl(${hueOf(game.title)} 70% 35%), #0b0816)` }}>{initials(game.title)}</div>
      )}
      {game.isNew && <span className="cx-badge">NUEVO</span>}
      <span className="cx-game-meta"><b>{game.title}</b><span>{game.providerName}</span></span>
    </Link>
  );
}

function Lobby() {
  const [tab, setTab] = useState(TABS[0]);
  const { items, loading, error } = useGames(tab.query);
  return (
    <section id="lobby" className="cx-section">
      <div className="cx-wrap">
        <div className="cx-head cx-reveal">
          <div><p className="cx-kicker">Lobby</p><h2 className="cx-h2">Elige tu próxima jugada</h2></div>
          <Link href={tab.more} className="cx-btn cx-btn-ghost cx-btn-sm">Ver todos <ArrowRight aria-hidden size={16} /></Link>
        </div>
        <div className="cx-tabs" role="tablist" aria-label="Categorías">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab.key} className="cx-tab" onClick={() => setTab(t)}>{t.label}</button>
          ))}
        </div>
        <div className="cx-games" role="tabpanel" aria-busy={loading}>
          {loading && items.length === 0 && Array.from({ length: 6 }, (_, i) => <div key={i} className="cx-skel" />)}
          {items.map((g) => <GameTile key={g.id} game={g} />)}
        </div>
        {!loading && items.length === 0 && <p className="cx-lead" style={{ marginTop: "1rem" }}>{error ? "No pudimos cargar los juegos ahora mismo." : "Muy pronto habrá juegos en esta categoría."} <Link href="/lobby" style={{ color: "var(--cx-gold)" }}>Ir al lobby</Link></p>}
      </div>
    </section>
  );
}

/** Cinta de ganadores reales del feed en vivo (nombres ya enmascarados por el servidor). */
function Winners() {
  const { lists } = useLiveBets();
  const wins = useMemo(() => {
    const seen = new Set<string>();
    return [...lists.high, ...lists.lucky, ...lists.all]
      .filter((b) => toNumber(b.win) > toNumber(b.amount) && !seen.has(b.id) && seen.add(b.id))
      .slice(0, 16);
  }, [lists]);
  if (wins.length === 0) return null;
  const row = wins.map((b) => (
    <span key={b.id} className="cx-win"><Trophy aria-hidden size={14} color="#f4b73f" /><strong>{b.player}</strong> ganó <b>{formatMoney(b.win, b.currency)}</b> en {b.gameTitle}</span>
  ));
  return (
    <div className="cx-winners" aria-label="Ganadores recientes">
      <div className="cx-winners-track">{row}<span aria-hidden style={{ display: "contents" }}>{row.map((r) => <span key={`d${r.key}`} className="cx-win">{r.props.children}</span>)}</span></div>
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
          <span className="cx-chip cx-reveal"><i aria-hidden />Casino en vivo · Argentina · Brasil · Colombia · México</span>
          <h1 className="cx-h1 cx-reveal" style={{ "--i": 1 } as CSSProperties}>Juega en <em>otra dimensión.</em></h1>
          <p className="cx-lead cx-reveal" style={{ "--i": 2 } as CSSProperties}>Slots, mesas en vivo y nuestros Originals provably fair. Deposita en tu moneda, juega desde el celular y retira rápido.</p>
          <div className="cx-cta cx-reveal" style={{ "--i": 3 } as CSSProperties}>
            <Link href="/register" className="cx-btn cx-btn-gold">Jugar ahora <ArrowRight aria-hidden size={18} /></Link>
            {bonus
              ? <Link href="/register" className="cx-btn cx-btn-ghost"><Sparkles aria-hidden size={18} />{bonus}</Link>
              : <Link href="/lobby" className="cx-btn cx-btn-ghost"><Gamepad2 aria-hidden size={18} />Ver juegos</Link>}
          </div>
          <div className="cx-proof cx-reveal" style={{ "--i": 4 } as CSSProperties}>
            <span><Zap aria-hidden size={16} />Retiros rápidos</span>
            <span><ShieldCheck aria-hidden size={16} />Provably fair</span>
            <span><HeartHandshake aria-hidden size={16} />Solo +18</span>
          </div>
        </div>
        <div className="cx-ring cx-reveal" style={{ "--i": 2 } as CSSProperties}>
          <span className="cx-orbit" aria-hidden />
          <div className="cx-ring-in" aria-live="polite">
            {top ? (
              <><small>{top.name} JACKPOT</small><strong>{formatMoney(top.amount, top.currency)}</strong><span>Crece con cada apuesta</span></>
            ) : (
              <><small>ABYSS CASINO</small><strong><Crown aria-hidden size={56} color="#ffd978" /></strong><span>Slots · En vivo · Originals</span></>
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
    <section className="cx-section" style={{ paddingBottom: 0 }}>
      <div className="cx-wrap">
        <div className="cx-head cx-reveal"><div><p className="cx-kicker">Jackpots en vivo</p><h2 className="cx-h2">{j.name}</h2></div></div>
        <div className="cx-jps">
          {levels.map((l, i) => (
            <div key={l.key} className={`cx-jp cx-reveal${i === levels.length - 1 ? " cx-jp-top" : ""}`} style={{ "--i": i } as CSSProperties}>
              <small>{tierLabel(l.key)}</small><strong>{formatMoney(l.amount, j.currency)}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function CasinoLanding({ bonus, license }: CasinoLandingProps) {
  useReveal();
  return (
    <LiveFeedProvider>
      <div className="cx">
        <nav className="cx-nav" aria-label="Principal">
          <div className="cx-wrap cx-nav-in">
            <Link href="/" className="cx-brand"><Crown aria-hidden size={20} color="#f4b73f" />ABYSS <b>CASINO</b></Link>
            <div className="cx-links">{NAV.map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}</div>
            <div className="cx-auth">
              <Link href="/login" className="cx-btn cx-btn-ghost cx-btn-sm">Ingresar</Link>
              <Link href="/register" className="cx-btn cx-btn-gold cx-btn-sm">Registrarse</Link>
            </div>
          </div>
        </nav>

        <main>
          <Hero bonus={bonus} />
          <Winners />
          <Jackpots />
          <Lobby />

          <section className="cx-section" style={{ paddingTop: 0 }}>
            <div className="cx-wrap cx-duo">
              <Link href="/lobby/tournaments" className="cx-feature cx-reveal" style={{ "--c1": "rgb(139 92 246 / .45)" } as CSSProperties}>
                <Trophy aria-hidden className="cx-feature-icon" />
                <p className="cx-kicker">Torneos</p>
                <h3>Compite cada semana</h3>
                <p>Suma puntos jugando tus juegos favoritos, sube en la tabla en vivo y llévate premios reales.</p>
                <span className="cx-btn cx-btn-gold cx-btn-sm" style={{ alignSelf: "flex-start" }}>Ver torneos <ArrowRight aria-hidden size={16} /></span>
              </Link>
              <Link href="/lobby/vip" className="cx-feature cx-reveal" style={{ "--c1": "rgb(244 183 63 / .35)", "--i": 1 } as CSSProperties}>
                <Crown aria-hidden className="cx-feature-icon" />
                <p className="cx-kicker">Club VIP</p>
                <h3>Cada jugada te sube de nivel</h3>
                <p>Rakeback, bonos y beneficios que crecen contigo, desde tu primer depósito.</p>
                <span className="cx-btn cx-btn-ghost cx-btn-sm" style={{ alignSelf: "flex-start" }}>Conocer el VIP <ArrowRight aria-hidden size={16} /></span>
              </Link>
            </div>
          </section>

          <section className="cx-section" style={{ paddingTop: 0 }}>
            <div className="cx-wrap">
              <div className="cx-trust cx-reveal">
                {TRUST.map(({ icon: Icon, title, text }) => <div key={title}><Icon aria-hidden size={26} /><b>{title}</b><p>{text}</p></div>)}
              </div>
            </div>
          </section>

          <section className="cx-section" style={{ paddingTop: 0 }}>
            <div className="cx-wrap">
              <div className="cx-b2b cx-reveal">
                <p><strong>¿Tienes un casino o quieres lanzar uno?</strong> Este casino corre sobre Infinite Abyss: tu marca, tu caja con IA y tu equipo en una sola plataforma.</p>
                <Link href="/plataforma" className="cx-btn cx-btn-ghost cx-btn-sm">Conocer la plataforma <ArrowRight aria-hidden size={16} /></Link>
              </div>
            </div>
          </section>
        </main>

        <footer className="cx-footer">
          <div className="cx-wrap cx-footer-grid">
            <div>
              <p className="cx-brand" style={{ marginBottom: ".8rem" }}><Crown aria-hidden size={18} color="#f4b73f" />ABYSS <b>CASINO</b></p>
              <p style={{ display: "flex", alignItems: "center", maxWidth: "30rem" }}><span className="cx-18" aria-label="Solo mayores de 18">18+</span>Juega con responsabilidad. El juego es entretenimiento, no una forma de ganar dinero.</p>
              {license && <p style={{ marginTop: ".8rem" }}>{license}</p>}
            </div>
            <div><h4>Jugar</h4><ul>{NAV.slice(0, 4).map((n) => <li key={n.href}><Link href={n.href}>{n.label}</Link></li>)}</ul></div>
            <div><h4>Ayuda</h4><ul><li><Link href="/webchat">Soporte 24/7</Link></li><li><Link href="/account">Mi cuenta</Link></li><li><Link href="/plataforma">Para operadores</Link></li></ul></div>
          </div>
          <div className="cx-wrap" style={{ marginTop: "2rem" }}>© {new Date().getFullYear()} Abyss Casino · Infinite Abyss</div>
        </footer>
      </div>
    </LiveFeedProvider>
  );
}
