export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export class Card {
  constructor(public readonly suit: Suit, public readonly rank: Rank) {}

  public get value(): number[] {
    if (['J', 'Q', 'K'].includes(this.rank)) return [10];
    if (this.rank === 'A') return [1, 11];
    return [parseInt(this.rank, 10)];
  }

  public toJSON() {
    return { suit: this.suit, rank: this.rank };
  }
}
