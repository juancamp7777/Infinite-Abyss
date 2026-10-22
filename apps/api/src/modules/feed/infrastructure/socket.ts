import type { Namespace, Server as SocketIOServer, Socket } from 'socket.io';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { toJSONSafe } from '../../shared/money';
import type { FeedNotifier, FeedService } from '../application/FeedService';
import type { FeedBet, FeedKind } from '../domain/BetFeed';

const opRoom = (operatorId: string) => `op:${operatorId}`;
const playerRoom = (operatorId: string, playerId: string) => `player:${operatorId}:${playerId}`;
const validOperator = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100;

export interface FeedSocketOptions {
  /** Ventana de agrupado de `feed:bets` en ms (0 = emitir cada apuesta al momento). */
  flushMs: number;
  /** Máximo de apuestas por lote y operador; en picos se envían las más recientes. */
  maxBatch: number;
}

/**
 * Namespace /feed. Público: `io('/feed', { query: { operatorId } })`. Con `auth: { token }` de jugador,
 * el operador sale del token y además recibe `feed:mine` con sus propias apuestas.
 * Eventos: `feed:snapshot` { all, high, lucky, mine? } al conectar y `feed:bets` [{ ...apuesta, kinds }] en vivo.
 */
export function attachFeedSocket(io: SocketIOServer, auth: AuthPort, svc: FeedService, opts: FeedSocketOptions): FeedNotifier & { close(): void } {
  const nsp: Namespace = io.of('/feed');
  const pending = new Map<string, Array<FeedBet & { kinds: FeedKind[] }>>();
  const timers = new Map<string, NodeJS.Timeout>();

  nsp.on('connection', async (socket: Socket) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const p = typeof token === 'string' && token ? await auth.verify(token) : null;
      const player = p && p.role === 'PLAYER' && p.playerId && p.operatorId ? { op: p.operatorId, id: p.playerId } : null;
      const op = player?.op ?? socket.handshake.query?.operatorId;
      if (!validOperator(op)) {
        socket.emit('feed:error', { code: 'OPERATOR_REQUIRED' });
        socket.disconnect(true);
        return;
      }
      await socket.join(opRoom(op));
      if (player) await socket.join(playerRoom(player.op, player.id));
      socket.emit('feed:snapshot', toJSONSafe({
        all: svc.feed.list(op, 'all'),
        high: svc.feed.list(op, 'high'),
        lucky: svc.feed.list(op, 'lucky'),
        ...(player ? { mine: svc.feed.listMine(player.op, player.id) } : {}),
      }));
    } catch {
      socket.disconnect(true);
    }
  });

  const flush = (operatorId: string) => {
    timers.delete(operatorId);
    const batch = pending.get(operatorId);
    pending.delete(operatorId);
    if (batch?.length) nsp.to(opRoom(operatorId)).emit('feed:bets', toJSONSafe(batch));
  };

  return {
    bet(operatorId, playerId, bet, kinds) {
      nsp.to(playerRoom(operatorId, playerId)).emit('feed:mine', toJSONSafe(bet));
      const batch = pending.get(operatorId) ?? [];
      batch.push({ ...bet, kinds });
      if (batch.length > opts.maxBatch) batch.splice(0, batch.length - opts.maxBatch);
      pending.set(operatorId, batch);
      if (opts.flushMs <= 0) return flush(operatorId);
      if (!timers.has(operatorId)) {
        const t = setTimeout(() => flush(operatorId), opts.flushMs);
        t.unref?.();
        timers.set(operatorId, t);
      }
    },
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      pending.clear();
    },
  };
}
