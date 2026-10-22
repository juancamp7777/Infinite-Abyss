import type { BonusPhase, BonusStatus, BonusTemplate, PlayerBonus } from '../domain/bonus';
import type { DropAward, DropCampaign, DropPrize } from '../domain/drops';
import type { Jackpot, JackpotContribution, JackpotLevel, JackpotLevelKey, JackpotSeedFunding, JackpotWin, TriggerDecision } from '../domain/jackpot';

// ───────────────────────────── Bonos ─────────────────────────────

export type NewBonusTemplate = Omit<BonusTemplate, 'id' | 'usesCount' | 'createdAt' | 'updatedAt'>;
export type BonusTemplatePatch = Partial<Omit<BonusTemplate, 'id' | 'operatorId' | 'type' | 'usesCount' | 'createdAt' | 'updatedAt'>>;
export type NewPlayerBonus = Omit<PlayerBonus, 'id' | 'createdAt'> & { id?: string };

export interface BonusListFilter {
  operatorId?: string;
  playerId?: string;
  status?: BonusStatus[];
  limit?: number;
  offset?: number;
}

export interface SettledRoundInput {
  operatorId: string;
  playerId: string;
  currency: string;
  roundId: string;
  amount: bigint;
  win: bigint;
  at: Date;
}

export interface PlayerNetResult {
  playerId: string;
  wagered: bigint;
  won: bigint;
}

export interface BonusRepository {
  createTemplate(t: NewBonusTemplate): Promise<BonusTemplate>;
  updateTemplate(id: string, patch: BonusTemplatePatch): Promise<BonusTemplate | null>;
  deleteTemplate(id: string): Promise<boolean>;
  getTemplate(id: string): Promise<BonusTemplate | null>;
  listTemplates(operatorId?: string): Promise<BonusTemplate[]>;
  findTemplateByCode(operatorId: string, code: string): Promise<BonusTemplate | null>;
  listAutoDepositTemplates(operatorId: string, currency: string): Promise<BonusTemplate[]>;
  countBonusesByTemplate(templateId: string): Promise<number>;
  /**
   * Reserva atómicamente un uso del código respetando maxUsesTotal y maxUsesPerPlayer.
   * Devuelve 'OK' o el límite que se alcanzó.
   */
  reserveCodeUse(templateId: string, playerId: string): Promise<'OK' | 'TOTAL_LIMIT' | 'PLAYER_LIMIT'>;
  /** Deshace una reserva cuando el otorgamiento falla después de reservar. */
  releaseCodeUse(templateId: string, playerId: string): Promise<void>;

  /** Idempotente por (operatorId, sourceRef) si sourceRef no es null. */
  createBonus(b: NewPlayerBonus): Promise<{ bonus: PlayerBonus; created: boolean }>;
  getBonus(id: string): Promise<PlayerBonus | null>;
  findBySourceRef(operatorId: string, sourceRef: string): Promise<PlayerBonus | null>;
  listBonuses(filter: BonusListFilter): Promise<PlayerBonus[]>;
  findOpenBonuses(operatorId: string, playerId: string): Promise<PlayerBonus[]>;
  listExpired(now: Date, limit: number): Promise<PlayerBonus[]>;
  /** Bonos con movimientos de billetera pendientes (grant sin txId o liquidación sin txId). */
  listUnsettled(limit: number): Promise<PlayerBonus[]>;
  /** Actualización condicional (CAS): solo aplica si el estado/fase actuales coinciden. */
  updateIf(id: string, expect: { status?: BonusStatus[]; phase?: BonusPhase }, patch: Partial<PlayerBonus>): Promise<PlayerBonus | null>;
  /** Suma contribución de una ronda (dedupe por roundId) si el bono sigue ACTIVE en fase WAGERING. */
  addWagering(bonusId: string, roundId: string, contribution: bigint): Promise<PlayerBonus | null>;
  /** Consume un giro gratis (dedupe por roundId) si quedan; null si no quedan o ya se consumió esa ronda. */
  consumeFreeSpin(bonusId: string, roundId: string): Promise<PlayerBonus | null>;
  /** Registra la ganancia de un giro gratis (dedupe por roundId). */
  addFreeSpinWin(bonusId: string, roundId: string, win: bigint): Promise<PlayerBonus | null>;

  /** Registra una ronda liquidada para el cálculo de cashback; false si ya existía. */
  recordSettledRound(r: SettledRoundInput): Promise<boolean>;
  /** Apostado y ganado por jugador en [from, to). */
  netResults(operatorId: string, currency: string, from: Date, to: Date): Promise<PlayerNetResult[]>;
}

