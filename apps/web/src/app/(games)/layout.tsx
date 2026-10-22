import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = { title: 'Nymfo Studios', robots: { index: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false, themeColor: '#020617' };

/** Grupo (games): pantalla completa, sin cabecera ni pie; apto para iframe del Hub. */
export default function GamesLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh w-full overflow-hidden bg-slate-950">{children}</div>;
}
