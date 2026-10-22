export type ReconciliationCheckName =
  | 'TX_SUM_ZERO'
  | 'GLOBAL_SUM_ZERO'
  | 'CACHED_VS_DERIVED'
  | 'PSP_DEPOSITS_VS_CLEARING';

export interface ReconciliationDiscrepancy {
  /** Identificador del objeto afectado (txId, accountId, depositId, moneda…). */
  ref: string;
  detail: string;
  expected?: string;
  actual?: string;
  operatorId?: string;
  currency?: string;
}

export interface ReconciliationCheck {
  name: ReconciliationCheckName;
  passed: boolean;
  discrepancies: ReconciliationDiscrepancy[];
}

export interface ReconciliationReport {
  generatedAt: string;
  /** 'ALL' o el operatorId acotado. */
  scope: string;
  checks: ReconciliationCheck[];
  totalDiscrepancies: number;
}

export interface IReconciliationService {
  run(input?: { operatorId?: string }): Promise<ReconciliationReport>;
}
