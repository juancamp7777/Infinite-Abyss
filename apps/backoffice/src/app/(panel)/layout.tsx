"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Activity, BarChart3, ChevronDown, Crown, FileBarChart, Gamepad2, Gift, Layers, LayoutDashboard, LifeBuoy, LogOut, Megaphone, Menu, MessagesSquare, RadioTower, Workflow, Banknote, Clock3, UsersRound,
  Bot, LayoutTemplate, Palette, Plug, ShieldCheck, Trophy, Users, X, Zap, type LucideIcon,
} from "lucide-react";
import { authClient, BASE_PATH, canAccess, homeFor, NAV, NAV_SECTIONS, ROLE_LABEL, type NavSection } from "@/lib/auth";
import { CurrencyProvider, OperatorProvider, useOperator, useSession } from "@/lib/hooks";
import { Spinner, inputCls } from "@/components/ui";
import { CrewNotices } from "@/components/CrewNotices";

const noop = () => () => {};
const COLLAPSED_KEY = "abyss.bo.collapsedSections";

const ICON: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboard, "/metrics": Activity, "/reports": FileBarChart, "/integrations": Plug, "/nautilus": Bot, "/security": ShieldCheck, "/players": Users, "/inbox": MessagesSquare, "/channels": RadioTower, "/tide": Workflow, "/pearl": Banknote, "/crew": Clock3, "/crew-admin": UsersRound, "/tickets": LifeBuoy, "/segments": Layers,
  "/campaigns": Megaphone, "/bonuses": Gift, "/tournaments": Trophy, "/jackpots": Zap, "/vip": Crown,
  "/catalog": Gamepad2, "/studios": BarChart3, "/reef": LayoutTemplate, "/skin": Palette,
};

/** Secciones plegadas del menú, recordadas en este navegador. */
function useCollapsed(): [Set<NavSection>, (s: NavSection) => void] {
  const [set, setSet] = useState<Set<NavSection>>(new Set());
  useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      if (Array.isArray(raw)) setSet(new Set(raw.filter((x): x is NavSection => NAV_SECTIONS.includes(x))));
    } catch { /* almacenamiento bloqueado o corrupto */ }
  }, []);
  const toggle = (s: NavSection) => setSet((cur) => {
    const next = new Set(cur);
    if (next.has(s)) next.delete(s); else next.add(s);
    try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* almacenamiento bloqueado */ }
    return next;
  });
  return [set, toggle];
}

/** Ids largos (UUID) se acortan a 8 caracteres; el completo queda en el title. */
const shortId = (id: string | null) => (id && id.length > 12 ? `${id.slice(0, 8)}…` : id ?? "");

