import { IRNGService } from '../services/IRNGService';

export type SlotSymbol = 'CHERRY' | 'LEMON' | 'ORANGE' | 'PLUM' | 'BELL' | 'BAR' | 'SEVEN';

export interface SlotResult {
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
  payoutMultiplier: number;
}

export class SlotMachine {
  private static readonly SYMBOLS: SlotSymbol[] = ['CHERRY', 'LEMON', 'ORANGE', 'PLUM', 'BELL', 'BAR', 'SEVEN'];
  
  // Weights (lower = rarer) to simulate house edge
  private static readonly WEIGHTS = [30, 25, 20, 15, 10, 5, 2];

  constructor(private rngService: IRNGService) {}

  public spin(): SlotResult {
    const reels: [SlotSymbol, SlotSymbol, SlotSymbol] = [
      this.getRandomSymbol(),
      this.getRandomSymbol(),
      this.getRandomSymbol()
    ];

    const payoutMultiplier = this.calculatePayout(reels);

    return {
      reels,
      payoutMultiplier
    };
  }

  private getRandomSymbol(): SlotSymbol {
    const totalWeight = SlotMachine.WEIGHTS.reduce((a, b) => a + b, 0);
    let randomNum = this.rngService.generateRandomNumber(0, totalWeight - 1);
    
    for (let i = 0; i < SlotMachine.SYMBOLS.length; i++) {
      if (randomNum < SlotMachine.WEIGHTS[i]) {
        return SlotMachine.SYMBOLS[i];
      }
      randomNum -= SlotMachine.WEIGHTS[i];
    }
    
    return SlotMachine.SYMBOLS[0];
  }

  private calculatePayout(reels: [SlotSymbol, SlotSymbol, SlotSymbol]): number {
    const [r1, r2, r3] = reels;
    
    if (r1 === r2 && r2 === r3) {
      // 3 of a kind
      switch (r1) {
        case 'SEVEN': return 500;
        case 'BAR': return 100;
        case 'BELL': return 50;
        case 'PLUM': return 20;
        case 'ORANGE': return 15;
        case 'LEMON': return 10;
        case 'CHERRY': return 5;
      }
    } else if (r1 === r2 || r2 === r3 || r1 === r3) {
      // 2 of a kind (small payout for specific symbols like Cherry)
      if (r1 === 'CHERRY' && r2 === 'CHERRY') return 2;
      if (r1 === 'CHERRY' && r3 === 'CHERRY') return 2;
      if (r2 === 'CHERRY' && r3 === 'CHERRY') return 2;
    }
    
    return 0; // Loss
  }
}
