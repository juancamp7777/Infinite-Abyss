import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { reefAssetUrl } from "@/lib/reefAsset";
import { Cinzel, Geist, Geist_Mono, Inter, Montserrat, Playfair_Display, Poppins } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
});

/** Serif romana de la marca (títulos y cifras destacadas). */
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["400", "600", "700", "800"], display: "swap" });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"], weight: ["400", "600", "700", "800", "900"], display: "swap" });

const cinzel = Cinzel({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
});

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
