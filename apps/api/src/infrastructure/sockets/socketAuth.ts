import type { PrismaClient } from '@prisma/client';
import type { Socket } from 'socket.io';
import { AppError } from '../../domain/errors/AppError';
import type { PlayerAuth } from '../../domain/contracts';
import { extractBearer, type JwtService } from '../auth/JwtService';

/**
 * Middleware de socket.io (`io.use(createSocketAuthMiddleware({ jwt, prisma }))`).
 *
 * El userId sale SIEMPRE del token (`socket.handshake.auth.token`), nunca del cliente.
 * El resultado queda en `socket.data.auth: PlayerAuth`.
 *
 * IMPORTANTE: el SocketServer debe crear `new Server(http, { connectionStateRecovery:
 * { skipMiddlewares: false, ... } })`. Con `skipMiddlewares: true` (valor por defecto al
 * activar la recuperación), una conexión recuperada se salta este middleware y se
 * saltaría la autenticación.
 */
export function createSocketAuthMiddleware(deps: { jwt: JwtService; prisma: PrismaClient }) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    try {
      const raw = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof raw !== 'string' || !raw) throw AppError.unauthorized();
      const token = extractBearer(`Bearer ${raw.replace(/^Bearer\s+/i, '')}`);
      if (!token) throw AppError.unauthorized();
      const claims = deps.jwt.verifyAccess(token);
      if (claims.typ !== 'player') throw AppError.unauthorized();
      const user = await deps.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, operatorId: true, status: true, currency: true, isDemo: true, operator: { select: { status: true } } },
      });
      if (!user || user.status !== 'ACTIVE' || user.operatorId !== claims.op || user.operator.status !== 'ACTIVE') {
        throw AppError.unauthorized();
      }
      const auth: PlayerAuth = {
        kind: 'player',
        userId: user.id,
        operatorId: user.operatorId,
        currency: user.currency,
        isDemo: user.isDemo,
      };
      socket.data.auth = auth;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  };
}
