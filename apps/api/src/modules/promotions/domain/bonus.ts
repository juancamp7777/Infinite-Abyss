import { applyBps, minBigint } from '../../shared/money';
import { PromoError } from './common';

export type BonusType = 'deposit_match' | 'free_spins' | 'cashback' | 'promo_code';
export const BONUS_TYPES: readonly BonusType[] = ['deposit_match', 'free_spins', 'cashback', 'promo_code'];

export type BonusStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'FORFEITED' | 'CANCELLED';
export const OPEN_STATUSES: readonly BonusStatus[] = ['PENDING', 'ACTIVE'];

/** BONUS: requisito = multiplicador × bono. BONUS_PLUS_DEPOSIT: multiplicador × (bono + depósito). */
export type WageringBase = 'BONUS' | 'BONUS_PLUS_DEPOSIT';
/** SPINS: el jugador aún tiene giros gratis; WAGERING: hay saldo de bono sujeto a rollover. */
export type BonusPhase = 'SPINS' | 'WAGERING';
export type BonusSource = 'CODE' | 'DEPOSIT' | 'MANUAL' | 'CASHBACK' | 'SERVICE';

/** Contribución al wagering por categoría (bps). Solo es el valor por defecto al crear plantillas: cada plantilla guarda la suya. */
export const DEFAULT_CONTRIBUTION_BPS: Readonly<Record<string, number>> = Object.freeze({
  slots: 10000,
  originals: 5000,
  live: 1000,
  table: 1000,
  other: 0,
});

export interface BonusTemplate {
  id: string;
  operatorId: string;
  name: string;
  type: BonusType;
  status: 'ACTIVE' | 'INACTIVE';
  currency: string;
  /** Código canjeable (único por operador, en mayúsculas). Obligatorio para promo_code. */
  code: string | null;
  maxUsesTotal: number | null;
  maxUsesPerPlayer: number | null;
  usesCount: number;
  validFrom: Date | null;
  validTo: Date | null;
  /** deposit_match: se otorga solo en deposit.completed sin código. */
  autoOnDeposit: boolean;
  firstDepositOnly: boolean;
  /** Permite convivir con otros bonos abiertos del jugador. */
  stackable: boolean;
  // deposit_match
  matchBps: number | null;
  minDeposit: bigint | null;
  /** Tope del bono (deposit_match y cashback). */
  maxBonusAmount: bigint | null;
  // promo_code
  fixedAmount: bigint | null;
  // free_spins
  freeSpinGameId: string | null;
  freeSpinCount: number | null;
  freeSpinValue: bigint | null;
  // cashback
  cashbackBps: number | null;
  // reglas de wagering
  wageringMultiplier: number;
  wageringBase: WageringBase;
  contributionBps: Record<string, number>;
  excludedGameIds: string[];
  maxBet: bigint | null;
  /** Máximo convertible a cash al completar (null = sin tope). */
  maxConversion: bigint | null;
  /** Vigencia del bono activo. */
  validityHours: number;
  /** Ventana para depositar tras reclamar un deposit_match por código (estado PENDING). */
  claimWindowHours: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlayerBonus {
  id: string;
  operatorId: string;
  playerId: string;
  templateId: string | null;
  type: BonusType;
  status: BonusStatus;
  phase: BonusPhase;
  currency: string;
  source: BonusSource;
  /** Clave de idempotencia de origen (único por operador): depósito, periodo de cashback, motivo de servicio… */
  sourceRef: string | null;
  amount: bigint;
  depositAmount: bigint;
  wageringMultiplier: number;
  wageringBase: WageringBase;
  wageringRequired: bigint;
  wageringProgress: bigint;
  contributionBps: Record<string, number>;
  excludedGameIds: string[];
  maxBet: bigint | null;
  maxConversion: bigint | null;
  freeSpinGameId: string | null;
  freeSpinsTotal: number;
  freeSpinsUsed: number;
  freeSpinsSettled: number;
  freeSpinValue: bigint | null;
  freeSpinWin: bigint;
  validityHours: number;
  expiresAt: Date | null;
  grantTxId: string | null;
  /** Monto a convertir (COMPLETED) o a retirar (FORFEITED/CANCELLED) del saldo de bono. */
  settlementAmount: bigint;
  settlementTxId: string | null;
  statusReason: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  closedAt: Date | null;
}

const TRANSITIONS: Readonly<Record<BonusStatus, readonly BonusStatus[]>> = {
  PENDING: ['ACTIVE', 'FORFEITED', 'CANCELLED'],
  ACTIVE: ['COMPLETED', 'FORFEITED', 'CANCELLED'],
  COMPLETED: [],
  FORFEITED: [],
  CANCELLED: [],
};

export function canTransition(from: BonusStatus, to: BonusStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Estados de origen válidos para llegar a `to`. */
export function sourcesFor(to: BonusStatus): BonusStatus[] {
  return (Object.keys(TRANSITIONS) as BonusStatus[]).filter((s) => TRANSITIONS[s].includes(to));
}

export function assertTransition(from: BonusStatus, to: BonusStatus): void {
  if (!canTransition(from, to)) {
    throw new PromoError(409, 'INVALID_TRANSITION', `Transición de bono inválida: ${from} → ${to}`);
  }
}

export const isTerminal = (s: BonusStatus): boolean => TRANSITIONS[s].length === 0;

export function wageringRequirement(multiplier: number, base: WageringBase, bonus: bigint, deposit: bigint): bigint {
  if (!Number.isInteger(multiplier) || multiplier < 0) throw new PromoError(400, 'BAD_REQUEST', 'Multiplicador de wagering inválido');
  return BigInt(multiplier) * (base === 'BONUS' ? bonus : bonus + deposit);
}

/** bps de contribución de una apuesta: 0 si el juego está excluido; si no, la categoría o 'default'. */
export function contributionBpsFor(bonus: Pick<PlayerBonus, 'contributionBps' | 'excludedGameIds'>, category: string, gameId: string): number {
  if (bonus.excludedGameIds.includes(gameId)) return 0;
  const v = bonus.contributionBps[category] ?? bonus.contributionBps.default ?? 0;
  return Math.max(0, Math.min(10000, Math.trunc(v)));
}

export function wageringContribution(bonus: Pick<PlayerBonus, 'contributionBps' | 'excludedGameIds'>, category: string, gameId: string, amount: bigint): bigint {
  return applyBps(amount, contributionBpsFor(bonus, category, gameId));
}

export function depositMatchAmount(t: Pick<BonusTemplate, 'matchBps' | 'maxBonusAmount'>, deposit: bigint): bigint {
  const raw = applyBps(deposit, t.matchBps ?? 0);
  return t.maxBonusAmount != null ? minBigint(raw, t.maxBonusAmount) : raw;
}

export function cashbackAmount(t: Pick<BonusTemplate, 'cashbackBps' | 'maxBonusAmount'>, netLoss: bigint): bigint {
  if (netLoss <= 0n) return 0n;
  const raw = applyBps(netLoss, t.cashbackBps ?? 0);
  return t.maxBonusAmount != null ? minBigint(raw, t.maxBonusAmount) : raw;
}

/** Progreso de rollover en bps (0–10000) para mostrar barras. */
export function progressBps(b: Pick<PlayerBonus, 'wageringRequired' | 'wageringProgress' | 'status'>): number {
  if (b.status === 'COMPLETED') return 10000;
  if (b.wageringRequired <= 0n) return 0;
  const p = (b.wageringProgress * 10000n) / b.wageringRequired;
  return Number(p > 10000n ? 10000n : p);
}

export const normalizeCode = (code: string): string => code.trim().toUpperCase();
