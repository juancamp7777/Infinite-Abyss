"use client";

import { minorToInput } from "@/lib/money";
import { QuickBets } from "@/components/QuickBets";
import { useState } from "react";
import Link from "next/link";
import { Coins, Bomb, Diamond, Wifi, WifiOff } from "lucide-react";
import { casinoSDK, MinesSession } from "../../lib/CasinoSDK";
import { useCasino } from "../../hooks/useCasino";

export default function MinesDashboard() {
  const { balance, isConnected, money, betMinorOf, defaultBetText, presets, currency, decimals } = useCasino();
  const [session, setSession] = useState<MinesSession | null>(null);
  const [numMines, setNumMines] = useState(3);
  // Apuesta inicial: primer monto rápido del operador (null = sin editar).
  const [betEdited, setBetAmount] = useState<string | null>(null);
  const betAmount = betEdited ?? defaultBetText;
  const betMinor = betMinorOf(betAmount);
  const [isLoading, setIsLoading] = useState(false);
  const [winAmount, setWinAmount] = useState<bigint | null>(null);

  const startGame = async () => {
    if (isLoading || !isConnected) return;
    setIsLoading(true);
    setWinAmount(null);
    try {
      const res = await casinoSDK.startMines(betMinor ?? BigInt(0), numMines);
      setSession(res.session);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const revealCell = async (index: number) => {
    if (isLoading || !isConnected || !session || session.status === 'FINISHED' || session.revealed[index]) return;
    setIsLoading(true);
    try {
      const res = await casinoSDK.revealMine(session.id, index);
      setSession(res.session);
      if (res.session.status === 'FINISHED' && res.payout > 0) {
        setWinAmount(res.payout);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const cashout = async () => {
    if (isLoading || !isConnected || !session || session.status === 'FINISHED' || session.revealedDiamonds === 0) return;
    setIsLoading(true);
    try {
      const res = await casinoSDK.cashoutMines(session.id);
      setSession(res.session);
      setWinAmount(res.payout);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const renderCell = (index: number) => {
    if (!session) {
      return (
        <div key={index} className="w-12 h-12 sm:w-16 sm:h-16 bg-[#2a2e38] rounded-md shadow-inner border border-white/5 opacity-50"></div>
      );
    }

    const isRevealed = session.revealed[index];
    const isGameOver = session.status === 'FINISHED';
    let content = null;
    let cellClass = "bg-[#2a2e38] hover:bg-[#323742] hover:-translate-y-1 cursor-pointer transition-all border border-white/10 shadow-[0_4px_6px_rgba(0,0,0,0.3)]";

    if (isRevealed || isGameOver) {
      const isMine = session.grid[index];
      
      if (isMine) {
        content = <Bomb className={`w-8 h-8 ${isRevealed ? 'text-red-500 animate-bounce' : 'text-gray-600 opacity-50'}`} />;
        cellClass = isRevealed ? "bg-red-950/50 border-red-500 shadow-[inset_0_0_15px_rgba(239,68,68,0.5)]" : "bg-[#1a1c23] border-white/5";
      } else if (isRevealed || isGameOver) {
        // If not a mine, it's a diamond. Only show diamond if revealed, or if game over and we want to show what was missed
        const showDiamond = isRevealed || (!isMine && isGameOver);
        if (showDiamond) {
          content = <Diamond className={`w-8 h-8 ${isRevealed ? 'text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.8)]' : 'text-gray-600 opacity-30'}`} />;
          cellClass = isRevealed ? "bg-cyan-950/30 border-cyan-500/50" : "bg-[#1a1c23] border-white/5";
        }
      }
    }

    return (
      <button 
        key={index}
        onClick={() => revealCell(index)}
        disabled={isRevealed || isGameOver || isLoading}
        className={`w-12 h-12 sm:w-16 sm:h-16 rounded-md flex items-center justify-center ${cellClass} disabled:cursor-not-allowed`}
      >
        {content}
      </button>
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden bg-[#0f1115]">
      <div className="absolute inset-0 z-0 opacity-30 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-purple-900/20 via-[#0f1115] to-[#0f1115]"></div>
      
      <div className="absolute top-6 left-6 z-20">
        <Link href="/classic" className="text-gray-400 hover:text-white transition-colors uppercase tracking-widest text-xs font-serif border border-white/10 px-4 py-2 rounded-lg bg-black/50">
          ← Back
        </Link>
      </div>

      <div className="absolute top-6 right-6 z-20 flex gap-4">
        <div className="flex items-center gap-2 bg-[#1a1c23] px-4 py-2 rounded-lg border border-white/10">
          <Coins className="w-4 h-4 text-gold-400" />
          <span className="font-mono text-white">{money(balance)}</span>
        </div>
        {isConnected ? (
          <div className="flex items-center gap-2 text-xs font-mono text-green-400 bg-green-400/10 px-3 py-1.5 rounded-lg border border-green-400/20">
            <Wifi className="w-3 h-3" />
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-mono text-red-500 bg-red-500/10 px-3 py-1.5 rounded-lg border border-red-500/20">
            <WifiOff className="w-3 h-3" />
          </div>
        )}
      </div>

      <div className="z-10 w-full max-w-4xl flex flex-col md:flex-row gap-8 mt-16">
        
        {/* Sidebar Controls */}
        <div className="w-full md:w-80 bg-[#1a1c23] p-6 rounded-2xl border border-white/5 flex flex-col gap-6 shadow-2xl">
          <h1 className="font-serif text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
            <Bomb className="text-purple-500" /> MINES
          </h1>

          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Monto de apuesta</label>
            <QuickBets amounts={presets} currency={currency} decimals={decimals} disabled={isLoading} onPick={(v) => setBetAmount(minorToInput(v, decimals, currency))} />
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input 
                type="text" 
                inputMode="decimal"
                aria-label="Monto de apuesta"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                disabled={session?.status === 'ACTIVE'}
                className="w-full bg-[#0f1115] border border-white/10 rounded-lg py-3 pl-8 pr-4 text-white font-mono focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Minas (1-24)</label>
            <select 
              value={numMines}
              onChange={(e) => setNumMines(Number(e.target.value))}
              disabled={session?.status === 'ACTIVE'}
              className="w-full bg-[#0f1115] border border-white/10 rounded-lg py-3 px-4 text-white font-mono focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
            >
              {[...Array(24)].map((_, i) => (
                <option key={i+1} value={i+1}>{i+1}</option>
              ))}
            </select>
          </div>

          <div className="mt-auto pt-6 border-t border-white/5">
            {(!session || session.status === 'FINISHED') ? (
              <button 
                onClick={startGame}
                disabled={isLoading || !isConnected}
                className="w-full bg-purple-600 hover:bg-purple-500 text-white font-bold py-4 rounded-xl uppercase tracking-widest transition-all hover:shadow-[0_0_20px_rgba(147,51,234,0.4)] disabled:opacity-50"
              >
                Apostar
              </button>
            ) : (
              <button 
                onClick={cashout}
                disabled={isLoading || !isConnected || session.revealedDiamonds === 0}
                className="w-full bg-green-500 hover:bg-green-400 text-black font-bold py-4 rounded-xl uppercase tracking-widest transition-all hover:shadow-[0_0_20px_rgba(34,197,94,0.4)] disabled:opacity-50 flex flex-col items-center justify-center gap-1"
              >
                <span>Retirar</span>
                {session.revealedDiamonds > 0 && (
                  <span className="text-xs font-mono bg-black/20 px-2 py-0.5 rounded">
                    {money(((betMinor ?? BigInt(0)) * BigInt(Math.round(session.multiplier * 1e6))) / BigInt(1000000))}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Game Area */}
        <div className="flex-1 bg-[#15171e] rounded-2xl border border-white/5 p-8 flex flex-col items-center justify-center relative shadow-inner">
          
          {winAmount !== null && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none">
              <div className="text-4xl md:text-6xl font-bold text-green-400 drop-shadow-[0_0_30px_rgba(34,197,94,0.8)] animate-bounce whitespace-nowrap bg-black/80 px-8 py-4 rounded-2xl border border-green-500/30">
                +{money(winAmount)}
              </div>
            </div>
          )}

          <div className="w-full flex justify-between items-center mb-8 px-4">
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest">Multiplicador</span>
              <span className="text-2xl font-mono font-bold text-white">
                {session ? session.multiplier.toFixed(2) : '1.00'}x
              </span>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest">Diamantes</span>
              <div className="flex items-center gap-1">
                <Diamond className="w-4 h-4 text-cyan-400" />
                <span className="text-xl font-mono font-bold text-cyan-400">
                  {session ? session.revealedDiamonds : 0}
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-5 gap-2 sm:gap-3 p-4 bg-[#0f1115] rounded-xl border border-white/5">
            {[...Array(25)].map((_, i) => renderCell(i))}
          </div>

        </div>

      </div>
    </div>
  );
}
