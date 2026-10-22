import type { GameMath } from '../domain/GameMath';

/**
 * Juegos triviales de RTP conocido para probar el simulador y el CLI (no se registran en GAMES).
 * - dummy-coin: 50 % paga 1.92x → RTP 0.96, hit rate 0.5, stdDev 0.96.
 * - dummy-bonus: como dummy-coin, pero 1 de cada 100 rondas activa un "bonus" que paga 10x;
 *   bonus buy a 10x la apuesta (RTP compra = 1.0).
 */
export const dummyCoin: GameMath<{ p: number; pay: number }, { win: boolean }> = {
  id: 'dummy-coin',
  name: 'Dummy Coin',
  kind: 'original',
  rtpTarget: 0.96,
  volatility: 'low',
  maxWinMultiplier: 1.92,
  config: { p: 0.5, pay: 1.92 },
  play(rng) {
    const win = rng.nextFloat() < this.config.p;
    return { multiplier: win ? this.config.pay : 0, outcome: { win }, bonusTriggered: false };
  },
};

export const dummyBonus: GameMath<Record<string, never>, { kind: 'base' | 'bonus' }> = {
  id: 'dummy-bonus',
  name: 'Dummy Bonus',
  kind: 'slot',
  // 0.99*0.5*1.92/… → base: 0.99 * 0.96 = 0.9504; bonus: 0.01 * 10 = 0.1 → 1.0504
  rtpTarget: 0.99 * 0.96 + 0.1,
  volatility: 'medium',
  maxWinMultiplier: 10,
  config: {},
  bonusBuy: { costMultiplier: 10 },
  play(rng, opts) {
    if (opts?.bonusBuy || rng.nextFloat() < 0.01) {
      return { multiplier: 10, outcome: { kind: 'bonus' }, bonusTriggered: true, freeSpins: 1 };
    }
    return { multiplier: rng.nextFloat() < 0.5 ? 1.92 : 0, outcome: { kind: 'base' }, bonusTriggered: false };
  },
};

export const DUMMY_GAMES: Record<string, GameMath<any, any>> = {
  [dummyCoin.id]: dummyCoin,
  [dummyBonus.id]: dummyBonus,
};
