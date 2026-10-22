import { Card, Suit, Rank } from './Card';
import crypto from 'crypto';

export class Deck {
  private cards: Card[] = [];

  constructor(numberOfDecks: number = 6) {
    this.initialize(numberOfDecks);
    this.shuffle();
  }

  private initialize(numberOfDecks: number) {
    const suits: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    for (let i = 0; i < numberOfDecks; i++) {
      for (const suit of suits) {
        for (const rank of ranks) {
          this.cards.push(new Card(suit, rank));
        }
      }
    }
  }

  public shuffle() {
    // Cryptographically secure Fisher-Yates shuffle
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  public draw(): Card {
    if (this.cards.length === 0) {
      throw new Error('Deck is empty');
    }
    return this.cards.pop()!;
  }
  
  public remainingCards(): number {
    return this.cards.length;
  }
}
