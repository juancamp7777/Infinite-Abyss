import type { Rng } from '../fairness/Rng';
import { GameActionError, InteractiveGame } from './types';

/**
 * Abyss Blackjack (reglas en CONFIG):
 * - Zapato de 6 mazos barajado por Fisher-Yates con el Rng provably fair; se reparte en orden P, D, P, D…
 * - El dealer se planta en todos los 17 (S17) y revisa blackjack con A o figura visible (peek).
 * - Blackjack paga 3:2, sin seguro ni rendición.
 * - Doblar con las dos primeras cartas de cualquier mano (también tras dividir, salvo ases).
 * - Un solo split por ronda (pares del mismo rango); los ases divididos reciben una carta cada uno
 *   y 21 tras dividir no cuenta como blackjack.
 * El multiplicador final es el retorno total en veces la apuesta base; doblar/dividir piden additionalBet = 1.
 */
export const BLACKJACK_RULES = {
  decks: 6,
  dealerStandsSoft17: true,
  blackjackPays: 1.5,
  dealerPeek: true,
  insurance: false,
  surrender: false,
  doubleAnyTwo: true,
  doubleAfterSplit: true,
  maxSplits: 1,
  splitAcesOneCard: true,
} as const;

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
const SUITS = ['H', 'D', 'C', 'S'] as const;

export interface BjHand {
  cards: string[];
  /** Apuesta de la mano en veces la apuesta base (1 o 2 si dobló). */
  bet: number;
  done: boolean;
  doubled: boolean;
  splitAces: boolean;
  result?: 'blackjack' | 'win' | 'push' | 'lose' | 'bust';
  returned?: number;
}

export interface BlackjackState {
  shoe: string[];
  pos: number;
  dealer: string[];
  hands: BjHand[];
  active: number;
  status: 'playing' | 'finished';
}

export const cardRank = (code: string): string => code.slice(0, -1);
export const cardView = (code: string) => ({ rank: cardRank(code), suit: code.slice(-1) });