// ───────────────────────────── Jackpots ─────────────────────────────

export type NewJackpot = Omit<Jackpot, 'id' | 'createdAt' | 'updatedAt'>;
export type JackpotPatch = Partial<Pick<Jackpot, 'name' | 'contributionBps' | 'minBet' | 'gameIds' | 'categories' | 'status'>> & {
  /** Solo cambia la configuración (semilla, share, probabilidad, mustDropBy); el valor actual no se toca. */
  levels?: Array<Pick<JackpotLevel, 'key' | 'seedAmount' | 'shareBps' | 'triggerChancePpm' | 'mustDropBy'>>;
};

export interface ContributionInput {
  jackpotId: string;
  operatorId: string;
  playerId: string;
  currency: string;
  roundId: string;
  gameId: string;
  betAmount: bigint;
}

export interface ContributionHooks {
  /** Reparto de la contribución entre niveles (se calcula con los niveles bloqueados). */
  split(jackpot: Jackpot): { total: bigint; perLevel: Partial<Record<JackpotLevelKey, bigint>> };
  /** Disparos a aplicar tras sumar (recibe los niveles ya incrementados). */
  decide(levels: JackpotLevel[]): TriggerDecision[];
}

export interface ContributionResult {
  duplicate: boolean;
  /** Ganancias de la ronda pendientes de pago (nuevas o de un intento anterior). */
  wins: JackpotWin[];
  jackpot: Jackpot | null;
}

export interface JackpotLevelReport {
  key: JackpotLevelKey;
  contributions: bigint;
  seedFunding: bigint;
  payouts: bigint;
  current: bigint;
}

export interface JackpotReport {
  jackpotId: string;
  contributions: bigint;
  seedFunding: bigint;
  payouts: bigint;
  paidOut: bigint;
  pendingPayouts: bigint;
  pools: bigint;
  winsCount: number;
  levels: JackpotLevelReport[];
}

export interface JackpotRepository {
  /** Crea el jackpot y registra la semilla inicial de cada nivel como seed funding INITIAL. */
  create(j: NewJackpot): Promise<Jackpot>;
  update(id: string, patch: JackpotPatch): Promise<Jackpot | null>;
  get(id: string): Promise<Jackpot | null>;
  list(operatorId?: string): Promise<Jackpot[]>;
  /**
   * Atómico por jackpot: dedupe por (jackpotId, roundId); suma la contribución; aplica disparos
   * (crea el JackpotWin PENDING con el valor del pozo, reinicia a la semilla y registra el seed funding RESEED).
   */
  contribute(input: ContributionInput, hooks: ContributionHooks): Promise<ContributionResult>;
  markWinPaid(winId: string, txId: string, at: Date): Promise<JackpotWin | null>;
  listPendingWins(limit: number): Promise<JackpotWin[]>;
  listWins(jackpotId: string, limit: number): Promise<JackpotWin[]>;
  listContributions(jackpotId: string, limit: number): Promise<JackpotContribution[]>;
  listSeedFunding(jackpotId: string): Promise<JackpotSeedFunding[]>;
  report(jackpotId: string): Promise<JackpotReport | null>;
}

// ───────────────────────────── Drops & wins ─────────────────────────────

export type NewDropCampaign = Omit<DropCampaign, 'id' | 'createdAt' | 'prizes'> & { prizes: Array<Pick<DropPrize, 'amount' | 'quantity'>> };
export type DropCampaignPatch = Partial<Pick<DropCampaign, 'name' | 'startsAt' | 'endsAt' | 'minBet' | 'dropChancePpm' | 'gameIds' | 'status'>>;

export interface DropRepository {
  create(c: NewDropCampaign): Promise<DropCampaign>;
  update(id: string, patch: DropCampaignPatch): Promise<DropCampaign | null>;
  get(id: string): Promise<DropCampaign | null>;
  list(operatorId?: string): Promise<DropCampaign[]>;
  /**
   * Atómico por campaña: dedupe por (campaignId, roundId); elige un premio con stock con `pick`,
   * incrementa awarded sin exceder quantity y crea el DropAward PENDING. null si duplicado o sin stock.
   */
  award(
    input: { campaignId: string; operatorId: string; playerId: string; currency: string; roundId: string },
    pick: (prizes: DropPrize[]) => DropPrize | null,
  ): Promise<{ award: DropAward | null; duplicate: boolean }>;
  markAwardPaid(awardId: string, txId: string): Promise<DropAward | null>;
  listPendingAwards(limit: number): Promise<DropAward[]>;
  listAwards(campaignId: string, limit: number): Promise<DropAward[]>;
}
