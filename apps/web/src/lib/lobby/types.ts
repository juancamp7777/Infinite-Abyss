/** Tipos del lobby. Los montos bigint viajan como string (unidades mínimas). */
export type Category = 'slots' | 'originals' | 'live' | 'table' | 'other';

export interface Game {
  id: string;
  providerId: string;
  providerName: string;
  title: string;
  category: Category;
  mechanic: string;
  rtp: number;
  volatility: 'low' | 'medium' | 'high' | 'very_high';
  images: { thumb: string; banner: string };
  tags: string[];
  hasDemo: boolean;
  releasedAt: string;
  popularity: number;
  isNew: boolean;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface Provider { id: string; name: string; type: string; config: Record<string, unknown> }
export interface GameQuery { category?: string; provider?: string; q?: string; sort?: 'new' | 'popular' | 'az'; tag?: string; pageSize?: number }

export interface JackpotLevel { key: string; amount: string; mustDropBy?: string | null }
export interface Jackpot { id: string; name: string; currency: string; levels: JackpotLevel[] }

export type Reward = { type: 'points'; points: string } | { type: 'bonus'; amount: string; promotionId?: string };
export interface VipState {
  level: { id: string; name: string; rakebackBps: number; benefits: unknown };
  points: string;
  wagered: string;
  next: { id: string; name: string; pointsRequired: string; benefits: unknown } | null;
  pointsToNext: string;
  progressPct: number;
  rakeback: { pending: string; period: string; claimedThisPeriod: boolean; claimable: boolean };
}
export interface Mission {
  id: string; name: string; description: string | null; period: 'daily' | 'weekly';
  type: string; target: string; progress: string; completed: boolean; claimed: boolean; reward: Reward;
}
export interface Streak {
  current: number; best: number; loggedToday: boolean;
  nextReward: { day: number; reward: Reward } | null;
  rewards: { day: number; reward: Reward }[];
}
export interface WheelPrize { id: string; label: string; weight: number; reward: Reward }
export interface WheelStatus { enabled: boolean; canSpin: boolean; nextSpinAt: number | null; prizes: WheelPrize[] }
export interface WheelResult { prize: { id: string; label: string; reward: Reward }; nextSpinAt: number }

export type TournamentMetric = 'highest_multiplier' | 'total_points' | 'total_wagered';
export interface Tournament {
  id: string; name: string; status: string; metric: TournamentMetric; startsAt: number; endsAt: number;
  minBet: string; buyIn: string; currency: string; gameIds: string[]; categories: string[];
  prizes: { position: number; amount: string }[]; players: number; joined: boolean;
}
export interface LeaderboardRow { rank: number; player: string; isMe: boolean; score: string }
export interface Leaderboard {
  tournamentId: string; status: string; metric: TournamentMetric; top: LeaderboardRow[];
  me: { rank: number; score: string } | null; totalPlayers: number;
}

export interface Skin {
  name: string; logoUrl?: string | null;
  colors: { primary: string; secondary: string; background: string; surface: string; text: string; accent: string };
  /** imageUrl = foto de portada (cover); art = ilustración flotante de la web (solo banners por defecto); cta = texto del botón. */
  banners: { title: string; subtitle?: string; imageUrl?: string; href: string; art?: string; cta?: string }[];
}
export interface Balance { balance: string; currency: string }
export interface LaunchResult { url: string; sessionId?: string; expiresAt?: string }

/** Apuesta liquidada del feed en vivo (módulo feed). El jugador llega con alias, nunca con su id. */
export type FeedKind = 'all' | 'high' | 'lucky';
export interface FeedBet {
  id: string; gameId: string; gameTitle: string; provider: string; category: string; player: string;
  currency: string; amount: string; win: string; multiplier: number; at: string;
  isMe?: boolean; kinds?: FeedKind[];
}
