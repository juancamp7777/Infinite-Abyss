"use client";

import { useState } from "react";
import Link from "next/link";
import { Coins, MonitorPlay, Wifi, WifiOff } from "lucide-react";
import { casinoSDK } from "../../lib/CasinoSDK";
import { useCasino } from "../../hooks/useCasino";

export default function SlotsDashboard() {
  const { balance, isConnected, money, demoBet } = useCasino();
  const [reels, setReels] = useState<string[]>(['CHERRY', 'CHERRY', 'CHERRY']);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winAmount, setWinAmount] = useState<bigint | null>(null);

  const spin = async () => {
    if (isSpinning || !isConnected) return;
    setIsSpinning(true);
    setWinAmount(null);

    // Start visual spinning
    const interval = setInterval(() => {
      setReels([
        ['CHERRY', 'LEMON', 'ORANGE', 'PLUM', 'BELL', 'BAR', 'SEVEN'][Math.floor(Math.random() * 7)],
        ['CHERRY', 'LEMON', 'ORANGE', 'PLUM', 'BELL', 'BAR', 'SEVEN'][Math.floor(Math.random() * 7)],
        ['CHERRY', 'LEMON', 'ORANGE', 'PLUM', 'BELL', 'BAR', 'SEVEN'][Math.floor(Math.random() * 7)]
      ]);
    }, 100);

    try {
      const { result, payout } = await casinoSDK.playSlots(demoBet); // apuesta fija de demo: segundo monto rápido del operador
      
      // Stop visual spin after 2 seconds
      setTimeout(() => {
        clearInterval(interval);
        setReels(result.reels);
        setIsSpinning(false);
        if (payout > 0) {
          setWinAmount(payout);
          setTimeout(() => setWinAmount(null), 3000);
        }
      }, 2000);
    } catch (e) {
      clearInterval(interval);
      setIsSpinning(false);
      console.error(e);
    }
  };

  const getSymbolEmoji = (sym: string) => {
    switch (sym) {
      case 'SEVEN': return '7️⃣';
      case 'BAR': return '🍫';
      case 'BELL': return '🔔';
      case 'PLUM': return '🍇';
      case 'ORANGE': return '🍊';
      case 'LEMON': return '🍋';
      case 'CHERRY': return '🍒';
      default: return '❓';
    }
  };

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

      <div className="z-10 w-full max-w-2xl flex flex-col items-center gap-8 mt-12">
        <header className="w-full flex justify-between items-center metallic-panel px-8 py-6 rounded-2xl">
          <div className="flex items-center gap-4">
            <MonitorPlay className="w-8 h-8 text-gold-500" />
            <h1 className="font-serif text-2xl font-bold tracking-widest text-gold-gradient uppercase">
              Lucky Sevens
            </h1>
          </div>
          
          <div className={`flex items-center gap-4 bg-black/80 px-6 py-3 rounded-xl border border-gold-500/30 transition-all ${winAmount !== null ? 'animate-god-glow border-gold-400' : ''}`}>
            <Coins className={`w-6 h-6 ${winAmount !== null ? 'text-yellow-300' : 'text-gold-400'}`} />
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Saldo</span>
              <span className="font-serif text-2xl text-gold-gradient tracking-wider">
                {money(balance)}
              </span>
            </div>
          </div>
        </header>

        <div className="metallic-panel p-8 rounded-3xl w-full flex flex-col items-center gap-12 relative shadow-[0_0_50px_rgba(212,175,55,0.1)]">
          {winAmount !== null && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none">
              <div className="text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600 drop-shadow-[0_0_30px_rgba(255,215,0,0.8)] animate-bounce whitespace-nowrap">
                WIN {money(winAmount)}!
              </div>
            </div>
          )}

          <div className="flex gap-4 p-6 bg-black rounded-xl border-4 border-gold-600 shadow-inner">
            {reels.map((sym, i) => (
              <div key={i} className="w-24 h-32 md:w-32 md:h-40 bg-white rounded-lg flex items-center justify-center text-6xl md:text-8xl shadow-[inset_0_10px_20px_rgba(0,0,0,0.5)] relative overflow-hidden">
                <div className={`absolute transition-transform ${isSpinning ? 'animate-pulse blur-[2px]' : ''}`}>
                  {getSymbolEmoji(sym)}
                </div>
              </div>
            ))}
          </div>

          <button 
            onClick={spin}
            disabled={isSpinning || !isConnected}
            className="w-48 h-16 bg-gradient-to-b from-red-600 to-red-900 hover:from-red-500 hover:to-red-800 rounded-full border-4 border-gold-500 shadow-[0_10px_0_#450a0a,0_15px_20px_rgba(0,0,0,0.5)] active:shadow-[0_0px_0_#450a0a,0_0px_0_rgba(0,0,0,0.5)] active:translate-y-2 transition-all flex items-center justify-center disabled:opacity-50 disabled:active:shadow-[0_10px_0_#450a0a,0_15px_20px_rgba(0,0,0,0.5)] disabled:active:translate-y-0"
          >
            <span className="font-serif text-2xl font-bold text-white uppercase tracking-widest drop-shadow-md">
              SPIN $100
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
