import type { PlayOptions, PlayResult } from '../GameMath';
import type { Rng } from '../fairness/Rng';
import { GameParamError, isRecord, OriginalGameMath } from './types';

/**
 * Abyss Roulette: ruleta europea (0–36, una sola cero). Pago (incluida la apuesta) = 36 / números cubiertos,
 * por lo que todas las apuestas tienen RTP 36/37 ≈ 97.297 % (fijo, no configurable).
 * Apuestas: straight, split, street, corner, line, dozen, column, red, black, odd, even, low, high.
 * params.bets = [{ type, numbers?, value?, amount }]; amount en unidades mínimas (string) y la suma
 * debe igualar la apuesta total. Si params.bets falta se juega 'red' con toda la apuesta (para el simulador).
 */
export type RouletteBetType =
  | 'straight' | 'split' | 'street' | 'corner' | 'line'
  | 'dozen' | 'column' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high';

export interface RouletteBet {
  type: RouletteBetType;
  numbers?: number[];
  value?: number;
  amount: string;
}

export interface RouletteConfig {
  pockets: number;
  redNumbers: number[];
  payouts: Record<RouletteBetType, number>;
}

export interface RouletteOutcome {
  number: number;
  color: 'red' | 'black' | 'green';
  bets: Array<RouletteBet & { covered: number[]; payout: number; win: string }>;
}

const RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

const CONFIG: RouletteConfig = {
  pockets: 37,
  redNumbers: RED,
  payouts: {
    straight: 36, split: 18, street: 12, corner: 9, line: 6,
    dozen: 3, column: 3, red: 2, black: 2, odd: 2, even: 2, low: 2, high: 2,
  },
};

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const keyOf = (nums: number[]) => [...nums].sort((x, y) => x - y).join('-');

/** Combinaciones válidas del paño europeo por tipo de apuesta interior. */
const INSIDE: Record<'split' | 'street' | 'corner' | 'line', Set<string>> = (() => {
  const split = new Set<string>();
  const street = new Set<string>();
  const corner = new Set<string>();
  const line = new Set<string>();
  for (let n = 1; n <= 36; n++) {
    if (n % 3 !== 0) split.add(keyOf([n, n + 1]));
    if (n + 3 <= 36) split.add(keyOf([n, n + 3]));
    if (n % 3 === 1) street.add(keyOf([n, n + 1, n + 2]));
    if (n % 3 !== 0 && n + 4 <= 36) corner.add(keyOf([n, n + 1, n + 3, n + 4]));
    if (n % 3 === 1 && n + 5 <= 36) line.add(keyOf(range(n, n + 5)));
  }
  for (const n of [1, 2, 3]) split.add(keyOf([0, n]));
  street.add(keyOf([0, 1, 2]));
  street.add(keyOf([0, 2, 3]));
  return { split, street, corner, line };
})();

const SIZE = { split: 2, street: 3, corner: 4, line: 6 } as const;

/** Números cubiertos por una apuesta (lanza GameParamError si no es válida). */
export function coveredNumbers(bet: { type: string; numbers?: unknown; value?: unknown }): number[] {
  switch (bet.type) {
    case 'straight': {
      const n = Array.isArray(bet.numbers) ? bet.numbers[0] : bet.value;
      if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 36) throw new GameParamError('straight requiere un número 0–36');
      return [n as number];
    }
    case 'split':
    case 'street':
    case 'corner':
    case 'line': {
      const nums = bet.numbers;
      if (!Array.isArray(nums) || nums.length !== SIZE[bet.type] || !nums.every((x) => Number.isInteger(x))) {
        throw new GameParamError(`${bet.type} requiere ${SIZE[bet.type]} números`);
      }
      if (!INSIDE[bet.type].has(keyOf(nums as number[]))) throw new GameParamError(`Combinación inválida para ${bet.type}`);
      return [...(nums as number[])].sort((a, b) => a - b);
    }
    case 'dozen':
    case 'column': {
      const v = bet.value;
      if (v !== 1 && v !== 2 && v !== 3) throw new GameParamError(`${bet.type} requiere value 1, 2 o 3`);
      return bet.type === 'dozen' ? range(12 * (v - 1) + 1, 12 * v) : range(1, 36).filter((n) => (n - 1) % 3 === v - 1);
    }
    case 'red':
      return RED;
    case 'black':
      return range(1, 36).filter((n) => !RED.includes(n));
    case 'odd':
      return range(1, 36).filter((n) => n % 2 === 1);
    case 'even':
      return range(1, 36).filter((n) => n % 2 === 0);
    case 'low':
      return range(1, 18);
    case 'high':
      return range(19, 36);
    default:
      throw new GameParamError(`Tipo de apuesta desconocido: ${String(bet.type)}`);
  }
}

function parseBets(params: Record<string, unknown> | undefined): Array<RouletteBet & { covered: number[]; amountN: bigint }> | null {
  if (params?.bets === undefined) return null;
  if (!Array.isArray(params.bets) || params.bets.length === 0 || params.bets.length > 50) {
    throw new GameParamError('bets debe ser una lista de 1 a 50 apuestas');
  }
  return params.bets.map((b) => {
    if (!isRecord(b)) throw new GameParamError('Apuesta inválida');
    const amount = String(b.amount ?? '');
    if (!/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n) throw new GameParamError('amount de cada apuesta debe ser entero > 0');
    const covered = coveredNumbers(b as { type: string });
    return { ...(b as unknown as RouletteBet), amount, covered, amountN: BigInt(amount) };
  });
}

/** Suma de las apuestas de params.bets (null si no hay lista). La apuesta total debe coincidir. */
export function rouletteTotal(params: Record<string, unknown> | undefined): bigint | null {
  const bets = parseBets(params);
  return bets ? bets.reduce((s, b) => s + b.amountN, 0n) : null;
}

export const nymfoRoulette: OriginalGameMath<RouletteConfig, RouletteOutcome> = {
  id: 'nymfo-roulette',
  name: 'Abyss Roulette',
  kind: 'original',
  rtpTarget: 36 / 37,
  volatility: 'medium',
  maxWinMultiplier: 36,
  config: CONFIG,
  validateParams(params) {
    parseBets(params);
  },
  expectedStake: rouletteTotal,
  play(rng: Rng, opts?: PlayOptions): PlayResult<RouletteOutcome> {
    const bets = parseBets(opts?.params) ?? [{ type: 'red' as const, amount: '1', covered: RED, amountN: 1n }];
    const number = rng.nextInt(CONFIG.pockets);
    const total = bets.reduce((s, b) => s + b.amountN, 0n);
    let returned = 0n;
    const detail = bets.map(({ amountN, ...b }) => {
      const payout = CONFIG.payouts[b.type];
      const win = b.covered.includes(number) ? amountN * BigInt(payout) : 0n;
      returned += win;
      return { ...b, payout, win: win.toString() };
    });
    // Multiplicador sobre la apuesta total (floor a 1e-4, misma precisión que applyMultiplier).
    const multiplier = Number((returned * 10000n) / total) / 10000;
    const color = number === 0 ? 'green' : RED.includes(number) ? 'red' : 'black';
    return { multiplier, outcome: { number, color, bets: detail }, bonusTriggered: false };
  },
};
