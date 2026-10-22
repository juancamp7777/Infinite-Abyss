"use client";
import { useEffect, useState } from "react";
import { API_URL } from "./api";
import { reefAssetUrl } from "./reefAsset";

/** Plantilla white-label publicada del operador (módulo Reef de la API). */
export type ReefFont = "cinzel" | "playfair" | "inter" | "poppins" | "montserrat" | "geist";
export type ReefSection = "hero" | "tiles" | "providers" | "last_wins" | "originals" | "slots" | "popular" | "new" | "live" | "live_bets" | "tournaments";
export interface ReefConfig {
  template: "abyss" | "golden" | "emerald" | "royal";
  brand: { siteName: string; logoUrl?: string; faviconUrl?: string };
  colors: { primary: string; secondary: string; background: string; surface: string; text: string; accent: string };
  fonts: { display: ReefFont; body: ReefFont };
  layout: { nav: "sidebar" | "topbar"; cards: "square" | "portrait"; radius: "sm" | "md" | "lg" | "xl" };
  home: { sections: Array<{ key: ReefSection; visible: boolean }> };
  banners: Array<{ title: string; subtitle?: string; cta?: string; href: string; imageUrl?: string }>;
  seo: { title: string; description: string };
  footer: { about: string; socials: Array<{ type: string; url: string }>; legal: string; license: string };
}
export interface ReefSite { operatorId: string; version: number | null; preview: boolean; config: ReefConfig }

const FONT_VAR: Record<ReefFont, string> = {
  cinzel: "var(--font-display)", playfair: "var(--font-playfair)", inter: "var(--font-inter)",
  poppins: "var(--font-poppins)", montserrat: "var(--font-montserrat)", geist: "var(--font-geist-sans)",
};
const RADIUS = { sm: ".375rem", md: ".6rem", lg: ".85rem", xl: "1.15rem" } as const;

/** Variables CSS de la plantilla (tipografías y radios) para el contenedor del lobby. */
export function reefStyle(c: ReefConfig | undefined): Record<string, string> {
  if (!c) return {};
  return { "--nf-font-display": FONT_VAR[c.fonts.display], "--nf-font-body": FONT_VAR[c.fonts.body], "--nf-radius": RADIUS[c.layout.radius] };
}

/** Rutas del sitio que se permiten en banners y redes: https absoluta o ruta interna. */
export const safeHref = (v: string) => (/^https:\/\//i.test(v) || /^\/(?!\/)/.test(v) ? v : "#");

/** Imágenes subidas (rutas del API) → URL servida por el API. */
function withAssetUrls(site: ReefSite): ReefSite {
  const c = site.config;
  return {
    ...site,
    config: {
      ...c,
      brand: { ...c.brand, logoUrl: reefAssetUrl(c.brand.logoUrl), faviconUrl: reefAssetUrl(c.brand.faviconUrl) },
      banners: c.banners.map((b) => ({ ...b, imageUrl: reefAssetUrl(b.imageUrl) })),
    },
  };
}

const PREVIEW_KEY = "abyss.reef.preview";
let cached: { key: string; promise: Promise<ReefSite | null> } | null = null;

function previewToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("reef_preview");
    if (fromUrl) window.sessionStorage.setItem(PREVIEW_KEY, fromUrl);
    return window.sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
}

/** Carga (una vez por pestaña) el sitio publicado, o el borrador si la URL trae ?reef_preview=<token firmado>. */
export function loadReefSite(operatorId?: string): Promise<ReefSite | null> {
  const preview = previewToken();
  const q = new URLSearchParams();
  if (operatorId) q.set("operatorId", operatorId);
  else if (typeof window !== "undefined") q.set("host", window.location.host);
  if (preview) q.set("preview", preview);
  const key = q.toString();
  if (cached?.key === key) return cached.promise;
  const promise = fetch(`${API_URL}/reef/v1/site?${key}`, { cache: preview ? "no-store" : "default" })
    .then((r) => (r.ok ? (r.json() as Promise<{ site: ReefSite | null }>) : { site: null }))
    .then((j) => j.site && withAssetUrls(j.site))
    .catch(() => null);
  cached = { key, promise };
  return promise;
}

/** undefined = cargando · null = el operador no publicó plantilla (se usa la marca de siempre). */
export function useReefSite(operatorId?: string | null): ReefSite | null | undefined {
  const [site, setSite] = useState<ReefSite | null | undefined>(undefined);
  useEffect(() => {
    if (operatorId === null) return; // todavía no se sabe el operador
    let alive = true;
    void loadReefSite(operatorId).then((s) => alive && setSite(s));
    return () => {
      alive = false;
    };
  }, [operatorId]);
  return site;
}
