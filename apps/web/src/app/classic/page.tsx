"use client";

import Link from "next/link";
import { Coins, CircleDot, Spade } from "lucide-react";
import { useCasino } from "@/hooks/useCasino";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { BrandLogo } from "@/components/SiteFooter";

/** Juegos clásicos de la Fase 1 (apuestas con la billetera de fichas). El lobby principal es /lobby. */
export default function ClassicGames() {
  const { balance, money } = useCasino();
  const { brand, operator } = useTheme();
  const { status, logout } = useAuth();
  const name = brand.displayName || operator.name;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden bg-jetblack">
      <div className="absolute inset-0 z-0 opacity-20 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gold-600/10 via-jetblack to-jetblack"></div>
      
      <div className="z-10 w-full max-w-5xl flex flex-col items-center gap-16 mt-8">
        <header className="flex flex-col items-center gap-4 text-center">
          <Link href="/cashier" aria-label="Cajero" className="w-16 h-16 bg-gold-gradient rounded-full flex items-center justify-center mb-2 shadow-[0_0_30px_rgba(212,175,55,0.4)] cursor-pointer hover:scale-110 transition-transform">
            <Coins className="w-8 h-8 text-black" aria-hidden="true" />
          </Link>
          <h1 className="font-serif text-5xl md:text-7xl font-bold tracking-widest text-gold-gradient uppercase">
            {name}
          </h1>
          <h2 className="text-gold-300 text-lg tracking-widest uppercase">Juegos clásicos</h2>
          <p className="text-gold-500/80 text-sm md:text-base tracking-[0.4em] uppercase">
            Juego responsable · Diversión segura
          </p>

          {status === "authenticated" ? (
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <div className="flex items-center gap-4 bg-black/60 px-6 py-3 rounded-full border border-gold-500/20">
                <span className="text-xs text-gray-400 uppercase tracking-widest">Saldo</span>
                <span className="font-serif text-2xl text-gold-300" aria-live="polite">{money(balance)}</span>
              </div>
              <nav aria-label="Cuenta" className="flex items-center gap-3 text-sm">
                <Link href="/cashier" className="px-4 py-2 rounded-full bg-gold-gradient text-black font-bold">Cajero</Link>
                <Link href="/account" className="px-4 py-2 rounded-full border border-gold-500/40 text-gold-300">Mi cuenta</Link>
                <button onClick={() => void logout()} className="px-4 py-2 rounded-full border border-gray-700 text-gray-300">Salir</button>
              </nav>
            </div>
          ) : (
            <div className="mt-8 flex items-center gap-3">
              <Link href="/login" className="px-6 py-3 rounded-full border border-gold-500/40 text-gold-300 font-bold">Iniciar sesión</Link>
              <Link href="/register" className="px-6 py-3 rounded-full bg-gold-gradient text-black font-bold">Crear cuenta</Link>
            </div>
          )}
          <Link href="/lobby" className="px-5 py-2 rounded-full border border-gold-500/40 text-gold-300 text-sm font-bold">← Volver al lobby</Link>
          <div className="sr-only"><BrandLogo /></div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full max-w-6xl">
          <Link href="/crash" className="group relative metallic-panel rounded-3xl p-6 flex flex-col items-center gap-4 overflow-hidden transition-all hover:scale-105 hover:border-gold-400 cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-b from-blue-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="w-20 h-20 rounded-full border-4 border-blue-900/50 flex items-center justify-center bg-black shadow-inner">
              <span className="text-3xl font-bold group-hover:-translate-y-2 transition-transform">🚀</span>
            </div>
            <div className="text-center">
              <h2 className="font-serif text-xl text-gold-300 uppercase tracking-widest mb-1">Crash</h2>
              <p className="text-[10px] text-gray-500 tracking-wider uppercase">Multijugador en vivo</p>
            </div>
          </Link>

          <Link href="/plinko" className="group relative metallic-panel rounded-3xl p-6 flex flex-col items-center gap-4 overflow-hidden transition-all hover:scale-105 hover:border-gold-400 cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-b from-fuchsia-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="w-20 h-20 rounded-full border-4 border-fuchsia-900/50 flex items-center justify-center bg-black shadow-inner">
              <span className="text-3xl text-fuchsia-500 font-bold group-hover:animate-bounce transition-transform">🎯</span>
            </div>
            <div className="text-center">
              <h2 className="font-serif text-xl text-gold-300 uppercase tracking-widest mb-1">Plinko</h2>
              <p className="text-[10px] text-gray-500 tracking-wider uppercase">Comprobablemente justo</p>
            </div>
          </Link>

          <Link href="/mines" className="group relative metallic-panel rounded-3xl p-6 flex flex-col items-center gap-4 overflow-hidden transition-all hover:scale-105 hover:border-gold-400 cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-b from-purple-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="w-20 h-20 rounded-full border-4 border-purple-900/50 flex items-center justify-center bg-black shadow-inner">
              <span className="text-3xl text-purple-500 font-bold group-hover:rotate-12 transition-transform">💣</span>
            </div>
            <div className="text-center">
              <h2 className="font-serif text-xl text-gold-300 uppercase tracking-widest mb-1">Mines</h2>
              <p className="text-[10px] text-gray-500 tracking-wider uppercase">Cuadrícula estratégica</p>
            </div>
          </Link>

          <Link href="/roulette" className="group relative metallic-panel rounded-3xl p-6 flex flex-col items-center gap-4 overflow-hidden transition-all hover:scale-105 hover:border-gold-400 cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-b from-red-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="w-20 h-20 rounded-full border-4 border-red-900/50 flex items-center justify-center bg-black shadow-inner">
              <CircleDot className="w-10 h-10 text-red-500 group-hover:animate-spin-slow" />
            </div>
            <div className="text-center">
              <h2 className="font-serif text-xl text-gold-300 uppercase tracking-widest mb-1">Roulette</h2>
              <p className="text-[10px] text-gray-500 tracking-wider uppercase">Europea</p>
            </div>
          </Link>

          <Link href="/blackjack" className="group relative metallic-panel rounded-3xl p-6 flex flex-col items-center gap-4 overflow-hidden transition-all hover:scale-105 hover:border-gold-400 cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-b from-green-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div className="w-20 h-20 rounded-full border-4 border-green-900/50 flex items-center justify-center bg-black shadow-inner">
              <Spade className="w-10 h-10 text-gray-300 group-hover:text-white transition-colors" />
            </div>
            <div className="text-center">
              <h2 className="font-serif text-xl text-gold-300 uppercase tracking-widest mb-1">Blackjack</h2>
              <p className="text-[10px] text-gray-500 tracking-wider uppercase">Paga 3 a 2</p>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}
