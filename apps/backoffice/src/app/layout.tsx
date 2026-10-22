import type { Metadata } from "next";
import { BASE_PATH } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Nymfo Backoffice", template: "%s · Nymfo Backoffice" },
  description: "Panel de plataforma y operadores de Nymfo Casino",
  robots: { index: false, follow: false },
  icons: { icon: `${BASE_PATH}/brand/nymfo-mark.svg`, apple: `${BASE_PATH}/brand/nymfo-mark.svg` },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
