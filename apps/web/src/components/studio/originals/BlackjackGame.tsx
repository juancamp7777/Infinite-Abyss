'use client';

import { useState } from 'react';
import type { StudioGameProps } from '../types';
import { errorMessage, studioApi, type PublicRound } from './api';
import FairnessPanel from './FairnessPanel';
import { BetInput, GameShell, HistoryStrip, OpenRoundNotice, PrimaryButton, ResultBanner, TurboToggle, formatMinor, sleep, toMinorString, useOpenRound, useRoundHistory, useStudioSession, useBetAmount } from './common';

interface Card {
  rank: string;
  suit: string;
}
interface Hand {
  cards: Card[];
  score: number;
  soft: boolean;
  bet: number;
  done: boolean;
  doubled: boolean;
  result?: 'blackjack' | 'win' | 'push' | 'lose' | 'bust';
  returned?: number;
}
interface BjView {
  status: 'playing' | 'finished';
  active: number;
  dealer: { cards: Card[]; score: number; hidden: number };
  hands: Hand[];
  actions: string[];
}

const SUIT: Record<string, { s: string; red: boolean }> = { H: { s: '♥', red: true }, D: { s: '♦', red: true }, C: { s: '♣', red: false }, S: { s: '♠', red: false } };
const RESULT: Record<string, string> = { blackjack: 'Blackjack', win: 'Ganas', push: 'Empate', lose: 'Pierdes', bust: 'Te pasas' };
const ACTION_LABEL: Record<string, string> = { hit: 'Pedir', stand: 'Plantarse', double: 'Doblar', split: 'Dividir' };

