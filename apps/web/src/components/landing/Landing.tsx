"use client";

import { LanguageSwitcher, useT } from "@/lib/i18n";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Bot, Brain, Gamepad2, LayoutTemplate, MessagesSquare, Plug, Trophy, Users, Wallet, Workflow, type LucideIcon } from "lucide-react";
import "./landing.css";

/** Profundidad de la fosa de las Marianas: el fondo del scroll. */
const MAX_DEPTH = 10_994;
const ZONES: Array<[number, string]> = [[0, "Superficie"], [200, "Zona de luz"], [1000, "Zona crepuscular"], [4000, "Zona abisal"], [6000, "Zona hadal"]];

const MODULES: Array<{ name: string; tag: string; text: string; icon: LucideIcon; color: string }> = [
  { name: "Sonar", tag: "Inbox omnicanal", text: "WhatsApp, Telegram y el chat del casino en una sola bandeja, con etapas, notas y respuestas rápidas.", icon: MessagesSquare, color: "#3cc8f0" },
  { name: "Tide", tag: "Bots y flujos", text: "Editor visual de flujos: bienvenida, registro, depósitos y retiros guiados, sin programar.", icon: Workflow, color: "#7c8cff" },
  { name: "Pearl", tag: "Caja con IA", text: "Lee comprobantes con IA, los cruza con el banco y acredita solo. El cajero solo revisa lo dudoso.", icon: Wallet, color: "#5effd1" },
  { name: "Crew", tag: "Equipo y turnos", text: "Fichaje, turnos, tareas, caja por turno, avisos obligatorios y nómina calculada.", icon: Users, color: "#ffb86b" },
  { name: "Ascend", tag: "Gamificación del staff", text: "XP, ligas e insignias con KPIs reales: tiempo de respuesta, cargas revisadas y checklist.", icon: Trophy, color: "#f4b73f" },
  { name: "Reef", tag: "Plantillas white-label", text: "Tu casino con tu marca en minutos: plantillas, colores, secciones, SEO y vista previa antes de publicar.", icon: LayoutTemplate, color: "#ff7ad9" },
  { name: "Abyss Originals", tag: "Juegos propios", text: "Crash, Mines, Plinko, ruleta y más, provably fair, más proveedores y agregadores conectados.", icon: Gamepad2, color: "#ff5f6d" },
  { name: "Integraciones", tag: "Todo conectado", text: "Claude, proveedores de juegos, pagos cripto y alertas, desde una sola pantalla, cifrado.", icon: Plug, color: "#9be15d" },
];

const MARQUEE = ["KYC antes de retirar", "Push en iPhone y Android", "Colombia · México · Argentina", "Próximamente USA e Inglaterra", "Provably fair", "Multi-operador", "Cifrado AES-256", "Cripto y USDT", "Backoffice Abyss Command"];

function zoneFor(m: number) {
  let name = ZONES[0][1];
  for (const [d, z] of ZONES) if (m >= d) name = z;
  return name;
}

/** Nieve marina: partículas que suben al bajar, con brillo bioluminiscente en lo profundo. */
function useMarineSnow(depth: React.RefObject<number>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, lastScroll = window.scrollY;
    type P = { x: number; y: number; r: number; v: number; drift: number; glow: boolean; phase: number };
    let ps: P[] = [];
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = c.clientWidth; h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.round(Math.min(160, (w * h) / 9000));
      ps = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.8 + .3, v: Math.random() * .25 + .05, drift: Math.random() * .6 - .3, glow: Math.random() < .12, phase: Math.random() * Math.PI * 2 }));
    };
    const frame = (t: number) => {
      const scroll = window.scrollY;
      const dy = scroll - lastScroll; lastScroll = scroll;
      const d = depth.current ?? 0;
      ctx.clearRect(0, 0, w, h);
      for (const p of ps) {
        p.y -= p.v + dy * .25 * p.r; // al bajar, la nieve sube
        p.x += Math.sin(t / 2000 + p.phase) * .15 + p.drift * .2;
        if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
        if (p.y > h + 10) { p.y = -10; p.x = Math.random() * w; }
        if (p.x < -10) p.x = w + 10; else if (p.x > w + 10) p.x = -10;
        const glow = p.glow && d > .35;
        const a = glow ? .55 + .45 * Math.sin(t / 700 + p.phase) : .25 + p.r * .18;
        ctx.beginPath();
        ctx.arc(p.x, p.y, glow ? p.r * 2.2 : p.r, 0, Math.PI * 2);
        ctx.fillStyle = glow ? `rgba(94,255,209,${a})` : `rgba(200,230,255,${a * (1 - d * .4)})`;
        if (glow) { ctx.shadowColor = "rgba(94,255,209,.9)"; ctx.shadowBlur = 14; } else ctx.shadowBlur = 0;
        ctx.fill();
      }
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    resize();
    window.addEventListener("resize", resize);
    const onVis = () => { cancelAnimationFrame(raf); if (!document.hidden && !reduce) raf = requestAnimationFrame(frame); };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", onVis); };
  }, [depth]);
  return canvas;
}

