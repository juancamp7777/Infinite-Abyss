"use client";

import { useState } from "react";
import Link from "next/link";
import { Coins, Spade, Wifi, WifiOff } from "lucide-react";
import { casinoSDK, BlackjackSession } from "../../lib/CasinoSDK";
import { useCasino } from "../../hooks/useCasino";

export default function BlackjackDashboard() {
  const { balance, isConnected, money, demoBet } = useCasino();
  const [session, setSession] = useState<BlackjackSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [winAmount, setWinAmount] = useState<bigint | null>(null);

  const startHand = async () => {
    if (isLoading || !isConnected) return;
    setIsLoading(true);
    setWinAmount(null);
    try {
      const res = await casinoSDK.startBlackjack(demoBet); // mano fija de demo
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

  const hit = async () => {
    if (isLoading || !isConnected || !session) return;
    setIsLoading(true);
    try {
      const res = await casinoSDK.hitBlackjack(session.id);
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

  const stand = async () => {
    if (isLoading || !isConnected || !session) return;
    setIsLoading(true);
    try {
      const res = await casinoSDK.standBlackjack(session.id);
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

  const renderCard = (card: { suit: string; rank: string; value: number }, index: number, hidden: boolean = false) => {
    if (hidden) {
      return (
        <div key={`hidden-${index}`} className="w-16 h-24 md:w-20 md:h-32 bg-blue-900 border-2 border-white rounded-md shadow-lg flex items-center justify-center bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,rgba(255,255,255,0.1)_5px,rgba(255,255,255,0.1)_10px)] -ml-8 first:ml-0 transform transition-transform hover:-translate-y-2">
        </div>
      );
    }
    const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
    return (
      <div key={`${card.suit}-${card.rank}-${index}`} className="w-16 h-24 md:w-20 md:h-32 bg-white border border-gray-300 rounded-md shadow-lg flex flex-col justify-between p-1 -ml-8 first:ml-0 transform transition-transform hover:-translate-y-2">
        <div className={`text-sm md:text-lg font-bold ${isRed ? 'text-red-600' : 'text-black'}`}>{card.rank}</div>
        <div className={`text-2xl md:text-4xl self-center ${isRed ? 'text-red-600' : 'text-black'}`}>
          {card.suit === 'hearts' ? '♥' : card.suit === 'diamonds' ? '♦' : card.suit === 'clubs' ? '♣' : '♠'}
        </div>
        <div className={`text-sm md:text-lg font-bold rotate-180 ${isRed ? 'text-red-600' : 'text-black'}`}>{card.rank}</div>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden bg-green-950">
      <div className="absolute inset-0 z-0 opacity-40 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-green-800 via-green-950 to-black"></div>
      
      {/* Felt Texture Overlay */}
      <div className="absolute inset-0 z-0 opacity-10 mix-blend-overlay pointer-events-none" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>

      <div className="absolute top-6 left-6 z-20">
        <Link href="/classic" className="text-white hover:text-gold-300 transition-colors uppercase tracking-widest text-xs font-serif border border-white/30 px-4 py-2 rounded-lg bg-black/50">
          ← Back to Lobby
        </Link>
      </div>

      <div className="absolute top-6 right-6 z-20">
        {isConnected ? (
          <div className="flex items-center gap-2 text-xs font-mono text-green-300 bg-black/50 px-3 py-1.5 rounded-full border border-green-500/50">
            <Wifi className="w-3 h-3" /> <span className="uppercase tracking-widest">Conectado</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-mono text-red-500 bg-black/50 px-3 py-1.5 rounded-full border border-red-500/50">
            <WifiOff className="w-3 h-3" /> <span className="uppercase tracking-widest">Reconectando…</span>
          </div>
        )}
      </div>

      <div className="z-10 w-full max-w-4xl flex flex-col items-center gap-8 mt-12">
        <header className="w-full flex justify-between items-center bg-black/40 backdrop-blur-sm px-8 py-4 rounded-full border border-white/10">
          <div className="flex items-center gap-3">
            <Spade className="w-6 h-6 text-white" />
            <h1 className="font-serif text-xl font-bold tracking-widest text-white uppercase">
              High Stakes Blackjack
            </h1>
          </div>
          <div className={`flex items-center gap-3 ${winAmount !== null ? 'animate-god-glow text-gold-300' : 'text-white'}`}>
            <Coins className="w-5 h-5" />
            <span className="font-serif text-xl tracking-wider">
              {money(balance)}
            </span>
          </div>
        </header>

        {winAmount !== null && (
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none">
            <div className="text-4xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 to-yellow-600 drop-shadow-[0_0_30px_rgba(255,215,0,1)] animate-bounce whitespace-nowrap">
              WIN {money(winAmount)}!
            </div>
          </div>
        )}

        <div className="w-full flex flex-col items-center gap-16 mt-8">
          {/* Dealer Area */}
          <div className="flex flex-col items-center gap-4">
            <div className="text-white/60 uppercase tracking-widest text-xs font-bold border border-white/20 px-4 py-1 rounded-full">
              Crupier {session && session.dealerScore > 0 ? `(${session.dealerScore})` : ''}
            </div>
            <div className="flex h-32">
              {session ? (
                session.dealerCards.map((card, idx) => renderCard(card, idx, session.status === 'ACTIVE' && idx === 1))
              ) : (
                <div className="w-20 h-32 border-2 border-dashed border-white/20 rounded-md"></div>
              )}
            </div>
          </div>

          {/* Table Center (Logo/Info) */}
          <div className="h-20 flex items-center justify-center">
            {session && session.status === 'FINISHED' ? (
              <div className="font-serif text-3xl text-gold-400 uppercase tracking-widest bg-black/50 px-8 py-2 rounded-lg border border-gold-500/50">
                {session.playerScore > 21 ? '¡Te pasaste!' : 
                 session.dealerScore > 21 ? '¡La casa se pasa!' : 
                 session.playerScore > session.dealerScore ? '¡Ganaste!' :
                 session.playerScore === session.dealerScore ? 'Empate' : 'Gana la casa'}
              </div>
            ) : (
              <div className="text-white/20 uppercase tracking-[0.5em] text-sm border-b border-white/10 pb-2">
                Blackjack Pays 3 to 2
              </div>
            )}
          </div>

          {/* Player Area */}
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-32">
              {session ? (
                session.playerCards.map((card, idx) => renderCard(card, idx))
              ) : (
                <div className="w-20 h-32 border-2 border-dashed border-white/20 rounded-md"></div>
              )}
            </div>
            <div className="text-white uppercase tracking-widest text-sm font-bold bg-black/50 border border-white/20 px-6 py-2 rounded-full">
              Jugador {session ? `(${session.playerScore})` : ''}
            </div>
          </div>

          {/* Controls */}
          <div className="flex gap-4 mt-4">
            {!session || session.status === 'FINISHED' ? (
              <button 
                onClick={startHand}
                disabled={isLoading || !isConnected}
                className="bg-gold-600 hover:bg-gold-500 text-black px-12 py-4 rounded-full font-serif font-bold text-lg uppercase tracking-widest transition-colors disabled:opacity-50"
              >
                Repartir {money(demoBet)}
              </button>
            ) : (
              <>
                <button 
                  onClick={hit}
                  disabled={isLoading || !isConnected}
                  className="bg-black/80 hover:bg-black text-white border border-white/30 px-10 py-3 rounded-full font-serif font-bold uppercase tracking-widest transition-colors disabled:opacity-50"
                >
                  Pedir carta
                </button>
                <button 
                  onClick={stand}
                  disabled={isLoading || !isConnected}
                  className="bg-white hover:bg-gray-200 text-black px-10 py-3 rounded-full font-serif font-bold uppercase tracking-widest transition-colors disabled:opacity-50"
                >
                  Plantarse
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
