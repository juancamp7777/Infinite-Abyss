import type { Namespace, Server as SocketIOServer, Socket } from 'socket.io';
import type { AuthPort, Principal } from '../../shared/ports/AuthPort';
import { toJSONSafe } from '../../shared/money';
import { Notifier, playerRoom, tournamentRoom } from '../application/context';
import type { GamificationService } from '../application/service';

/** Namespace /gamification. Auth: handshake.auth.token (jugador). Rooms: player:<op>:<id> y tournament:<id>. */
export function attachSocket(io: SocketIOServer, auth: AuthPort, svc: GamificationService): Notifier {
  const nsp: Namespace = io.of('/gamification');

  nsp.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const p = typeof token === 'string' ? await auth.verify(token) : null;
      if (!p || p.role !== 'PLAYER' || !p.playerId || !p.operatorId) return next(new Error('UNAUTHORIZED'));
      (socket.data as { principal?: Principal }).principal = p;
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    const p = (socket.data as { principal: Principal }).principal;
    const op = p.operatorId as string;
    const pid = p.playerId as string;
    void socket.join(playerRoom(op, pid));

    socket.on('tournament:subscribe', async (payload: { id?: string } | undefined, ack?: (r: unknown) => void) => {
      try {
        const id = String(payload?.id ?? '');
        await svc.tournaments.get(op, id); // verifica que pertenezca al operador del jugador
        await socket.join(tournamentRoom(id));
        const lb = await svc.tournaments.leaderboard(op, id, pid);
        ack?.(toJSONSafe({ ok: true, leaderboard: lb }));
      } catch {
        ack?.({ ok: false, error: 'NOT_FOUND' });
      }
    });
    socket.on('tournament:unsubscribe', (payload: { id?: string } | undefined) => {
      if (payload?.id) void socket.leave(tournamentRoom(String(payload.id)));
    });
  });

  return {
    toPlayer: (op, player, event, payload) => void nsp.to(playerRoom(op, player)).emit(event, toJSONSafe(payload)),
    toTournament: (id, event, payload) => void nsp.to(tournamentRoom(id)).emit(event, toJSONSafe(payload)),
  };
}