/** Las secciones emergen al entrar en pantalla. */
function useReveal(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("lx-in"); io.unobserve(e.target); }
    }, { threshold: .18 });
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root]);
}

/** Cuenta hacia arriba cuando la cifra entra en pantalla. */
function Counter({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLElement>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - start) / 1400);
        setN(Math.round(to * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [to]);
  return <b ref={ref}>{n.toLocaleString("es")}{suffix}</b>;
}

const glowFollow = (e: MouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
  e.currentTarget.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
};

export function Landing({ demoUrl, contactUrl }: { demoUrl: string; contactUrl: string }) {
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);
  const depth = useRef(0);
  const [meters, setMeters] = useState(0);
  const canvas = useMarineSnow(depth);
  useReveal(root);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Profundidad por tramos: cada sección marca su cota (data-depth) y entre ellas se interpola.
        const probe = window.scrollY + 40;
        const marks = [...(root.current?.querySelectorAll<HTMLElement>("[data-depth]") ?? [])].map((el) => ({ top: el.offsetTop, m: Number(el.dataset.depth) }));
        let m = 0;
        for (let k = 0; k < marks.length; k++) {
          const a = marks[k], b = marks[k + 1];
          if (!b) { m = a.m; break; }
          if (probe < b.top) { m = a.m + (b.m - a.m) * Math.max(0, Math.min(1, (probe - a.top) / (b.top - a.top))); break; }
        }
        const d = Math.log1p(m) / Math.log1p(MAX_DEPTH);
        depth.current = d;
        root.current?.style.setProperty("--lx-depth", d.toFixed(4));
        setMeters(Math.round(m));
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(raf); window.removeEventListener("scroll", onScroll); };
  }, []);

  const i = (n: number) => ({ "--i": n }) as CSSProperties;

  return (
    <div ref={root} className="lx">
      <canvas ref={canvas} className="lx-canvas" aria-hidden />
      <div className="lx-rays" aria-hidden />

      <div className="lx-gauge" aria-hidden>
        <span className="lx-gauge-num">−{meters.toLocaleString("es")} m</span>
        <div className="lx-gauge-track"><div className="lx-gauge-fill" /></div>
        <span className="lx-gauge-zone">{t(zoneFor(meters))}</span>
      </div>

      <nav className="lx-nav" aria-label={t("Principal")}>
        <span className="lx-logo">INFINITE <b>ABYSS</b></span>
        <LanguageSwitcher className="ml-auto mr-3" />
        <a href={contactUrl} className="lx-btn lx-btn-gold">{t("Quiero mi casino")}</a>
      </nav>

      <main>
        <section className="lx-section lx-hero" data-reveal data-depth="0">
          <div>
            <p className="lx-kicker lx-reveal" style={i(0)}>{t("Plataforma de casino online · todo en uno")}</p>
            <h1 className="lx-title lx-reveal" style={i(1)}><span>{t("Infinite")}</span><span>{t("Abyss")}</span></h1>
            <p className="lx-lead lx-reveal" style={i(2)}>
              Casino, cajero con IA, CRM, bots, equipo y marca propia en una sola plataforma.
              Lánzate en días, no en meses. Baja y mira hasta dónde llega.
            </p>
            <div className="lx-cta lx-reveal" style={i(3)}>
              <a href={demoUrl} className="lx-btn lx-btn-gold">{t("Ver el casino en vivo")}</a>
              <a href="#planes" className="lx-btn lx-btn-ghost">{t("Ver planes")}</a>
            </div>
            <p className="lx-scroll lx-reveal" style={i(4)}>{t("DESCIENDE")}</p>
          </div>
        </section>

        <div className="lx-marquee" aria-label={t("Incluido en la plataforma")}>
          <div className="lx-marquee-track">{[...MARQUEE, ...MARQUEE].map((m, k) => <span key={k} aria-hidden={k >= MARQUEE.length}>{t(m)}</span>)}</div>
        </div>

        <section id="planes" className="lx-section" data-reveal data-depth="200">
          <div className="lx-wrap">
            <p className="lx-kicker lx-reveal">{t("−200 m · Zona de luz")}</p>
            <h2 className="lx-h2 lx-reveal" style={i(1)}>{t("Dos formas de entrar al abismo.")}</h2>
            <p className="lx-lead lx-reveal" style={i(2)}>{t("Empieza con un casino listo para vender o llévate la operación completa: atención, caja, equipo y marketing.")}</p>
            <div className="lx-plans">
              <article className="lx-plan lx-reveal" style={i(3)} onMouseMove={glowFollow}>
                <span className="lx-tag">{t("Casino listo")}</span>
                <h3>{t("Tu casino, tu marca")}</h3>
                <p className="lx-lead">{t("Elige una plantilla, pon tu logo y tus colores, y abre.")}</p>
                <ul>
                  <li>{t("Plantillas Reef: Golden, Emerald, Royal y Abyss")}</li>
                  <li>{t("Abyss Originals y proveedores de juegos")}</li>
                  <li>{t("Registro, KYC, depósitos y retiros")}</li>
                  <li>{t("Backoffice Abyss Command")}</li>
                  <li>{t("Tu dominio, SEO y app instalable")}</li>
                </ul>
                <a href={contactUrl} className="lx-btn lx-btn-ghost">{t("Pedir precio")}</a>
              </article>
              <article className="lx-plan lx-plan-gold lx-reveal" style={i(4)} onMouseMove={glowFollow}>
                <span className="lx-tag">{t("Kit completo")}</span>
                <h3>{t("Toda la operación")}</h3>
                <p className="lx-lead">{t("Todo lo del casino listo, más las herramientas para operarlo.")}</p>
                <ul>
                  <li>{t("Sonar: WhatsApp, Telegram y chat en una bandeja")}</li>
                  <li>{t("Tide: bots y flujos sin programar")}</li>
                  <li>{t("Pearl: cajero con IA que acredita solo")}</li>
                  <li>{t("Crew y Ascend: turnos, nómina y gamificación")}</li>
                  <li>{t("Nautilus: un operador IA que vigila 24/7")}</li>
                </ul>
                <a href={contactUrl} className="lx-btn lx-btn-gold">{t("Quiero el kit completo")}</a>
              </article>
            </div>
          </div>
        </section>

        <section className="lx-section" data-reveal data-depth="1000">
          <div className="lx-wrap">
            <p className="lx-kicker lx-reveal">{t("−1.000 m · Zona crepuscular")}</p>
            <h2 className="lx-h2 lx-reveal" style={i(1)}>{t("Cada pieza brilla en la oscuridad.")}</h2>
            <p className="lx-lead lx-reveal" style={i(2)}>{t("Módulos que trabajan juntos, con los mismos jugadores, el mismo saldo y el mismo equipo.")}</p>
            <div className="lx-mods">
              {MODULES.map((m, k) => (
                <article key={m.name} className="lx-mod lx-reveal" style={{ ...i(k + 3), "--c": m.color } as CSSProperties}>
                  <div className="lx-mod-orb"><m.icon aria-hidden className="h-5 w-5" /></div>
                  <h3><small>{t(m.tag)}</small>{m.name}</h3>
                  <p>{t(m.text)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lx-section" data-reveal data-depth="4000">
          <div className="lx-wrap">
            <p className="lx-kicker lx-reveal">{t("−4.000 m · Zona abisal")}</p>
            <h2 className="lx-h2 lx-reveal" style={i(1)}>{t("Presión de fondo marino. Cero grietas.")}</h2>
            <p className="lx-lead lx-reveal" style={i(2)}>{t("Construida para operar de verdad: cada cambio pasa cientos de pruebas antes de salir.")}</p>
            <div className="lx-stats">
              <div className="lx-stat lx-reveal" style={i(3)}><Counter to={600} suffix="+" /><span>{t("pruebas automáticas en cada cambio")}</span></div>
              <div className="lx-stat lx-reveal" style={i(4)}><Counter to={8} /><span>{t("módulos conectados entre sí")}</span></div>
              <div className="lx-stat lx-reveal" style={i(5)}><Counter to={256} /><span>{t("bits de cifrado AES para cada llave")}</span></div>
              <div className="lx-stat lx-reveal" style={i(6)}><Counter to={24} suffix="/7" /><span>{t("vigilancia con Nautilus")}</span></div>
            </div>
          </div>
        </section>

        <section className="lx-section lx-nautilus" data-reveal data-depth="10994">
          <div className="lx-wrap">
            <p className="lx-kicker lx-reveal">{t("−10.994 m · Fosa hadal")}</p>
            <div className="lx-eye lx-reveal" style={i(1)} aria-hidden />
            <h2 className="lx-h2 lx-reveal" style={i(2)}>{t("Aquí abajo vive Nautilus.")}</h2>
            <p className="lx-lead lx-reveal" style={i(3)}>
              Un operador con inteligencia artificial que mira tu casino sin parpadear: detecta fraude y abuso de bonos,
              responde a jugadores, avisa caídas y te manda el resumen del día. Lo que mueve dinero, siempre te lo pregunta.
            </p>
            <div className="lx-cta lx-reveal" style={i(4)}>
              <a href={contactUrl} className="lx-btn lx-btn-gold"><Brain aria-hidden className="h-5 w-5" />{t("Toca fondo con nosotros")}</a>
              <a href={demoUrl} className="lx-btn lx-btn-ghost"><Bot aria-hidden className="h-5 w-5" />{t("Probar la demo")}</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lx-footer">
        <span>© {new Date().getFullYear()} Infinite Abyss · Software para operadores con licencia.</span>
        <span>{t("Juego responsable · +18")}</span>
      </footer>
    </div>
  );
}
