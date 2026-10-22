"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import { SiteFooter } from "./SiteFooter";

/** Rutas que exigen sesión de jugador. /admin tiene su propio login de backoffice. */
const PROTECTED = ["/lobby/vip", "/slots", "/roulette", "/blackjack", "/mines", "/crash", "/plinko", "/cashier", "/account"];

function isProtected(pathname: string) {
  return PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function Guard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useAuth();
  const needsAuth = isProtected(pathname);

  useEffect(() => {
    if (needsAuth && status === "anonymous") {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [needsAuth, status, pathname, router]);

  if (needsAuth && status !== "authenticated") {
    return (
      <div role="status" aria-live="polite" className="flex-1 flex items-center justify-center text-gray-400 p-10">
        Verificando sesión…
      </div>
    );
  }
  return <>{children}</>;
}

function ThemeBanner() {
  const { status, error, reload } = useTheme();
  if (status !== "error") return null;
  return (
    <div role="alert" className="bg-red-950/60 border-b border-red-900 text-red-200 text-sm px-4 py-2 flex items-center justify-center gap-3">
      <span>No se pudo cargar la marca de la sala ({error}). Se usa el tema por defecto.</span>
      <button onClick={reload} className="underline font-bold">
        Reintentar
      </button>
    </div>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-black focus:text-white focus:p-3">
          Saltar al contenido
        </a>
        <ThemeBanner />
        <div id="main" className="flex-1 flex flex-col">
          <Guard>{children}</Guard>
        </div>
        <SiteFooter />
      </AuthProvider>
    </ThemeProvider>
  );
}