const initials = (email?: string) => (email ?? "").split("@")[0].split(/[._-]/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "IA";

function Shell({ children, session }: { children: React.ReactNode; session: NonNullable<ReturnType<typeof useSession>> }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [collapsed, toggleSection] = useCollapsed();
  const { operatorId, setOperatorId, known } = useOperator();
  const items = NAV.filter((n) => n.roles.includes(session.role));
  const allowed = canAccess(session.role, "/" + pathname.split("/")[1]);
  const current = items.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));

  useEffect(() => {
    if (!allowed) router.replace(homeFor(session.role));
  }, [allowed, router, session.role]);
  useEffect(() => setOpen(false), [pathname]);

  const logout = () => {
    authClient.logout();
    router.replace("/login");
  };

  const renderSidebar = (prefix: string) => (
    <>
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE_PATH}/brand/infinite-abyss-mark.svg`} alt="" className="h-9 w-9" />
        <div className="leading-tight">
          <div className="text-sm font-bold text-white">Infinite Abyss</div>
          <div className="text-[10px] font-semibold uppercase tracking-[.18em] text-brand">Abyss Command</div>
        </div>
      </div>
      <nav aria-label="Principal" className="flex-1 space-y-3 overflow-y-auto p-3">
        {NAV_SECTIONS.map((section) => {
          const list = items.filter((n) => n.section === section);
          if (list.length === 0) return null;
          const isCollapsed = collapsed.has(section);
          const id = `${prefix}-nav-${section}`;
          return (
            <div key={section}>
              <button
                type="button" onClick={() => toggleSection(section)} aria-expanded={!isCollapsed} aria-controls={id}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-[.16em] text-white/40 hover:text-white/70"
              >
                {section}
                <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
              </button>
              <ul id={id} hidden={isCollapsed} className="mt-1 space-y-0.5">
                {list.map((n) => {
                  const active = n === current;
                  const Icon = ICON[n.href] ?? LayoutDashboard;
                  return (
                    <li key={n.href}>
                      <Link
                        href={n.href} aria-current={active ? "page" : undefined}
                        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${active ? "bg-brand/15 text-white shadow-[inset_3px_0_0_var(--color-brand)]" : "text-white/65 hover:bg-white/5 hover:text-white"}`}
                      >
                        <Icon aria-hidden className={`h-4 w-4 shrink-0 ${active ? "text-brand" : ""}`} />
                        {n.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="flex items-center gap-3 border-t border-white/10 p-3">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand2 to-sky-600 text-sm font-bold text-ink">{initials(session.email)}</span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold text-white">{session.email ?? "Sesión de desarrollo"}</div>
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-brand2">{ROLE_LABEL[session.role]}</div>
        </div>
        <button type="button" onClick={logout} aria-label="Cerrar sesión" className="grid h-8 w-8 place-items-center rounded-md text-white/60 hover:bg-white/10 hover:text-white">
          <LogOut aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-white/10 bg-panel/90 lg:flex">{renderSidebar("desk")}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div aria-hidden className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside id="sidebar" role="dialog" aria-modal="true" aria-label="Menú" className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-white/10 bg-panel">
            <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar menú" className="absolute right-3 top-4 grid h-8 w-8 place-items-center rounded-md text-white/70 hover:bg-white/10">
              <X aria-hidden className="h-4 w-4" />
            </button>
            {renderSidebar("drawer")}
          </aside>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/10 bg-background/85 px-4 backdrop-blur md:px-6">
          <button type="button" className="grid h-9 w-9 place-items-center rounded-md border border-white/10 text-white/80 hover:bg-white/10 lg:hidden" aria-expanded={open} aria-controls="sidebar" aria-label="Abrir menú" onClick={() => setOpen(true)}>
            <Menu aria-hidden className="h-4 w-4" />
          </button>
          <div className="min-w-0 text-sm text-white/50">
            <span className="hidden sm:inline">Abyss Command / </span><span className="font-semibold text-white">{current?.label ?? "Panel"}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {session.role === "PLATFORM_ADMIN" ? (
              <div className="flex items-center gap-2">
                <label htmlFor="op-select" className="hidden text-xs text-white/60 sm:block">Operador</label>
                <select id="op-select" className={`${inputCls} w-40 sm:w-52`} value={operatorId ?? ""} onChange={(e) => setOperatorId(e.target.value)}>
                  <option value="">Todos (vista de plataforma)</option>
                  {known.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                  {operatorId && !known.some((k) => k.id === operatorId) && <option value={operatorId}>{operatorId}</option>}
                </select>
              </div>
            ) : (
              <span className="rounded-md border border-white/10 bg-panel px-3 py-1.5 text-xs text-white/70">
                Operador <strong className="font-mono text-white" title={session.operatorId ?? undefined}>{shortId(session.operatorId)}</strong>
              </span>
            )}
          </div>
        </div>
        {session.role === "PLATFORM_ADMIN" && session.mfaEnabled === false && pathname !== "/security" && (
          <div role="alert" className="mx-auto mt-4 max-w-[1400px] px-4 md:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <span><strong>Tu cuenta tiene el máximo poder y todavía no tiene verificación en dos pasos.</strong> Actívala en 1 minuto.</span>
              <Link href="/security" className="rounded-md bg-amber-400 px-3 py-1.5 font-semibold text-black">Activar ahora</Link>
            </div>
          </div>
        )}
        <main className="mx-auto max-w-[1400px] p-4 md:p-6">{allowed ? children : <Spinner />}</main>
        <CrewNotices />
      </div>
    </div>
  );
}

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const session = useSession();
  const router = useRouter();

  useEffect(() => {
    if (mounted && !session) router.replace("/login");
  }, [mounted, session, router]);

  // El access token vence (sin refresh en el API de backoffice): al llegar la hora se vuelve al login.
  const expiresAt = session?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const ms = Math.min(Math.max(expiresAt - Date.now(), 0), 2_147_000_000);
    const t = window.setTimeout(() => authClient.expire(), ms);
    return () => window.clearTimeout(t);
  }, [expiresAt]);

  if (!mounted || !session) return <Spinner label="Verificando sesión…" />;
  return (
    <OperatorProvider>
      <CurrencyProvider>
        <Shell session={session}>{children}</Shell>
      </CurrencyProvider>
    </OperatorProvider>
  );
}
