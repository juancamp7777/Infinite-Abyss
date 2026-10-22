export type Role = 'PLATFORM_ADMIN' | 'OPERATOR_ADMIN' | 'OPERATOR_AGENT' | 'PLAYER';

export const ROLES: readonly Role[] = ['PLATFORM_ADMIN', 'OPERATOR_ADMIN', 'OPERATOR_AGENT', 'PLAYER'];

export interface Principal {
  userId: string;
  role: Role;
  /** Obligatorio para todos los roles salvo PLATFORM_ADMIN. */
  operatorId?: string;
  /** Solo para PLAYER. */
  playerId?: string;
  /** Solo para PLAYER: moneda de la cuenta (User.currency). */
  currency?: string;
}

/** La Fase 1 lo implementa verificando su JWT; MockAuth sirve para desarrollo/pruebas. */
export interface AuthPort {
  verify(token: string): Promise<Principal | null>;
}
