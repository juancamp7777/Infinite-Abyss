import type { PrismaClient } from '@prisma/client';
import type { BackofficeRoleName } from '../../../domain/contracts';
import type { JwtService } from '../../auth/JwtService';
import type { AuthPort, Principal, Role } from '../../../modules/shared/ports/AuthPort';

/**
 * Mapeo de roles de backoffice de la Fase 1 a los roles de los módulos Infinite Abyss.
 * SUPPORT y FINANCE operan como agentes (lectura de jugadores, tickets, reportes) sin permisos de administración.
 */
export const BACKOFFICE_ROLE_MAP: Record<BackofficeRoleName, Role> = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  OPERATOR_ADMIN: 'OPERATOR_ADMIN',
  OPERATOR_SUPPORT: 'OPERATOR_AGENT',
  OPERATOR_FINANCE: 'OPERATOR_AGENT',
};

/**
 * AuthPort real de los módulos sobre los JWT de la Fase 1 (HS256, JwtService).
 *
 * - Jugador (typ=player): el usuario debe existir, estar ACTIVE y pertenecer al operador del token.
 * - Backoffice (typ=backoffice): rol y operador se leen de la BD (no del token) y la cuenta debe estar ACTIVE.
 *   PLATFORM_ADMIN no tiene operador (ve todos); el resto queda fijado a su operador.
 * - Tokens de desarrollo `dev:` NUNCA se aceptan aquí (solo MockAuth en dev-server).
 *
 * Devuelve null ante cualquier fallo: las rutas de los módulos responden 401; el 403 por rol lo resuelve requireRole.
 */
export class Phase1ModuleAuth implements AuthPort {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaClient,
  ) {}

  async verify(token: string): Promise<Principal | null> {
    if (!token || token.startsWith('dev:')) return null;
    let claims;
    try {
      claims = this.jwt.verifyAccess(token);
    } catch {
      return null;
    }

    if (claims.typ === 'player') {
      if (!claims.op) return null;
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, operatorId: true, status: true, currency: true },
      });
      if (!user || user.status !== 'ACTIVE' || user.operatorId !== claims.op) return null;
      return { userId: user.id, role: 'PLAYER', operatorId: user.operatorId, playerId: user.id, currency: user.currency };
    }

    const bo = await this.prisma.backofficeUser.findUnique({
      where: { id: claims.sub },
      select: { id: true, role: true, operatorId: true, status: true },
    });
    if (!bo || bo.status !== 'ACTIVE') return null;
    const role = BACKOFFICE_ROLE_MAP[bo.role as BackofficeRoleName];
    if (!role) return null;
    if (role === 'PLATFORM_ADMIN') return { userId: bo.id, role };
    // Un operador sin tenant asignado o con un token emitido para otro operador no entra.
    if (!bo.operatorId || (claims.op && claims.op !== bo.operatorId)) return null;
    return { userId: bo.id, role, operatorId: bo.operatorId };
  }
}
