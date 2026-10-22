'use client';
import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { AccountMenu } from './AccountMenu';
import { CategoryNav } from './CategoryNav';
import { LobbyProvider, useLobby } from './LobbyProvider';
import { SearchBox } from './SearchBox';
import { VipProgressBar } from './VipProgressBar';

function Shell({ children }: { children: ReactNode }) {
  const { skin, vip } = useLobby();
  return (
    <div className="flex min-h-screen">
      <a href="#nf-main" className="nf-skip">Saltar al contenido</a>
      <aside className="nf-side hidden w-56 shrink-0 flex-col gap-4 p-3 lg:flex">
        <Link href="/lobby" className="flex items-center gap-2 px-2 py-1 text-xl font-extrabold">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={skin.logoUrl || '/brand/nymfo-logo.svg'} alt={`Logotipo de ${skin.name}`} width={130} height={32} className="h-8 w-auto" />
        </Link>
        <CategoryNav variant="sidebar" />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="nf-top sticky top-0 z-30 flex items-center gap-3 px-3 py-2">
          <Link href="/lobby" className="flex items-center lg:hidden" aria-label={`Ir al lobby de ${skin.name}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={skin.logoUrl || '/brand/nymfo-logo.svg'} alt={`Logotipo de ${skin.name}`} width={104} height={26} className="h-[26px] w-auto" />
          </Link>
          <Suspense fallback={<div className="w-full max-w-md" />}><SearchBox /></Suspense>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden md:block"><VipProgressBar vip={vip} compact /></div>
            <AccountMenu />
          </div>
        </header>
        <main id="nf-main" className="flex-1 space-y-6 p-3 pb-24 sm:p-5 lg:pb-6">{children}</main>
      </div>
      <div className="nf-bottom fixed inset-x-0 bottom-0 z-30 lg:hidden"><CategoryNav variant="bottom" /></div>
    </div>
  );
}

export function LobbyShell({ children }: { children: ReactNode }) {
  return <LobbyProvider><Shell>{children}</Shell></LobbyProvider>;
}
