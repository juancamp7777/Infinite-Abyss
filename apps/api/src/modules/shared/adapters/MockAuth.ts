import { AuthPort, Principal, ROLES, Role } from '../ports/AuthPort';

/**
 * Auth de desarrollo. Acepta tokens `dev:<role>:<operatorId>:<id>` solo si NODE_ENV !== 'production'.
 * - PLAYER: id = playerId (y userId).
 * - PLATFORM_ADMIN: operatorId puede ir vacío o '*' (ve todo).
 * Ejemplos: `dev:PLAYER:op-1:p-1`, `dev:OPERATOR_ADMIN:op-1:u-9`, `dev:PLATFORM_ADMIN:*:root`.
 */
export class MockAuth implements AuthPort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async verify(token: string): Promise<Principal | null> {
    if (this.env.NODE_ENV === 'production') return null;
    if (typeof token !== 'string') return null;
    const parts = token.split(':');
    if (parts.length !== 4 || parts[0] !== 'dev') return null;
    const [, role, operatorId, id] = parts;
    if (!ROLES.includes(role as Role) || !id) return null;
    const r = role as Role;
    if (r === 'PLATFORM_ADMIN') {
      return { userId: id, role: r, ...(operatorId && operatorId !== '*' ? { operatorId } : {}) };
    }
    if (!operatorId || operatorId === '*') return null;
    if (r === 'PLAYER') return { userId: id, role: r, operatorId, playerId: id };
    return { userId: id, role: r, operatorId };
  }
}

/** Construye un token de desarrollo (pruebas/backoffice en dev). */
export const devToken = (role: Role, operatorId: string, id: string): string => `dev:${role}:${operatorId}:${id}`;
