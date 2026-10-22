export type BetType = 'pleno' | 'color';
export type BetValue = number | 'red' | 'black';

export class Bet {
  constructor(
    public readonly type: BetType,
    public readonly value: BetValue,
    /** Unidades mínimas de la moneda del jugador. */
    public readonly amount: bigint
  ) {
    if (amount <= 0n) {
      throw new Error('Bet amount must be greater than zero');
    }
    
    if (type === 'pleno' && (typeof value !== 'number' || value < 0 || value > 36)) {
      throw new Error('Invalid straight up bet value');
    }
    
    if (type === 'color' && value !== 'red' && value !== 'black') {
      throw new Error('Invalid color bet value');
    }
  }
}
