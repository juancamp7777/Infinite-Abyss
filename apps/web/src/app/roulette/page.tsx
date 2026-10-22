"use client";

import { useEffect, useState } from "react";
import { Coins, RotateCw, Wifi, WifiOff } from "lucide-react";
import { useCasino } from "../../hooks/useCasino";
import Link from "next/link";

export default function RouletteDashboard() {
  const { balance, isSpinning, lastResult, isConnected, placeBet, money, demoBet } = useCasino();
  const [winAnimation, setWinAnimation] = useState<boolean>(false);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (lastResult && BigInt(lastResult.payout ?? "0") > BigInt(0)) {
      // Small delay to prevent synchronous setState warning during render phase
      timer = setTimeout(() => {
        setWinAnimation(true);
        setTimeout(() => setWinAnimation(false), 2000);
      }, 10);
    }
    return () => clearTimeout(timer);
  }, [lastResult]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden bg-jetblack">
      <div className="absolute inset-0 z-0 opacity-20 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gold-600/10 via-jetblack to-jetblack"></div>
      
      <div className="absolute top-6 left-6 z-20">
        <Link href="/classic" className="text-gold-500 hover:text-gold-300 transition-colors uppercase tracking-widest text-xs font-serif border border-gold-500/30 px-4 py-2 rounded-lg bg-black/50">
          ← Back to Lobby
        </Link>
      </div>

      <div className="absolute top-6 right-6 z-20">
        {isConnected ? (
          <div className="flex items-center gap-2 text-xs font-mono text-green-500 bg-green-500/10 px-3 py-1.5 rounded-full border border-green-500/20">
            <Wifi className="w-3 h-3" /> <span className="uppercase tracking-widest">Conectado</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-mono text-red-500 bg-red-500/10 px-3 py-1.5 rounded-full border border-red-500/20">
            <WifiOff className="w-3 h-3" /> <span className="uppercase tracking-widest">Reconectando…</span>
          </div>
        )}
      </div>

      <div className="z-10 w-full max-w-5xl flex flex-col gap-12 mt-12">
        <header className="flex flex-col md:flex-row justify-between items-center metallic-panel px-8 py-6 rounded-2xl gap-6">
          <div className="flex flex-col items-center md:items-start">
            <h1 className="font-serif text-3xl font-bold tracking-widest text-gold-gradient uppercase">
              Sovereign Roulette
            </h1>
            <p className="text-gray-500 text-xs tracking-[0.3em] uppercase mt-1">Suite primera clase</p>
          </div>
          
          <div className={`flex items-center gap-5 bg-black/80 px-8 py-4 rounded-xl border border-gold-500/30 transition-all duration-300 ${winAnimation ? 'animate-god-glow scale-105 border-gold-400' : 'shadow-[0_0_15px_rgba(212,175,55,0.05)]'}`}>
            <Coins className={`w-8 h-8 ${winAnimation ? 'text-yellow-300' : 'text-gold-400'}`} />
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Saldo disponible</span>
              <span className="font-serif text-3xl text-gold-gradient tracking-wider">
                {money(balance)}
              </span>
            </div>
          </div>
        </header>

        <main className="flex flex-col lg:flex-row gap-16 items-center justify-center">
          <div className="relative w-80 h-80 lg:w-96 lg:h-96 flex items-center justify-center rounded-full metallic-panel p-4 shadow-[0_0_60px_rgba(212,175,55,0.1)]">
            <div className={`w-full h-full rounded-full border-[12px] border-black relative flex items-center justify-center overflow-hidden transition-all shadow-[inset_0_0_20px_rgba(0,0,0,1)] ${isSpinning ? 'animate-spin-slow' : ''}`}>
              <div className="absolute inset-0 bg-[conic-gradient(#1A1A1A_0deg_45deg,#7f1d1d_45deg_90deg,#1A1A1A_90deg_135deg,#7f1d1d_135deg_180deg,#1A1A1A_180deg_225deg,#7f1d1d_225deg_270deg,#1A1A1A_270deg_315deg,#7f1d1d_315deg_360deg)] opacity-60"></div>
              
              <div className="z-20 bg-gradient-to-b from-[#111] to-[#000] w-52 h-52 lg:w-64 lg:h-64 rounded-full flex flex-col items-center justify-center border-4 border-gold-600/50 shadow-[inset_0_4px_20px_rgba(0,0,0,0.8)] relative">
                {lastResult ? (
                  <div className="flex flex-col items-center">
                    <span className={`font-serif text-6xl lg:text-7xl font-bold drop-shadow-lg ${lastResult.color === 'red' ? 'text-red-600' : lastResult.color === 'black' ? 'text-gray-200' : 'text-green-500'}`}>
                      {lastResult.number}
                    </span>
                    <span className="uppercase text-[10px] tracking-[0.2em] mt-3 text-gold-500">
                      {lastResult.color}
                    </span>
                    {BigInt(lastResult.payout ?? "0") > BigInt(0) && (
                      <span className="absolute -bottom-6 bg-gold-gradient text-black font-bold text-xs px-3 py-1 rounded-full tracking-widest uppercase animate-bounce">
                        Ganas +{money(BigInt(lastResult.payout ?? "0"))}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center opacity-60">
                    <RotateCw className={`w-12 h-12 text-gold-500 ${isSpinning ? 'animate-spin' : ''}`} />
                    <span className="uppercase text-[9px] tracking-widest mt-4 text-gold-500">
                      {isSpinning ? 'Girando…' : 'Haz tus apuestas'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-6 w-full max-w-md">
            <div className="metallic-panel p-8 rounded-2xl flex flex-col gap-8 relative overflow-hidden">
              <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-gold-400/30 to-transparent"></div>
              
              <h2 className="font-serif text-lg text-gold-500 uppercase tracking-[0.3em] text-center border-b border-gold-500/10 pb-4">
                Place Your Bets
              </h2>
              
              <div className="grid grid-cols-2 gap-4">
                <button 
                  onClick={() => placeBet('color', 'red', demoBet)}
                  disabled={isSpinning || !isConnected}
                  className="group relative bg-red-950/40 hover:bg-red-900/60 border border-red-900/50 text-white py-6 rounded-xl transition-all disabled:opacity-50 font-serif overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xl tracking-widest text-red-500">ROJO</span>
                    <span className="text-xs text-gray-500 font-sans tracking-wider">$1,000</span>
                  </div>
                </button>
                <button 
                  onClick={() => placeBet('color', 'black', demoBet)}
                  disabled={isSpinning || !isConnected}
                  className="group relative bg-black hover:bg-[#111] border border-gray-800 text-white py-6 rounded-xl transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] disabled:opacity-50 font-serif overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-xl tracking-widest text-gray-300">NEGRO</span>
                    <span className="text-xs text-gray-500 font-sans tracking-wider">$1,000</span>
                  </div>
                </button>
              </div>

              <div className="flex flex-col gap-3">
                <label className="text-[10px] text-gray-500 uppercase tracking-widest text-center">
                  Straight Up (Pays 35:1)
                </label>
                <button 
                  onClick={() => placeBet('pleno', 7, demoBet)}
                  disabled={isSpinning || !isConnected}
                  className="group relative w-full bg-gradient-to-b from-[#222] to-[#111] hover:from-[#2a2a2a] hover:to-[#1a1a1a] border border-gold-600/30 text-gold-400 py-5 rounded-xl transition-all disabled:opacity-50 font-serif shadow-[0_5px_15px_rgba(0,0,0,0.5)]"
                >
                  <div className="absolute inset-0 bg-gradient-to-b from-gold-400/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity rounded-xl"></div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-lg tracking-[0.2em] text-gold-300">APUESTA AL 7 DE LA SUERTE</span>
                    <span className="text-xs text-gold-500/70 font-sans tracking-wider">$500</span>
                  </div>
                </button>
              </div>
              
              <div className="h-6 flex items-center justify-center">
                {isSpinning ? (
                  <span className="text-gold-500/80 text-xs tracking-[0.3em] uppercase animate-pulse">
                    No va más…
                  </span>
                ) : (
                  <span className="text-gray-600 text-[10px] tracking-widest uppercase">
                    Esperando tu jugada
                  </span>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
