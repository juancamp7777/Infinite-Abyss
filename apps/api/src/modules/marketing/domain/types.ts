/** Tipos de dominio del módulo de marketing. Fechas ISO-8601; montos como string en unidades mínimas. */

export type ChannelKind = 'email' | 'sms' | 'whatsapp' | 'push' | 'inapp';
export const CHANNEL_KINDS: readonly ChannelKind[] = ['email', 'sms', 'whatsapp', 'push', 'inapp'];

export interface ChannelMessage {
  /** Id del MktSendLog (sirve para tracking de aperturas/clics). */
  sendId: string;
  operatorId: string;
  playerId: string;
  /** Dirección de destino: email, teléfono E.164 (null en push/inapp). */
  to?: string;
  subject?: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  meta?: Record<string, unknown>;
}

export interface Channel {
  readonly kind: ChannelKind;
  send(msg: ChannelMessage): Promise<{ providerMessageId: string }>;
}

/** 'marketing' pasa por el guard de cumplimiento; 'transactional'/'regulatory' van por sendTransactional. */
export type TemplateKind = 'marketing' | 'transactional' | 'regulatory';

export interface Template {
  id: string;
  operatorId: string;
  name: string;
  channel: ChannelKind;
  kind: TemplateKind;
  subject?: string;
  /** Email: HTML. Resto de canales: texto plano. */
  body: string;
  /** Push: imagen grande, página al tocar y hasta 2 botones (Android y escritorio; iPhone muestra título y texto). */
  push?: PushDesign;
  createdAt: string;
  updatedAt: string;
}

export interface PushDesign {
  image?: string;
  url?: string;
  actions?: Array<{ title: string; url: string }>;
}

export interface OperatorBrand {
  /** = operatorId */
  id: string;
  operatorId: string;
  name: string;
  logoUrl?: string;
  primaryColor?: string;
  supportEmail?: string;
  /** Dominios (y subdominios) permitidos en los enlaces con tracking de clics. */
  linkDomains: string[];
}

export interface CampaignVariant {
  key: string;
  templateId: string;
  weight: number;
}

export type CampaignStatus = 'draft' | 'scheduled' | 'active' | 'running' | 'done' | 'paused';

export interface Campaign {
  id: string;
  operatorId: string;
  name: string;
  status: CampaignStatus;
  /** One-shot: segmento destino + fecha programada. */
  segmentId?: string;
  scheduledAt?: string;
  /** Disparada por evento (status 'active'). Si hay segmentId, el jugador debe pertenecer a él. */
  triggerEvent?: 'player.registered' | 'deposit.completed' | 'login' | 'bet.settled';
  variants: CampaignVariant[];
  conversionWindowDays: number;
  stats: { audience: number; processed: number };
  createdAt: string;
  updatedAt: string;
}

export type JourneyTrigger =
  | { type: 'event'; event: 'player.registered' | 'deposit.completed' | 'login' | 'bet.settled'; cancelOn?: Array<'deposit.completed' | 'login'>;
      /** Solo bet.settled: pérdida neta acumulada (unidades mínimas, string) y ventana. */
      lossThreshold?: string; windowHours?: number }
  | { type: 'time'; condition: 'depositor_inactive'; days: number; cancelOn?: Array<'deposit.completed' | 'login'> }
  | { type: 'time'; condition: 'birthday'; cancelOn?: never[] };

export type JourneyStep =
  | { type: 'wait'; minutes: number }
  | { type: 'condition'; check: 'no_deposit' | 'has_deposited' | 'inactive_since_deposit_days'; value?: number }
  | { type: 'send'; templateId: string }
  | { type: 'action'; action: 'grantCashback'; percentBps: number };

export interface Journey {
  id: string;
  operatorId: string;
  name: string;
  status: 'active' | 'paused';
  trigger: JourneyTrigger;
  steps: JourneyStep[];
  createdAt: string;
  updatedAt: string;
}

export interface JourneyRun {
  id: string;
  operatorId: string;
  journeyId: string;
  playerId: string;
  stepIndex: number;
  status: 'running' | 'done' | 'cancelled';
  dueAt?: string;
  cycleKey: string;
  context: Record<string, string>;
  endedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type PixelEvent = 'registration' | 'ftd' | 'page';

export interface Affiliate {
  id: string;
  operatorId: string;
  code: string;
  name: string;
  /** Plantilla con {click_id} {player_id} {event} {amount}. https salvo en desarrollo. */
  postbackUrl?: string;
  pixels: Array<{ event: PixelEvent; html: string }>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Attribution {
  id: string; // `${operatorId}:${playerId}`
  operatorId: string;
  playerId: string;
  affiliateCode?: string;
  clickId?: string;
  utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string };
  createdAt: string;
}

export interface PostbackLog {
  id: string; // `${operatorId}:${playerId}:${event}`
  operatorId: string;
  playerId: string;
  affiliateId: string;
  event: 'registration' | 'ftd';
  url: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  httpStatus?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Consent {
  id: string; // `${operatorId}:${playerId}:${channel}`
  operatorId: string;
  playerId: string;
  channel: ChannelKind;
  optIn: boolean;
  source: string;
  at: string;
  history: Array<{ optIn: boolean; source: string; at: string }>;
}

export type ExclusionReason =
  | 'NO_OPT_IN'
  | 'SELF_EXCLUDED'
  | 'ACTIVE_LIMITS'
  | 'MINOR'
  | 'AGE_NOT_VERIFIED'
  | 'FREQUENCY_CAP'
  | 'COMPLIANCE_UNAVAILABLE'
  | 'NO_ADDRESS';

export interface SendLog {
  id: string;
  operatorId: string;
  playerId: string;
  channel: ChannelKind;
  kind: TemplateKind;
  /** campaignId o journeyId (métricas). */
  refId?: string;
  refType?: 'campaign' | 'journey';
  variant?: string;
  templateId: string;
  status: 'queued' | 'sent' | 'excluded' | 'failed';
  reason?: ExclusionReason | string;
  providerMessageId?: string;
  at: string;
  openedAt?: string;
  clickedAt?: string;
  convertedAt?: string;
  conversionAmount?: string;
}

export interface InboxMessage {
  id: string;
  operatorId: string;
  playerId: string;
  subject?: string;
  body: string;
  sendId: string;
  readAt?: string;
  createdAt: string;
}

export interface PushSubscription {
  id: string; // hash del endpoint
  operatorId: string;
  playerId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}

export interface PlayerState {
  id: string; // `${operatorId}:${playerId}`
  operatorId: string;
  playerId: string;
  email?: string;
  firstName?: string;
  /** YYYY-MM-DD */
  birthDate?: string;
  birthChecked?: boolean;
  currency?: string;
  registeredAt?: string;
  depositCount: number;
  lastDepositAt?: string;
  lastLoginAt?: string;
  /** Resultado neto (win - amount, string) por apuesta liquidada, podado a la ventana máxima. */
  recent: Array<{ at: string; net: string }>;
}
