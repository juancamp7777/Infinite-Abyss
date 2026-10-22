/** Tipos y valores por defecto del módulo de gamificación. Montos bigint (minor units), porcentajes en bps. */
import { DEV_FALLBACK_CURRENCY } from '../../shared/ports/OperatorCurrencyPort';

export type RewardSpec =
  | { type: 'points'; points: bigint }
  /** Bono: vía deps.services.promotions si existe (con promotionId); si no, credit BONUS_GRANT por `amount`. */
  | { type: 'bonus'; amount: bigint; promotionId?: string };

export interface VipLevel {
  id: string;
  operatorId: string;
  name: string;
  order: number;
  pointsRequired: bigint;
  /** Porcentaje de la ventaja de la casa devuelto al jugador (bps). */
  rakebackBps: number;
  benefits: unknown;
  levelUpBonus: bigint;
}

export interface VipPlayer {
  playerId: string;
  points: bigint;
  wagered: bigint;
  levelId: string;
  /** Resto de apuesta por categoría que aún no completa 1 punto. */
  remainders: Record<string, bigint>;
  rakebackPending: bigint;
  /** Fracción sub-unidad acumulada (numerador sobre 1e8). */
  rakebackFrac: bigint;
  lastRakebackPeriod?: string;
  rakebackIntent?: { period: string; amount: bigint };
}

export type RakebackPeriod = 'daily' | 'weekly';

export interface WheelPrize {
  id: string;
  label: string;
  /** Peso entero > 0. */
  weight: number;
  reward: RewardSpec;
}

export interface WheelConfig {
  enabled: boolean;
  cooldownHours: number;
  /** Valor esperado máximo por giro (minor units); se valida al guardar y al girar. */
  maxExpectedValue: bigint;
  prizes: WheelPrize[];
}

export interface OperatorSettings {
  timezone: string;
  currency: string;
  /** Ventaja de la casa por categoría (bps) para calcular rakeback. Clave 'default' como respaldo. */
  houseEdgeBps: Record<string, number>;
  /** Unidades apostadas por cada punto VIP, por categoría. */
  unitsPerPoint: Record<string, bigint>;
  rakebackPeriod: RakebackPeriod;
  streakRewards: Array<{ day: number; reward: RewardSpec }>;
  wheel: WheelConfig;
}

export type MissionType = 'wager' | 'rounds' | 'multiplier' | 'deposit';

export interface Mission {
  id: string;
  operatorId: string;
  name: string;
  description?: string;
  period: 'daily' | 'weekly';
  type: MissionType;
  /** Monto (wager/deposit) o cantidad (rounds/multiplier). */
  target: bigint;
  category?: string;
  gameId?: string;
  minMultiplier?: number;
  reward: RewardSpec;
  active: boolean;
}

export interface MissionProgress {
  progress: bigint;
  claimedAt?: number;
}

export type AchievementMetric =
  | 'total_wagered'
  | 'total_won'
  | 'deposit_total'
  | 'rounds'
  | 'biggest_multiplier'
  | 'login_streak'
  | 'deposit_count';

export interface Achievement {
  id: string;
  operatorId: string;
  name: string;
  description?: string;
  icon?: string;
  criteria: { metric: AchievementMetric; value: bigint | number };
  reward?: RewardSpec;
  active: boolean;
}

export interface PlayerStats {
  totalWagered: bigint;
  totalWon: bigint;
  rounds: number;
  biggestMultiplier: number;
  depositCount: number;
  depositTotal: bigint;
  loginStreak: number;
}

export interface StreakState {
  current: number;
  best: number;
  lastDate?: string;
}

export type TournamentMetric = 'highest_multiplier' | 'total_points' | 'total_wagered';

export interface Tournament {
  id: string;
  operatorId: string;
  name: string;
  gameIds: string[];
  categories: string[];
  minBet: bigint;
  startsAt: number;
  endsAt: number;
  metric: TournamentMetric;
  /** Unidades apostadas por punto (métrica total_points). */
  unitsPerPoint: bigint;
  buyIn: bigint;
  currency: string;
  prizes: Array<{ position: number; amount: bigint }>;
  status: 'open' | 'closing' | 'finished' | 'cancelled';
  results?: Array<{ position: number; playerId: string; score: bigint; amount: bigint }>;
  closedAt?: number;
}

export interface TournamentEntry {
  playerId: string;
  tournamentId: string;
  joinedAt: number;
  wagered: bigint;
  /** highest_multiplier: multiplicador×10000; total_points: puntos; total_wagered: monto. */
  score: bigint;
  /** Orden de llegada al puntaje actual (menor = antes). Desempata. */
  reachedSeq: number;
  rounds: number;
}

