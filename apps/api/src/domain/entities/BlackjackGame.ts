import { Card } from './Card';

export class BlackjackGame {
  public static calculateScore(cards: Card[]): number {
    let score = 0;
    let aces = 0;

    for (const card of cards) {
      if (card.rank === 'A') {
        aces += 1;
        score += 11;
      } else {
        score += card.value[0]; // J,Q,K are 10. Others are their face value.
      }
    }

    // Adjust for aces if we bust
    while (score > 21 && aces > 0) {
      score -= 10;
      aces -= 1;
    }

    return score;
  }

  public static isBust(cards: Card[]): boolean {
    return this.calculateScore(cards) > 21;
  }

  public static isBlackjack(cards: Card[]): boolean {
    return cards.length === 2 && this.calculateScore(cards) === 21;
  }
}
