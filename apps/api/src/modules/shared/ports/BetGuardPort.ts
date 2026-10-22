/**
 * Guardia previa a cada apuesta (límites de juego responsable de la Fase 1, apuesta máxima con bono de promociones…).
 * Se pueden encadenar con CompositeBetGuard.
 */
export interface BetCheckRequest {
  operatorId: string;
  playerId: string;
  gameId: string;
  category: string;
  amount: bigint;
  currency: string;
}

export interface BetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface BetGuardPort {
  checkBet(req: BetCheckRequest): Promise<BetCheckResult>;
}

export class AllowAllBetGuard implements BetGuardPort {
  async checkBet(): Promise<BetCheckResult> {
    return { allowed: true };
  }
}

/** Ejecuta las guardias en orden y devuelve el primer rechazo. */
export class CompositeBetGuard implements BetGuardPort {
  constructor(private readonly guards: BetGuardPort[]) {}

  async checkBet(req: BetCheckRequest): Promise<BetCheckResult> {
    for (const g of this.guards) {
      const r = await g.checkBet(req);
      if (!r.allowed) return r;
    }
    return { allowed: true };
  }
}
