"use client";

import { minorToInput } from "@/lib/money";
import { QuickBets } from "@/components/QuickBets";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Coins, Rocket, Wifi, WifiOff } from "lucide-react";
import { casinoSDK } from "../../lib/CasinoSDK";
import { useCasino } from "../../hooks/useCasino";

export default function CrashDashboard() {
  const { balance, isConnected, money, betMinorOf, defaultBetText, presets, currency, decimals } = useCasino();
  // Apuesta inicial: primer monto rápido del operador (null = sin editar).
  const [betEdited, setBetAmount] = useState<string | null>(null);
  const betAmount = betEdited ?? defaultBetText;
  const betMinor = betMinorOf(betAmount);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cashedOut, setCashedOut] = useState(false);
  const [winAmount, setWinAmount] = useState<bigint | null>(null);

  // Sync with global SDK state
  const [crashState, setCrashState] = useState(casinoSDK.crashState);
  const [multiplier, setMultiplier] = useState(casinoSDK.crashMultiplier);
  const [nextTime, setNextTime] = useState(casinoSDK.crashNextTime);

  useEffect(() => {
    const unsubscribe = casinoSDK.subscribe(() => {
      setCrashState(casinoSDK.crashState);
      setMultiplier(casinoSDK.crashMultiplier);
      setNextTime(casinoSDK.crashNextTime);
      
      // Reset local state when a new game starts
      if (casinoSDK.crashState === 'WAITING' && crashState === 'CRASHED') {
        setSessionId(null);
        setCashedOut(false);
        setWinAmount(null);
      }
    });
    return () => { unsubscribe(); };
  }, [crashState]);

  const placeBet = async () => {
    if (isLoading || !isConnected || crashState !== 'WAITING') return;
    setIsLoading(true);
    setWinAmount(null);
    try {
      const res = await casinoSDK.placeCrashBet(betMinor ?? BigInt(0));
      setSessionId(res.session.id);
      setCashedOut(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const cashout = async () => {
    if (isLoading || !isConnected || crashState !== 'CRASHING' || !sessionId || cashedOut) return;
    setIsLoading(true);
    try {
      const res = await casinoSDK.cashoutCrash(sessionId);
      setCashedOut(true);
      setWinAmount(res.payout);
    } catch (e) {
      console.error(e);
      // If we failed to cashout (e.g. it crashed exactly when we clicked)
      if (casinoSDK.crashState === 'CRASHED') {
        setSessionId(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Generate a smooth curve for the chart based on the multiplier
  const calculateCurveHeight = () => {
    // Math logic to make it look like a rising curve
    // Max height at e.g. 10x, but scales
    if (crashState === 'WAITING') return 0;
    const progress = Math.min(100, (Math.log(multiplier) / Math.log(10)) * 100);
    return progress;
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden bg-[#0b0e14]">
      {/* Dynamic Background based on state */}
      <div className={`absolute inset-0 z-0 opacity-20 transition-colors duration-1000 ${
        crashState === 'CRASHED' ? 'bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-red-900/40 via-[#0b0e14] to-[#0b0e14]' :
        crashState === 'CRASHING' ? 'bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-[#0b0e14] to-[#0b0e14]' :
        'bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-gray-900/20 via-[#0b0e14] to-[#0b0e14]'
      }`}></div>
      
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

      <div className="z-10 w-full max-w-5xl flex flex-col md:flex-row gap-8 mt-16 h-[600px]">
        
        {/* Sidebar Controls */}
        <div className="w-full md:w-80 bg-[#1a1c23] p-6 rounded-2xl border border-white/5 flex flex-col gap-6 shadow-2xl h-full">
          <h1 className="font-serif text-2xl font-bold text-white uppercase tracking-widest flex items-center gap-2">
            <Rocket className="text-blue-500" /> CRASH
          </h1>

          <div className="flex flex-col gap-2">
            <label className="text-xs text-gray-400 uppercase tracking-wider font-semibold">Monto de apuesta</label>
            <QuickBets amounts={presets} currency={currency} decimals={decimals} disabled={sessionId !== null} onPick={(v) => setBetAmount(minorToInput(v, decimals, currency))} />
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">$</span>
              <input 
                type="text" 
                inputMode="decimal"
                aria-label="Monto de apuesta"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                disabled={sessionId !== null}
                className="w-full bg-[#0b0e14] border border-white/10 rounded-lg py-3 pl-8 pr-4 text-white font-mono focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
              />
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-white/5">
            {crashState === 'WAITING' ? (
              <button 
                onClick={placeBet}
                disabled={isLoading || !isConnected || sessionId !== null}
                className={`w-full font-bold py-4 rounded-xl uppercase tracking-widest transition-all ${
                  sessionId !== null 
                  ? 'bg-green-600/20 text-green-500 border border-green-500/50 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-500 text-white hover:shadow-[0_0_20px_rgba(37,99,235,0.4)] disabled:opacity-50'
                }`}
              >
                {sessionId !== null ? 'Apuesta realizada' : 'Apostar'}
              </button>
            ) : crashState === 'CRASHING' ? (
              <button 
                onClick={cashout}
                disabled={isLoading || !isConnected || !sessionId || cashedOut}
                className={`w-full font-bold py-4 rounded-xl uppercase tracking-widest transition-all flex flex-col items-center justify-center gap-1 ${
                  !sessionId ? 'bg-[#0b0e14] text-gray-600 border border-white/5 cursor-not-allowed' :
                  cashedOut ? 'bg-green-600/20 text-green-500 border border-green-500/50 cursor-not-allowed' :
                  'bg-green-500 hover:bg-green-400 text-black hover:shadow-[0_0_30px_rgba(34,197,94,0.6)]'
                }`}
              >
                {!sessionId ? (
                  <span>Espera la siguiente ronda</span>
                ) : cashedOut ? (
                  <>
                    <span>Retirado</span>
                    <span className="text-xs font-mono">+{winAmount !== null ? money(winAmount) : ""}</span>
                  </>
                ) : (
                  <>
                    <span>Retirar</span>
                    <span className="text-xs font-mono bg-black/20 px-2 py-0.5 rounded">
                      {money(((betMinor ?? BigInt(0)) * BigInt(Math.round(multiplier * 1e6))) / BigInt(1000000))}
                    </span>
                  </>
                )}
              </button>
            ) : (
              <button 
                disabled
                className="w-full bg-[#0b0e14] text-gray-600 border border-white/5 font-bold py-4 rounded-xl uppercase tracking-widest cursor-not-allowed"
              >
                Explotó
              </button>
            )}
          </div>
        </div>

        {/* Game Area / Chart */}
        <div className="flex-1 bg-[#12141a] rounded-2xl border border-white/5 p-8 flex flex-col items-center justify-center relative shadow-inner overflow-hidden">
          
          {/* Main Multiplier Display */}
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 flex flex-col items-center">
            {crashState === 'WAITING' ? (
              <>
                <div className="text-6xl font-bold font-mono text-white/20 mb-4">1.00x</div>
                <div className="text-sm font-mono text-yellow-500 uppercase tracking-[0.2em] animate-pulse">
                  Empieza en {nextTime} s…
                </div>
              </>
            ) : (
              <>
                <div className={`text-7xl md:text-8xl font-bold font-mono transition-colors ${
                  crashState === 'CRASHED' ? 'text-red-500 drop-shadow-[0_0_20px_rgba(239,68,68,0.5)]' :
                  'text-white drop-shadow-[0_0_20px_rgba(255,255,255,0.3)]'
                }`}>
                  {multiplier.toFixed(2)}x
                </div>
                {crashState === 'CRASHED' && (
                  <div className="text-sm font-mono text-red-500 uppercase tracking-[0.2em] mt-4 font-bold bg-red-950/50 px-4 py-1 rounded-full">
                    ¡Explotó!
                  </div>
                )}
              </>
            )}
          </div>

          {/* Win Animation Overlay */}
          {cashedOut && winAmount !== null && crashState === 'CRASHING' && (
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none animate-bounce">
              <div className="text-2xl font-bold text-green-400 bg-black/80 px-6 py-2 rounded-full border border-green-500/30">
                ¡Ganaste {money(winAmount)}!
              </div>
            </div>
          )}

          {/* Visual Curve Chart (CSS Hack for cool visuals) */}
          <div className="absolute bottom-0 left-0 w-full h-[60%] flex items-end">
            <div 
              className={`w-full bg-gradient-to-t from-blue-900/40 to-transparent border-t-2 transition-all ease-linear ${
                crashState === 'CRASHED' ? 'border-red-500 from-red-900/20' : 'border-blue-500'
              }`}
              style={{ 
                height: `${calculateCurveHeight()}%`,
                clipPath: 'polygon(0 100%, 0% 100%, 100% 0%, 100% 100%)', // Simple triangle curve
                transitionDuration: crashState === 'CRASHING' ? '100ms' : '0ms'
              }}
            ></div>
          </div>
          
          {/* Grid Lines */}
          <div className="absolute inset-0 z-10 pointer-events-none" style={{ backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.02) 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
          
        </div>

      </div>
    </div>
  );
}
