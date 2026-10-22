export interface OperatorLimits {
  /** Apuesta mínima/máxima por jugada (unidades mínimas, string de dígitos). */
  minBet?: string;
  maxBet?: string;
  minDeposit?: string;
  maxDeposit?: string;
  minWithdrawal?: string;
  maxWithdrawal?: string;
  maxDailyWithdrawal?: string;
  [key: string]: unknown;
}

export interface TenantContext {
  operatorId: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  currencies: string[];
  defaultCurrency: string;
  chipsEnabled: boolean;
  chipMinorUnitsPerChip: bigint | null;
  limits: OperatorLimits;
}
