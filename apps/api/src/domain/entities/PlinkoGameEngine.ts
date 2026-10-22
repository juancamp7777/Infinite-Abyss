import crypto from 'crypto';

export type PlinkoRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type PlinkoRows = 8 | 12 | 16;

export interface PlinkoResult {
  path: ('L' | 'R')[];
  bin: number;
  multiplier: number;
}

export class PlinkoGameEngine {
  // Multipliers map based on Rows and Risk. Index represents the bin (from 0 to rows).
  private static readonly MULTIPLIERS: Record<PlinkoRows, Record<PlinkoRisk, number[]>> = {
    8: {
      LOW: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
      MEDIUM: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
      HIGH: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
    },
    12: {
      LOW: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
      MEDIUM: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
      HIGH: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170]
    },
    16: {
      LOW: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
      MEDIUM: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
      HIGH: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000]
    }
  };

  /**
   * Generates a provably fair plinko drop.
   * Calculates the path by generating random bytes, ensuring a 50/50 chance for L/R at each peg.
   */
  public static dropBall(rows: PlinkoRows, risk: PlinkoRisk): PlinkoResult {
    const path: ('L' | 'R')[] = [];
    let rightCount = 0;

    // Use cryptographic randomness for fairness
    const buffer = crypto.randomBytes(rows);

    for (let i = 0; i < rows; i++) {
      // If the byte is even, go Left (0), if odd, go Right (1)
      const isRight = buffer[i] % 2 !== 0;
      if (isRight) {
        path.push('R');
        rightCount++;
      } else {
        path.push('L');
      }
    }

    // The final bin is exactly the number of 'Right' bounces
    const bin = rightCount;
    const multiplier = this.MULTIPLIERS[rows][risk][bin];

    return { path, bin, multiplier };
  }
}
