import crypto from 'crypto';

export class MinesGame {
  public static generateGrid(numMines: number): boolean[] {
    const totalCells = 25; // 5x5 grid
    if (numMines < 1 || numMines > 24) {
      throw new Error("Invalid number of mines. Must be between 1 and 24.");
    }

    const grid = new Array(totalCells).fill(false); // false = diamond, true = mine

    // Secure mine placement
    let minesPlaced = 0;
    while (minesPlaced < numMines) {
      const idx = crypto.randomInt(0, totalCells);
      if (!grid[idx]) {
        grid[idx] = true;
        minesPlaced++;
      }
    }

    return grid;
  }

  public static calculateMultiplier(mines: number, revealedDiamonds: number): number {
    // Standard casino mines multiplier logic (combinations math)
    const totalCells = 25;
    const diamonds = totalCells - mines;
    
    // Safety check
    if (revealedDiamonds < 1 || revealedDiamonds > diamonds) return 0;

    let multiplier = 1.0;
    
    // Base formula for Mines payout: (1 - HouseEdge) * (TotalCombinations / WinningCombinations)
    // For simplicity and speed in this demo, we'll use a simplified exponential curve
    // Real casinos use hypergeometric distribution. Let's approximate a provably fair curve:
    
    const houseEdge = 0.01; // 1%
    
    // Correct formula without huge math: 
    // M = 0.99 * (25! / (25-r)!) / ((25-m)! / (25-m-r)!)
    
    let prob = 1.0;
    for (let i = 0; i < revealedDiamonds; i++) {
      prob *= (diamonds - i) / (totalCells - i);
    }
    
    multiplier = (1 - houseEdge) / prob;
    
    return Number(multiplier.toFixed(2));
  }
}
