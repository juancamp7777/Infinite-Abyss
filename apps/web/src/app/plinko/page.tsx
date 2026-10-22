"use client";

import { QuickBets } from "@/components/QuickBets";
import { useState, useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Coins } from "lucide-react";
import { minorToInput } from "../../lib/money";
import { useCasino } from "../../hooks/useCasino";
import { casinoSDK } from "../../lib/CasinoSDK";

type PlinkoRisk = "LOW" | "MEDIUM" | "HIGH";
type PlinkoRows = 8 | 12 | 16;

export default function PlinkoPage() {
  const { balance, money, betMinorOf, defaultBetText, presets, currency, decimals } = useCasino();
  // Apuesta inicial: primer monto rápido del operador (null = sin editar).
  const [betEdited, setBetAmount] = useState<string | null>(null);
  const betAmount = betEdited ?? defaultBetText;
  const betMinor = betMinorOf(betAmount);
  const [rows, setRows] = useState<PlinkoRows>(16);
  const [risk, setRisk] = useState<PlinkoRisk>("HIGH");
  
  const [isDropping, setIsDropping] = useState(false);
  const [lastWin, setLastWin] = useState<bigint | null>(null);
  const [lastMultiplier, setLastMultiplier] = useState<number | null>(null);
  
  // Array of active balls falling
  const [balls, setBalls] = useState<Array<{id: string, path: string[], x: number, y: number, progress: number}>>([]);
  
  // UI Grid generation
  const bins = rows + 1;

  const handleDrop = async () => {
    if (betMinor === null || betMinor <= BigInt(0) || betMinor > balance || isDropping) return;
    
    setIsDropping(true);
    setLastWin(null);
    setLastMultiplier(null);
    
    try {
      const res = await casinoSDK.dropPlinko(betMinor, rows, risk);
      
      // Simulate ball falling with timeout
      setBalls(prev => [...prev, {
        id: Math.random().toString(),
        path: res.result.path,
        x: 50, // Start center %
        y: 0,
        progress: 0
      }]);

      // Simple pseudo-animation duration
      const animDuration = rows * 200; // 200ms per row
      
      setTimeout(() => {
        setLastMultiplier(res.result.multiplier);
        setLastWin(res.payout);
        setIsDropping(false);
      }, animDuration);
      
    } catch (e: unknown) {
      console.error(e);
      setIsDropping(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0510] text-gray-200 font-sans flex flex-col items-center">
      <header className="w-full max-w-6xl p-6 flex justify-between items-center border-b border-fuchsia-900/30">
        <Link href="/classic" className="flex items-center gap-2 text-fuchsia-500 hover:text-fuchsia-400 transition-colors">
          <ArrowLeft className="w-5 h-5" />
          <span className="font-serif tracking-widest uppercase text-sm">Lobby</span>
        </Link>
        <div className="flex items-center gap-4 bg-black/50 px-4 py-2 rounded-full border border-fuchsia-500/20 shadow-[0_0_15px_rgba(217,70,239,0.1)]">
          <Coins className="w-5 h-5 text-gold-400" />
          <span className="font-mono text-xl font-bold text-white">
            {money(balance)}
          </span>
        </div>
      </header>

      <main className="w-full max-w-6xl flex-1 p-6 flex flex-col md:flex-row gap-8">
        
        {/* Controls Panel */}
        <div className="w-full md:w-80 bg-[#120a1a] border border-fuchsia-900/50 rounded-2xl p-6 flex flex-col gap-6 shadow-[0_0_40px_rgba(217,70,239,0.05)] h-fit">
          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Monto de apuesta</label>
            <QuickBets amounts={presets} currency={currency} decimals={decimals} disabled={isDropping} onPick={(v) => setBetAmount(minorToInput(v, decimals, currency))} />
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="decimal"
                aria-label="Monto de apuesta"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                className="w-full bg-black border border-fuchsia-900/50 rounded-lg p-3 text-white font-mono text-lg focus:outline-none focus:border-fuchsia-500 transition-colors"
              />
              <button onClick={() => betMinor !== null && setBetAmount(minorToInput(betMinor * BigInt(2), decimals, currency))} className="bg-fuchsia-900/30 hover:bg-fuchsia-600/50 text-fuchsia-300 rounded-lg px-3 font-bold transition-colors">2x</button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Nivel de riesgo</label>
            <div className="flex rounded-lg overflow-hidden border border-fuchsia-900/50">
              {['LOW', 'MEDIUM', 'HIGH'].map(r => (
                <button
                  key={r}
                  onClick={() => setRisk(r as PlinkoRisk)}
                  className={`flex-1 py-2 text-xs font-bold transition-colors ${risk === r ? 'bg-fuchsia-600 text-white' : 'bg-black text-gray-500 hover:bg-fuchsia-900/30'}`}
                >
                  {({ LOW: 'BAJO', MEDIUM: 'MEDIO', HIGH: 'ALTO' } as Record<string, string>)[String(r)] ?? r}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Filas</label>
            <div className="flex rounded-lg overflow-hidden border border-fuchsia-900/50">
              {[8, 12, 16].map(r => (
                <button
                  key={r}
                  onClick={() => setRows(r as PlinkoRows)}
                  className={`flex-1 py-2 text-xs font-bold transition-colors ${rows === r ? 'bg-fuchsia-600 text-white' : 'bg-black text-gray-500 hover:bg-fuchsia-900/30'}`}
                >
                  {({ LOW: 'BAJO', MEDIUM: 'MEDIO', HIGH: 'ALTO' } as Record<string, string>)[String(r)] ?? r}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleDrop}
            disabled={isDropping || betMinor === null || balance < betMinor}
            className="mt-4 w-full bg-gradient-to-r from-fuchsia-600 to-purple-600 hover:from-fuchsia-500 hover:to-purple-500 text-white font-bold py-4 rounded-xl shadow-[0_0_20px_rgba(217,70,239,0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed transform hover:-translate-y-1 active:translate-y-0"
          >
            {isDropping ? "CAYENDO…" : "APOSTAR"}
          </button>
        </div>

        {/* Plinko Board */}
        <div className="flex-1 flex flex-col items-center justify-center bg-[#0d0714] border border-fuchsia-900/20 rounded-2xl p-8 relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-fuchsia-900/10 via-transparent to-transparent"></div>
          
          <div className="relative w-full max-w-2xl flex flex-col items-center">
            
            {/* Pseudo-Board Triangle (Visual Representation only since Canvas is complex for simple demo) */}
            <div className="flex flex-col items-center gap-1 mb-8" style={{ marginTop: '20px' }}>
              {Array.from({ length: rows }).map((_, rowIndex) => (
                <div key={rowIndex} className="flex gap-4">
                  {Array.from({ length: rowIndex + 3 }).map((_, pegIndex) => (
                    <div key={pegIndex} className="w-2 h-2 rounded-full bg-white/20 shadow-[0_0_5px_rgba(255,255,255,0.2)]"></div>
                  ))}
                </div>
              ))}
            </div>

            {/* Bins / Multipliers Display at the bottom */}
            <div className="flex w-full justify-center gap-1 px-4">
              {Array.from({ length: bins }).map((_, i) => {
                // Color scaling based on distance from center
                const center = rows / 2;
                const distance = Math.abs(i - center);
                const isEdge = distance > center * 0.7;
                const isCenter = distance < center * 0.3;
                
                let bgColor = "bg-fuchsia-900/50";
                if (isEdge) bgColor = "bg-red-500";
                else if (isCenter) bgColor = "bg-purple-800";
                else bgColor = "bg-orange-500";

                return (
                  <div key={i} className={`flex-1 h-8 rounded-sm ${bgColor} flex items-center justify-center text-[10px] font-bold shadow-lg opacity-80`}>
                    {/* Real multiplier logic is in backend, this is just visual placeholder to show board exists */}
                    x
                  </div>
                );
              })}
            </div>

            {lastWin !== null && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center animate-bounce z-20">
                <div className="text-6xl font-black text-white drop-shadow-[0_0_20px_rgba(217,70,239,1)]">
                  {lastMultiplier}x
                </div>
                <div className="text-2xl font-bold text-green-400 mt-2">
                  +{money(lastWin)}
                </div>
              </div>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
