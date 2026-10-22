import type { PlayOptions, PlayResult } from '../GameMath';
import type { Rng } from '../fairness/Rng';
import { floor4, GameParamError, OriginalGameMath, resolveOriginalRtp } from './types';

/**
 * Abyss Dice: tirada 0.00–99.99 (10 000 resultados equiprobables, floor(f·10000)/100).
 * - over: gana si roll > target · under: gana si roll < target.
 * - multiplicador = floor4(RTP / P(ganar)); probabilidad de ganar entre 1 % y 98 %.
 */
export interface DiceConfig {
  ticks: number;
  minChance: number;
  maxChance: number;
}

export interface DiceOutcome {
  roll: number;
  target: number;
  over: boolean;
  winChance: number;
  payout: number;
  win: boolean;
}

interface DiceParams {
  target: number;
  over: boolean;
}

const CONFIG: DiceConfig = { ticks: 10000, minChance: 0.01, maxChance: 0.98 };

function parseParams(params: Record<string, unknown> | undefined): DiceParams {
  const target = params?.target === undefined ? 50 : Number(params.target);
  const over = params?.over === undefined ? true : params.over;
  if (!Number.isFinite(target) || Math.abs(target * 100 - Math.round(target * 100)) > 1e-6) {
    throw new GameParamError('target debe ser un número con hasta 2 decimales');
  }
  if (typeof over !== 'boolean') throw new GameParamError('over debe ser booleano');
  const t = Math.round(target * 100);
  if (t < 0 || t > CONFIG.ticks - 1) throw new GameParamError('target fuera de rango (0–99.99)');
  const chance = winCount(t, over) / CONFIG.ticks;
  if (chance < CONFIG.minChance || chance > CONFIG.maxChance) {
    throw new GameParamError('La probabilidad de ganar debe estar entre 1 % y 98 %');
  }
  return { target: t / 100, over };
}

/** Resultados ganadores para target en ticks (centésimas). */
function winCount(targetTicks: number, over: boolean): number {
  return over ? CONFIG.ticks - 1 - targetTicks : targetTicks;
}

export function dicePayout(target: number, over: boolean, rtp: number): { winChance: number; payout: number } {
  const winChance = winCount(Math.round(target * 100), over) / CONFIG.ticks;
  return { winChance, payout: floor4(rtp / winChance) };
}

export const nymfoDice: OriginalGameMath<DiceConfig, DiceOutcome> = {
  id: 'nymfo-dice',
  name: 'Abyss Dice',
  kind: 'original',
  rtpTarget: 0.99,
  rtpRange: { min: 0.97, max: 0.99 },
  volatility: 'low',
  maxWinMultiplier: 99,
  config: CONFIG,
  validateParams(params) {
    parseParams(params);
  },
  play(rng: Rng, opts?: PlayOptions): PlayResult<DiceOutcome> {
    const { target, over } = parseParams(opts?.params);
    const rtp = resolveOriginalRtp(opts?.rtpProfile, this.rtpTarget, this.rtpRange);
    const rollTicks = Math.floor(rng.nextFloat() * CONFIG.ticks);
    const t = Math.round(target * 100);
    const win = over ? rollTicks > t : rollTicks < t;
    const { winChance, payout } = dicePayout(target, over, rtp);
    return {
      multiplier: win ? payout : 0,
      outcome: { roll: rollTicks / 100, target, over, winChance, payout, win },
      bonusTriggered: false,
    };
  },
};