function PlayingCard({ card, hidden, delay }: { card?: Card; hidden?: boolean; delay: number }) {
  const su = card ? (SUIT[card.suit] ?? { s: card.suit, red: false }) : null;
  return (
    <div
      aria-label={hidden || !card ? 'Carta oculta' : `${card.rank} de ${su?.s}`}
      role="img"
      className={`flex h-20 w-14 shrink-0 animate-[bjdeal_0.3s_ease-out_both] flex-col justify-between rounded-lg border p-1 text-sm font-bold shadow-md sm:h-28 sm:w-20 sm:text-lg ${hidden || !card ? 'border-sky-300 bg-gradient-to-br from-sky-700 to-indigo-900' : `border-slate-300 bg-white ${su?.red ? 'text-red-600' : 'text-slate-900'}`}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      {!hidden && card && (
        <>
          <span className="leading-none">
            {card.rank}
            <br />
            {su?.s}
          </span>
          <span className="self-end text-xl leading-none sm:text-3xl">{su?.s}</span>
        </>
      )}
    </div>
  );
}

export default function BlackjackGame(props: StudioGameProps) {
  const session = useStudioSession(props);
  const history = useRoundHistory(props);
  const openRound = useOpenRound(props, session, true);
  const [bet, setBet] = useBetAmount(session);
  const [turbo, setTurbo] = useState(false);
  const [view, setView] = useState<BjView | null>(null);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [last, setLast] = useState<PublicRound | null>(null);
  const [busy, setBusy] = useState(false);

  const minor = toMinorString(bet);
  const playing = view?.status === 'playing' && roundId !== null;
  const bal = session.balance ? BigInt(session.balance) : BigInt(0);

  const afterResponse = async (round: PublicRound, v: BjView, balance: string | null) => {
    if (v.status === 'finished') {
      if (!turbo) await sleep(450);
      setView(v);
      setLast(round);
      history.push(round);
      setRoundId(null);
      session.applyBalance(balance);
    } else {
      setView(v);
    }
  };

  const deal = async () => {
    if (!minor) return;
    setBusy(true);
    session.setError(null);
    setLast(null);
    setView(null);
    try {
      const r = await studioApi.start(props, minor, {});
      setRoundId(r.round.id);
      session.applyBalance(r.balance);
      await afterResponse(r.round, r.view as unknown as BjView, r.balance);
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (type: string) => {
    if (!roundId || busy) return;
    setBusy(true);
    session.setError(null);
    try {
      const r = await studioApi.action(props, roundId, { type });
      if (type === 'double' || type === 'split') session.applyBalance(r.balance);
      await afterResponse(r.round, r.view as unknown as BjView, r.balance);
    } catch (e) {
      session.setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const actions = playing ? (view?.actions ?? []) : [];
  const aside = (
    <>
      <OpenRoundNotice state={openRound} />
      <BetInput value={bet} onChange={setBet} disabled={playing || busy} />
      <TurboToggle value={turbo} onChange={setTurbo} />
      {playing ? (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Acciones de la mano">
          {(['hit', 'stand', 'double', 'split'] as const).map((a) => (
            <PrimaryButton key={a} tone={a === 'stand' ? 'stop' : 'go'} disabled={busy || !actions.includes(a)} onClick={() => act(a)} aria-label={ACTION_LABEL[a]}>
              {ACTION_LABEL[a]}
            </PrimaryButton>
          ))}
        </div>
      ) : (
        <PrimaryButton disabled={!minor || busy || !session.ready || !!openRound.open} onClick={deal} aria-label="Repartir cartas">
          {busy ? 'Repartiendo…' : 'Repartir'}
        </PrimaryButton>
      )}
      {playing && minor && <p className="text-[11px] text-slate-500">Doblar y dividir cobran una apuesta adicional de {formatMinor(minor)} (saldo: {formatMinor(bal)}).</p>}
      <FairnessPanel game={props} lastRound={last} />
    </>
  );

  const won = last ? BigInt(last.win) : null;
  const staked = last ? BigInt(last.bet) : BigInt(0);
  return (
    <GameShell title="Abyss Blackjack" session={session} aside={aside}>
      <style>{`@keyframes bjdeal{from{opacity:0;transform:translateY(-16px) scale(.9)}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){[style*="bjdeal"],.animate-\\[bjdeal_0\\.3s_ease-out_both\\]{animation:none!important}}`}</style>
      <div className="space-y-3">
        <div className="min-h-[360px] space-y-5 rounded-2xl bg-emerald-900/50 p-3 sm:p-5">
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-emerald-200/70">Crupier {view ? `· ${view.dealer.hidden ? view.dealer.cards[0] ? view.dealer.score : '' : view.dealer.score}` : ''}</div>
            <div className="flex min-h-20 gap-2 sm:min-h-28">
              {view ? (
                <>
                  {view.dealer.cards.map((c, i) => (
                    <PlayingCard key={`d${i}${c.rank}${c.suit}`} card={c} delay={i * (turbo ? 0 : 120)} />
                  ))}
                  {view.dealer.hidden > 0 && <PlayingCard hidden delay={120} />}
                </>
              ) : (
                <p className="self-center text-sm text-emerald-100/60">Haz tu apuesta y reparte.</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-5">
            {view?.hands.map((h, hi) => {
              const isActive = playing && view.active === hi;
              return (
                <div key={hi} className={`rounded-xl p-2 ${isActive ? 'ring-2 ring-amber-400' : ''}`} aria-current={isActive}>
                  <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-emerald-200/70">
                    <span>
                      Mano {view.hands.length > 1 ? hi + 1 : ''} · {h.score}
                      {h.soft && h.score < 21 ? ' (blanda)' : ''}
                    </span>
                    {h.doubled && <span className="rounded bg-amber-400/20 px-1 text-amber-300">x2</span>}
                    {h.result && <span className={`rounded px-1.5 font-bold ${h.result === 'win' || h.result === 'blackjack' ? 'bg-emerald-500/30 text-emerald-200' : h.result === 'push' ? 'bg-slate-500/30 text-slate-200' : 'bg-rose-500/30 text-rose-200'}`}>{RESULT[h.result]}</span>}
                  </div>
                  <div className="flex gap-2">
                    {h.cards.map((c, i) => (
                      <PlayingCard key={`h${hi}${i}${c.rank}${c.suit}`} card={c} delay={i * (turbo ? 0 : 120)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <ResultBanner win={won !== null ? won >= staked && won > BigInt(0) : null} text={last && won !== null ? (won > staked ? `¡Ganaste ${formatMinor(won - staked, last.currency)}!` : won > BigInt(0) && won === staked ? 'Empate: te devolvemos la apuesta.' : won > BigInt(0) ? `Recuperas ${formatMinor(won, last.currency)}.` : 'La casa gana esta mano.') : ''} />
        <HistoryStrip rounds={history.rounds} loading={history.loading} />
      </div>
    </GameShell>
  );
}
