export type RouletteColor = 'red' | 'black' | 'green';

export class RouletteResult {
  constructor(
    public readonly number: number,
    public readonly color: RouletteColor
  ) {
    if (number < 0 || number > 36) {
      throw new Error('Roulette number must be between 0 and 36');
    }
  }

  public static getColorForNumber(num: number): RouletteColor {
    if (num === 0) return 'green';
    const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
    return RED_NUMBERS.includes(num) ? 'red' : 'black';
  }
}