/**
 * Factor de los montos por defecto (unidades por punto, bonos de rachas/rueda/niveles) según la moneda,
 * para que tengan sentido en monedas de bajo valor: 1 punto = 1 USD (100 centavos) y 1.000 COP (100.000 centavos).
 */
export function currencyAmountScale(currency: string): bigint {
  return CURRENCY_AMOUNT_SCALE[currency.toUpperCase()] ?? 1n;
}
const CURRENCY_AMOUNT_SCALE: Readonly<Record<string, bigint>> = { COP: 1000n };

/** `currency` = defaultCurrency del operador (o el respaldo del dev-server); nunca una moneda fija. */
export function defaultSettings(currency: string = DEV_FALLBACK_CURRENCY): OperatorSettings {
  const k = currencyAmountScale(currency);
  return {
    timezone: 'UTC',
    currency,
    houseEdgeBps: { default: 400, slots: 350, originals: 100, live: 250, table: 200, other: 400 },
    unitsPerPoint: { default: 100n * k },
    rakebackPeriod: 'weekly',
    streakRewards: [
      { day: 1, reward: { type: 'points', points: 5n } },
      { day: 3, reward: { type: 'points', points: 25n } },
      { day: 5, reward: { type: 'bonus', amount: 100n * k } },
      { day: 7, reward: { type: 'bonus', amount: 500n * k } },
    ],
    wheel: {
      enabled: true,
      cooldownHours: 24,
      maxExpectedValue: 500n * k,
      prizes: [
        { id: 'p10', label: '10 puntos', weight: 40, reward: { type: 'points', points: 10n } },
        { id: 'p50', label: '50 puntos', weight: 20, reward: { type: 'points', points: 50n } },
        { id: 'b100', label: 'Bono pequeño', weight: 25, reward: { type: 'bonus', amount: 100n * k } },
        { id: 'b500', label: 'Bono medio', weight: 10, reward: { type: 'bonus', amount: 500n * k } },
        { id: 'b2500', label: 'Bono grande', weight: 5, reward: { type: 'bonus', amount: 2500n * k } },
      ],
    },
  };
}

/** Niveles VIP por defecto; el bono de subida se escala con la moneda del operador. */
export function defaultLevels(operatorId: string, currency: string = DEV_FALLBACK_CURRENCY): VipLevel[] {
  const k = currencyAmountScale(currency);
  const rows: Array<[string, string, bigint, number, bigint, string]> = [
    ['bronze', 'Bronze', 0n, 500, 0n, 'Acceso al programa VIP'],
    ['silver', 'Silver', 1000n, 1000, 500n, 'Rakeback semanal mejorado'],
    ['gold', 'Gold', 5000n, 1500, 2500n, 'Misiones exclusivas'],
    ['platinum', 'Platinum', 20000n, 2000, 10000n, 'Gestor de cuenta y retiros prioritarios'],
    ['diamond', 'Diamond', 100000n, 2500, 50000n, 'Eventos y regalos exclusivos'],
    ['elite', 'Abyss Elite', 500000n, 3500, 250000n, 'Atención 24/7 y beneficios a medida'],
  ];
  return rows.map(([id, name, pointsRequired, rakebackBps, levelUpBonus, benefits], i) => ({
    id,
    operatorId,
    name,
    order: i,
    pointsRequired,
    rakebackBps,
    benefits,
    levelUpBonus: levelUpBonus * k,
  }));
}

/** Valor esperado del giro como fracción: sum(peso*valor) / sum(peso). Los puntos valen 0. */
export function wheelExpectedValue(w: WheelConfig): { num: bigint; den: bigint } {
  let num = 0n;
  let den = 0n;
  for (const p of w.prizes) {
    const val = p.reward.type === 'bonus' ? p.reward.amount : 0n;
    num += BigInt(p.weight) * val;
    den += BigInt(p.weight);
  }
  return { num, den };
}

/** Devuelve un mensaje de error si la configuración de la rueda no es válida; null si es válida. */
export function validateWheel(w: WheelConfig): string | null {
  if (w.prizes.length === 0) return 'La rueda necesita al menos un premio';
  if (new Set(w.prizes.map((p) => p.id)).size !== w.prizes.length) return 'Ids de premio duplicados';
  if (w.prizes.some((p) => !Number.isInteger(p.weight) || p.weight <= 0)) return 'Los pesos deben ser enteros > 0';
  if (!(w.cooldownHours > 0)) return 'cooldownHours debe ser > 0';
  const { num, den } = wheelExpectedValue(w);
  if (num > w.maxExpectedValue * den) return 'El valor esperado de la rueda supera maxExpectedValue';
  return null;
}
