"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { authClient, BASE_PATH, canAccess, homeFor, NAV, ROLE_LABEL } from "@/lib/auth";
import { CurrencyProvider, OperatorProvider, useOperator, useSession } from "@/lib/hooks";
import { Button, Spinner, inputCls } from "@/components/ui";

const noop = () => () => {};

function Shell({ children, session }: { children: React.ReactNode; session: NonNullable<ReturnType<typeof useSession>> }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { operatorId, setOperatorId, known } = useOperator();
  const [draft, setDraft] = useState("");
  const items = NAV.filter((n) => n.roles.includes(session.role));
  const allowed = canAccess(session.role, "/" + pathname.split("/")[1]);

  useEffect(() => {
    if (!allowed) router.replace(homeFor(session.role));
  }, [allowed, router, session.role]);

  return (
    <div className="min-h-screen md:flex">
      <header className="flex items-center justify-between border-b border-white/10 p-3 md:hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`${BASE_PATH}/brand/infinite-abyss-logo.svg`} alt="Infinite Abyss Backoffice" className="h-8 w-auto" />
        <Button variant="ghost" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen((o) => !o)}>
          Menú
        </Button>
      </header>
      <aside id="sidebar" className={`${open ? "block" : "hidden"} border-b border-white/10 bg-black/30 p-4 md:block md:min-h-screen md:w-64 md:shrink-0 md:border-b-0 md:border-r`}>
        <div className="mb-4 hidden md:block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`${BASE_PATH}/brand/infinite-abyss-logo.svg`} alt="Infinite Abyss" className="h-9 w-auto" />
          <div className="mt-1 text-xs text-white/60">Backoffice</div>
        </div>
        <nav aria-label="Principal" className="space-y-1">
          {items.map((n) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined} className={`block rounded-md px-3 py-2 text-sm ${active ? "bg-violet-600/30 text-white" : "text-white/70 hover:bg-white/10"}`}>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          {session.role === "PLATFORM_ADMIN" ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) setOperatorId(draft);
                setDraft("");
              }}
            >
              <label htmlFor="op-select" className="text-xs text-white/60">
                Operador
              </label>
              <select id="op-select" className={`${inputCls} w-40`} value={operatorId ?? ""} onChange={(e) => setOperatorId(e.target.value)}>
                <option value="">Todos / sin elegir</option>
                {known.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input aria-label="Añadir operador" className={`${inputCls} w-32`} placeholder="Nuevo id…" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <Button type="submit" variant="ghost">
                Usar
              </Button>
            </form>
          ) : (
            <span className="text-sm text-white/70">
              Operador: <strong className="text-white">{session.operatorId}</strong>
            </span>
          )}
          <div className="flex items-center gap-3 text-xs text-white/60">
            <span className="text-right">
              {session.email && <span className="block text-white/80">{session.email}</span>}
              <span>{ROLE_LABEL[session.role]}</span>
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                authClient.logout();
                router.replace("/login");
              }}
            >
              Salir
            </Button>
          </div>
        </div>
        <main className="p-4 md:p-6">{allowed ? children : <Spinner />}</main>
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

