import type { Namespace, Server as SocketIOServer } from 'socket.io';
import { toJSONSafe } from '../../../shared/money';

/**
 * Emite por socket.io (namespace /promotions, room `op:<operatorId>`) los valores de jackpot en vivo con
 * throttle (como mucho 1 emisión por operador y ventana) y los ganadores al instante.
 * El cliente se une con `io('/promotions', { query: { operatorId } })` o emitiendo `join` { operatorId }.
 */
export class JackpotBroadcaster {
  private readonly nsp?: Namespace;
  private readonly last = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    io: SocketIOServer | undefined,
    private readonly snapshot: (operatorId: string) => Promise<unknown>,
    private readonly throttleMs = 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (!io) return;
    this.nsp = io.of('/promotions');
    this.nsp.on('connection', (socket) => {
      const join = async (operatorId: unknown) => {
        if (typeof operatorId !== 'string' || !operatorId || operatorId.length > 100) return;
        await socket.join(room(operatorId));
        socket.emit('jackpot:update', toJSONSafe(await this.snapshot(operatorId).catch(() => [])));
      };
      void join(socket.handshake.query?.operatorId);
      socket.on('join', (p: { operatorId?: unknown } | undefined) => void join(p?.operatorId));
      socket.on('leave', (p: { operatorId?: unknown } | undefined) => {
        if (typeof p?.operatorId === 'string') void socket.leave(room(p.operatorId));
      });
    });
  }

  /** Marca el operador como modificado; emite al vencer la ventana de throttle. */
  markDirty(operatorId: string): void {
    if (!this.nsp || this.timers.has(operatorId)) return;
    const wait = Math.max(0, (this.last.get(operatorId) ?? 0) + this.throttleMs - this.now());
    const t = setTimeout(() => void this.flush(operatorId), wait);
    t.unref?.();
    this.timers.set(operatorId, t);
  }

  emitWinner(operatorId: string, payload: unknown): void {
    this.nsp?.to(room(operatorId)).emit('jackpot:won', toJSONSafe(payload));
  }

  emitDrop(operatorId: string, payload: unknown): void {
    this.nsp?.to(room(operatorId)).emit('drop:won', toJSONSafe(payload));
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private async flush(operatorId: string): Promise<void> {
    this.timers.delete(operatorId);
    this.last.set(operatorId, this.now());
    try {
      this.nsp?.to(room(operatorId)).emit('jackpot:update', toJSONSafe(await this.snapshot(operatorId)));
    } catch {
      /* la próxima contribución vuelve a intentarlo */
    }
  }
}

const room = (operatorId: string) => `op:${operatorId}`;
