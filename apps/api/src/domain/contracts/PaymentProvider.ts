/** Contrato de pasarela de pago. Implementan Passimpay, Wompi y Bold. */
export type PaymentProviderName = 'PASSIMPAY' | 'WOMPI' | 'BOLD';

export interface CreateDepositInput {
  operatorId: string;
  userId: string;
  depositId: string;
  /** orderId que enviamos al PSP (Deposit.providerReference). */
  providerReference: string;
  amount: bigint;
  currency: string;
  /** Datos del jugador para el PSP (email, etc.). */
  customerEmail?: string;
  returnUrl?: string;
}

export interface CreateDepositResult {
  providerReference: string;
  externalId?: string;
  redirectUrl?: string;
  /** Dirección cripto si el PSP la entrega. */
  address?: string;
  raw: unknown;
}

export interface WebhookVerificationInput {
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  sourceIp?: string;
}

export type ProviderEventStatus = 'CONFIRMED' | 'FAILED' | 'PENDING';

export interface ProviderEvent {
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  providerReference?: string;
  externalId: string;
  status: ProviderEventStatus;
  amount?: bigint;
  currency?: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** Clave de idempotencia del evento (id de transacción del PSP + estado). null si no válida. */
  dedupeKey: string | null;
  event?: ProviderEvent;
}

export interface RequestPayoutInput {
  operatorId: string;
  withdrawalId: string;
  amount: bigint;
  currency: string;
  destination: Record<string, unknown>;
}

export interface RequestPayoutResult {
  externalId: string;
  status: 'PROCESSING' | 'PAID' | 'FAILED';
  raw: unknown;
}

export interface ProviderStatusResult {
  status: ProviderEventStatus;
  externalId?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly code: PaymentProviderName;
  /** false si faltan credenciales de entorno. */
  isEnabled(): boolean;
  /** Pasarelas con llaves por casino (Integraciones): si este casino la conectó. */
  isEnabledFor?(operatorId: string): Promise<boolean>;
  createDeposit(input: CreateDepositInput): Promise<CreateDepositResult>;
  verifyWebhook(input: WebhookVerificationInput): WebhookVerificationResult | Promise<WebhookVerificationResult>;
  requestPayout(input: RequestPayoutInput): Promise<RequestPayoutResult>;
  getStatus(ref: { providerReference?: string; externalId?: string }): Promise<ProviderStatusResult>;
}
