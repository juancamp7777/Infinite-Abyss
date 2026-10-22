/** Estado de cumplimiento del jugador (lo provee la Fase 1: KYC, juego responsable, autoexclusión). */
export interface PlayerComplianceStatus {
  selfExcluded: boolean;
  hasActiveLimits: boolean;
  ageVerified: boolean;
  isMinor: boolean;
  country?: string;
  /** YYYY-MM-DD */
  birthDate?: string;
  email?: string;
  phone?: string;
  marketingConsentFromKyc?: boolean;
}

export interface PlayerCompliancePort {
  getStatus(operatorId: string, playerId: string): Promise<PlayerComplianceStatus>;
}

/** Estado por defecto para jugadores desconocidos: conservador (no verificado). */
export const DEFAULT_COMPLIANCE_STATUS: PlayerComplianceStatus = {
  selfExcluded: false,
  hasActiveLimits: false,
  ageVerified: false,
  isMinor: false,
};

export class InMemoryPlayerCompliance implements PlayerCompliancePort {
  private readonly data = new Map<string, PlayerComplianceStatus>();

  constructor(private readonly defaults: PlayerComplianceStatus = DEFAULT_COMPLIANCE_STATUS) {}

  set(operatorId: string, playerId: string, status: Partial<PlayerComplianceStatus>): void {
    const k = `${operatorId}\u0000${playerId}`;
    this.data.set(k, { ...this.defaults, ...(this.data.get(k) ?? {}), ...status });
  }

  async getStatus(operatorId: string, playerId: string): Promise<PlayerComplianceStatus> {
    return { ...(this.data.get(`${operatorId}\u0000${playerId}`) ?? this.defaults) };
  }
}