export function handScore(cards: string[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const r = cardRank(c);
    if (r === 'A') {
      aces += 1;
      total += 11;
    } else if (r === 'J' || r === 'Q' || r === 'K') total += 10;
    else total += Number(r);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

const isNatural = (cards: string[]) => cards.length === 2 && handScore(cards).total === 21;
const tenValue = (code: string) => ['10', 'J', 'Q', 'K'].includes(cardRank(code));

/** Zapato completo barajado (Fisher-Yates de atrás hacia adelante con nextInt). */
export function shuffledShoe(rng: Rng, decks: number = BLACKJACK_RULES.decks): string[] {
  const shoe: string[] = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) shoe.push(`${r}${s}`);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function draw(s: BlackjackState): string {
  if (s.pos >= s.shoe.length) throw new GameActionError('Zapato agotado');
  return s.shoe[s.pos++];
}

function clone(s: BlackjackState): BlackjackState {
  return { ...s, dealer: [...s.dealer], hands: s.hands.map((h) => ({ ...h, cards: [...h.cards] })) };
}

function view(s: BlackjackState): Record<string, unknown> {
  const finished = s.status === 'finished';
  const dealerCards = finished ? s.dealer : s.dealer.slice(0, 1);
  return {
    status: s.status,
    active: s.active,
    rules: BLACKJACK_RULES,
    dealer: { cards: dealerCards.map(cardView), score: handScore(dealerCards).total, hidden: finished ? 0 : 1 },
    hands: s.hands.map((h) => ({
      cards: h.cards.map(cardView),
      score: handScore(h.cards).total,
      soft: handScore(h.cards).soft,
      bet: h.bet,
      done: h.done,
      doubled: h.doubled,
      result: h.result,
      returned: h.returned,
    })),
    actions: finished ? [] : availableActions(s),
  };
}

export function availableActions(s: BlackjackState): string[] {
  if (s.status !== 'playing') return [];
  const h = s.hands[s.active];
  if (!h || h.done) return [];
  const out = ['stand'];
  if (!h.splitAces) out.push('hit');
  if (h.cards.length === 2 && !h.splitAces && (s.hands.length === 1 || BLACKJACK_RULES.doubleAfterSplit)) out.push('double');
  if (s.hands.length === 1 && h.cards.length === 2 && cardRank(h.cards[0]) === cardRank(h.cards[1])) out.push('split');
  return out;
}

/** Avanza a la siguiente mano pendiente; si no queda ninguna, juega el dealer y liquida. */
function advance(s: BlackjackState): void {
  while (s.active < s.hands.length && s.hands[s.active].done) s.active++;
  if (s.active < s.hands.length) return;
  const anyAlive = s.hands.some((h) => handScore(h.cards).total <= 21);
  if (anyAlive) {
    for (;;) {
      const { total, soft } = handScore(s.dealer);
      if (total < 17 || (total === 17 && soft && !BLACKJACK_RULES.dealerStandsSoft17)) s.dealer.push(draw(s));
      else break;
    }
  }
  const dealer = handScore(s.dealer).total;
  const dealerBj = isNatural(s.dealer);
  for (const h of s.hands) {
    const p = handScore(h.cards).total;
    const natural = s.hands.length === 1 && isNatural(h.cards);
    if (p > 21) [h.result, h.returned] = ['bust', 0];
    else if (natural && !dealerBj) [h.result, h.returned] = ['blackjack', h.bet * (1 + BLACKJACK_RULES.blackjackPays)];
    else if (dealerBj && !natural) [h.result, h.returned] = ['lose', 0];
    else if (dealer > 21 || p > dealer) [h.result, h.returned] = ['win', h.bet * 2];
    else if (p === dealer) [h.result, h.returned] = ['push', h.bet];
    else [h.result, h.returned] = ['lose', 0];
  }
  s.active = s.hands.length - 1;
  s.status = 'finished';
}

function step(s: BlackjackState, additionalBet?: number) {
  const done = s.status === 'finished';
  const multiplier = done ? s.hands.reduce((sum, h) => sum + (h.returned ?? 0), 0) : 0;
  return { state: s, view: view(s), done, multiplier, ...(additionalBet ? { additionalBet } : {}) };
}

function closeHandIf21(s: BlackjackState): void {
  const h = s.hands[s.active];
  if (handScore(h.cards).total >= 21) h.done = true;
}

export const nymfoBlackjack: InteractiveGame<BlackjackState> = {
  id: 'nymfo-blackjack',
  name: 'Abyss Blackjack',
  // RTP teórico con estrategia básica para estas reglas (6 mazos, S17, DAS, sin rendición) ≈ 99.5 %.
  rtpTarget: 0.995,
  volatility: 'low',
  maxWinMultiplier: 4,
  config: { rules: BLACKJACK_RULES },
  validateParams() {
    /* sin parámetros */
  },
  start(rng) {
    const s: BlackjackState = { shoe: shuffledShoe(rng), pos: 0, dealer: [], hands: [], active: 0, status: 'playing' };
    const p1 = draw(s);
    const d1 = draw(s);
    const p2 = draw(s);
    const d2 = draw(s);
    s.hands.push({ cards: [p1, p2], bet: 1, done: false, doubled: false, splitAces: false });
    s.dealer.push(d1, d2);
    const dealerUpPeek = cardRank(d1) === 'A' || tenValue(d1);
    if (isNatural(s.hands[0].cards) || (BLACKJACK_RULES.dealerPeek && dealerUpPeek && isNatural(s.dealer))) {
      s.hands[0].done = true;
      // Con blackjack del jugador o del dealer la ronda termina sin que el dealer robe.
      const h = s.hands[0];
      const pNat = isNatural(h.cards);
      const dNat = isNatural(s.dealer);
      if (pNat && dNat) [h.result, h.returned] = ['push', 1];
      else if (pNat) [h.result, h.returned] = ['blackjack', 1 + BLACKJACK_RULES.blackjackPays];
      else [h.result, h.returned] = ['lose', 0];
      s.status = 'finished';
    }
    return step(s);
  },
  action(state, action) {
    if (state.status !== 'playing') throw new GameActionError('La ronda ya terminó');
    if (!availableActions(state).includes(action.type)) throw new GameActionError(`Acción no permitida: ${action.type}`);
    const s = clone(state);
    const h = s.hands[s.active];
    let extra = 0;
    switch (action.type) {
      case 'hit':
        h.cards.push(draw(s));
        closeHandIf21(s);
        break;
      case 'stand':
        h.done = true;
        break;
      case 'double':
        h.cards.push(draw(s));
        h.bet = 2;
        h.doubled = true;
        h.done = true;
        extra = 1;
        break;
      case 'split': {
        const aces = cardRank(h.cards[0]) === 'A';
        const second: BjHand = { cards: [h.cards[1]], bet: 1, done: false, doubled: false, splitAces: aces };
        h.cards = [h.cards[0]];
        h.splitAces = aces;
        s.hands.push(second);
        h.cards.push(draw(s));
        second.cards.push(draw(s));
        if (aces) {
          h.done = true;
          second.done = true;
        } else {
          closeHandIf21(s);
          if (handScore(second.cards).total >= 21) second.done = true;
        }
        extra = 1;
        break;
      }
    }
    advance(s);
    return step(s, extra);
  },
  settle(state) {
    if (state.status === 'finished') return step(state);
    const s = clone(state);
    for (const h of s.hands) h.done = true;
    advance(s);
    return step(s);
  },
  verify(rng) {
    return { shoe: shuffledShoe(rng) };
  },
};
