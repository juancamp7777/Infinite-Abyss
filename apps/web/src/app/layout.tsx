import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { reefAssetUrl } from "@/lib/reefAsset";
import localFont from "next/font/local";
import "./globals.css";
import { Providers } from "@/components/Providers";

// Fuentes dentro del proyecto (src/fonts, OFL): el build no depende de Google Fonts ni el navegador del jugador
// le avisa a Google qué casino visita. Variables con todo el rango de pesos, salvo Poppins (estática).
const geistSans = localFont({ src: "../fonts/geist-latin-wght-normal.woff2", variable: "--font-geist-sans", weight: "100 900", display: "swap" });
const geistMono = localFont({ src: "../fonts/geist-mono-latin-wght-normal.woff2", variable: "--font-geist-mono", weight: "100 900", display: "swap" });
const playfair = localFont({ src: "../fonts/playfair-display-latin-wght-normal.woff2", variable: "--font-playfair", weight: "400 900", display: "swap" });
const inter = localFont({ src: "../fonts/inter-latin-wght-normal.woff2", variable: "--font-inter", weight: "100 900", display: "swap" });
const montserrat = localFont({ src: "../fonts/montserrat-latin-wght-normal.woff2", variable: "--font-montserrat", weight: "100 900", display: "swap" });
const poppins = localFont({
  src: [
    { path: "../fonts/poppins-latin-400-normal.woff2", weight: "400" },
    { path: "../fonts/poppins-latin-600-normal.woff2", weight: "600" },
    { path: "../fonts/poppins-latin-700-normal.woff2", weight: "700" },
    { path: "../fonts/poppins-latin-800-normal.woff2", weight: "800" },
  ],
  variable: "--font-poppins",
  display: "swap",
});
/** Serif romana de la marca (títulos y cifras destacadas). */
const cinzel = localFont({ src: "../fonts/cinzel-latin-wght-normal.woff2", variable: "--font-display", weight: "400 900", display: "swap" });

/** URL pública del sitio para las URLs absolutas de Open Graph (NEXT_PUBLIC_SITE_URL); sin ella, rutas relativas. */
function siteUrl(): URL | undefined {
  try {
    return process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL) : undefined;
  } catch {
    return undefined;
  }
}

const description = "Infinite Abyss: originals provably fair, tragamonedas, torneos y club VIP con juego responsable. Solo mayores de 18 años.";

// favicon (icon.svg), apple-icon.png, opengraph-image.jpg y manifest.ts se toman de app/ por convención de archivos.
const baseMetadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: "Infinite Abyss", template: "%s · Infinite Abyss" },
  description,
  applicationName: "Infinite Abyss",
  appleWebApp: { capable: true, title: "Abyss", statusBarStyle: "black-translucent" },
  openGraph: { type: "website", siteName: "Infinite Abyss", title: "Infinite Abyss", description, locale: "es_CO" },
  twitter: { card: "summary_large_image", title: "Infinite Abyss", description },
};

interface ReefSeo { config: { brand: { siteName: string; faviconUrl?: string }; seo: { title: string; description: string } } }

/** Plantilla Reef publicada para el dominio de la petición (null si no hay o el API no responde). */
async function reefSeo(): Promise<ReefSeo | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const api = (process.env.API_INTERNAL_URL || "http://localhost:4000").replace(/\/+$/, "");
    const r = await fetch(`${api}/reef/v1/site?host=${encodeURIComponent(host)}`, { next: { revalidate: 30 }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return ((await r.json()) as { site: ReefSeo | null }).site;
  } catch {
    return null;
  }
}

/** Título, descripción y favicon del operador según su dominio (white-label); si no publicó, la marca Infinite Abyss. */
export async function generateMetadata(): Promise<Metadata> {
  const site = await reefSeo();
  if (!site) return baseMetadata;
  const { brand, seo } = site.config;
  const title = seo.title || brand.siteName;
  const favicon = reefAssetUrl(brand.faviconUrl);
  return {
    ...baseMetadata,
    title: { default: title, template: `%s · ${brand.siteName}` },
    description: seo.description,
    applicationName: brand.siteName,
    appleWebApp: { capable: true, title: brand.siteName, statusBarStyle: "black-translucent" },
    openGraph: { type: "website", siteName: brand.siteName, title, description: seo.description, locale: "es_CO" },
    twitter: { card: "summary_large_image", title, description: seo.description },
    ...(favicon ? { icons: { icon: favicon } } : {}),
  };
}

export const viewport: Viewport = {
  themeColor: "#050d1c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} ${cinzel.variable} ${inter.variable} ${poppins.variable} ${montserrat.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-jetblack text-foreground font-sans"><Providers>{children}</Providers></body>
    </html>
  );
}
