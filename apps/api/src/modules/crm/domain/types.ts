import type { UtmParams } from '../../shared/events/EventBus';
import type { Rule } from '../../shared/ports/SegmentPort';

/** Perfil 360 almacenado: solo acumulados y fechas. Lo derivado (LTV, RFM, riesgo…) se calcula al leer. */
export interface CrmProfile {
  operatorId: string;
  playerId: string;
  currency?: string;
  country?: string;
  email?: string;
  /** YYYY-MM-DD */
  birthDate?: string;
  registeredAt?: string;
  firstDepositAt?: string;
  lastDepositAt?: string;
  lastLoginAt?: string;
  lastBetAt?: string;
  lastSessionAt?: string;
  /** Última actividad de cualquier tipo (login, sesión, apuesta, depósito, retiro). */
  lastActivityAt?: string;
  depositsTotal: bigint;
  depositsCount: number;
  withdrawalsTotal: bigint;
  withdrawalsCount: number;
  totalWagered: bigint;
  totalWon: bigint;
  betCount: number;
  sessionCount: number;
  loginCount: number;
  /** Días (YYYY-MM-DD UTC) con actividad; se conservan los últimos 90. */
  activeDays: string[];
  /** Monto apostado por juego / por categoría. */
  games: Record<string, bigint>;
  categories: Record<string, bigint>;
  tags: string[];
  utm?: UtmParams;
  affiliateCode?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChurnRisk = 'low' | 'medium' | 'high';

export interface Favorite {
  id: string;
  wagered: bigint;
}

/** Perfil enriquecido que se devuelve por API y sobre el que se evalúan los segmentos. */
export interface CrmPlayerView extends Omit<CrmProfile, 'activeDays' | 'games' | 'categories'> {
  /** LTV = depósitos − retiros (caja neta que ha dejado el jugador al operador). */
  ltv: bigint;
  /** GGR = apostado − ganado. */
  ggr: bigint;
  /** Días distintos con actividad en los últimos 30 días. */
  activeDays30: number;
  daysSinceLastActivity: number | null;
  favoriteGames: Favorite[];
  favoriteCategories: Favorite[];
  rfm: { r: number; f: number; m: number };
  /** 0–100 */
  vipScore: number;
  churnRisk: ChurnRisk;
}

export interface CrmNote {
  id: string;
  operatorId: string;
  playerId: string;
  authorId: string;
  text: string;
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  operatorId: string;
  playerId: string;
  /** p. ej. 'registered', 'deposit', 'withdrawal', 'big_win', 'note', 'ticket', 'tag', 'message' */
  type: string;
  title: string;
  data?: Record<string, unknown>;
  at: string;
}

export type TicketStatus = 'open' | 'pending' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketMessage {
  id: string;
  authorType: 'player' | 'agent';
  authorId: string;
  text: string;
  at: string;
}

export interface CrmTicket {
  id: string;
  operatorId: string;
  playerId: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignedTo?: string;
  messages: TicketMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface CrmSegment {
  id: string;
  operatorId: string;
  name: string;
  description?: string;
  rule: Rule;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}
