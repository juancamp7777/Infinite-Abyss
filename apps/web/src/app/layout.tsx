import type { Metadata, Viewport } from "next";
import { Cinzel, Geist, Geist_Mono, Playfair_Display } from "next/font/google";
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
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: "Infinite Abyss", template: "%s · Infinite Abyss" },
  description,
  applicationName: "Infinite Abyss",
  appleWebApp: { capable: true, title: "Abyss", statusBarStyle: "black-translucent" },
  openGraph: { type: "website", siteName: "Infinite Abyss", title: "Infinite Abyss", description, locale: "es_CO" },
  twitter: { card: "summary_large_image", title: "Infinite Abyss", description },
};

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
      className={`${geistSans.variable} ${geistMono.variable} ${playfair.variable} ${cinzel.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-jetblack text-foreground font-sans"><Providers>{children}</Providers></body>
    </html>
  );
}
