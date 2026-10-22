export interface IRNGService {
  /**
   * Generates a random number between min (inclusive) and max (inclusive).
   */
  generateRandomNumber(min: number, max: number): number;
}
