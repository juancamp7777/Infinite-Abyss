import type { Metadata } from "next";
import { BASE_PATH } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Infinite Abyss Backoffice", template: "%s · Infinite Abyss Backoffice" },
  description: "Panel de plataforma y operadores de Infinite Abyss",
  robots: { index: false, follow: false },
  icons: { icon: `${BASE_PATH}/brand/infinite-abyss-mark.svg`, apple: `${BASE_PATH}/brand/infinite-abyss-mark.svg` },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
