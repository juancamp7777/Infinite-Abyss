import type { Namespace, Server as SocketIOServer, Socket } from 'socket.io';
import { toErrorResponse } from '../../shared/http/errors';
import type { ModuleLogger } from '../../shared/module';
import { parseAmount } from '../../shared/money';
import type { AuthPort } from '../../shared/ports/AuthPort';
import { CrashLiveRoom } from '../application/CrashLiveRoom';
import type { StudioConfigService } from '../application/StudioConfigService';
import type { Actor, StudioPlayService } from '../application/StudioPlayService';
import type { EventBus } from '../../shared/events/EventBus';
import type { RoundRepository } from '../domain/rounds/types';

export interface CrashSocketDeps {
  auth: AuthPort;
  play: StudioPlayService;
  config: StudioConfigService;
  rounds: RoundRepository;
  bus: EventBus;
  logger: ModuleLogger;
  waitMs?: number;
  pauseMs?: number;
  tickMs?: number;
}

type Ack = (res: unknown) => void;

/**
 * Namespace /studio: crash en vivo compartido por operador (sala `crash:<operatorId>`).
 * Handshake: auth.token (JWT del jugador), auth.session (sesión del Hub) o auth.demoSession (+ auth.operatorId).
 * Cliente → servidor: crash:join, crash:bet {amount, currency, autoCashout?}, crash:cashout (todos con ack).
 * Servidor → cliente: crash:state, crash:round (hash publicado antes de la ronda), crash:start, crash:tick,
 * crash:bet, crash:cashout, crash:crashed (revela serverSeed).
 */
export function mountCrashSocket(io: SocketIOServer, d: CrashSocketDeps): { stop(): void; rooms: Map<string, CrashLiveRoom> } {
  const nsp: Namespace = io.of('/studio');
  const rooms = new Map<string, CrashLiveRoom>();
  const timers: NodeJS.Timeout[] = [];

  const roomFor = (operatorId: string): CrashLiveRoom => {
    let room = rooms.get(operatorId);
    if (room) return room;
    const channel = `crash:${operatorId}`;
    room = new CrashLiveRoom({
      operatorId,
      rounds: d.rounds,
      bus: d.bus,
      logger: d.logger,
      rtp: async () => (await d.config.resolve(operatorId, 'nymfo-crash')).rtp,
      emit: (event, payload) => nsp.to(channel).emit(event, JSON.parse(JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))),
      waitMs: d.waitMs,
      pauseMs: d.pauseMs,
    });
    rooms.set(operatorId, room);
    const r = room;
    const t = setInterval(() => {
      r.tick().catch((e) => d.logger.error('Studio crash en vivo: fallo en tick', { error: e instanceof Error ? e.message : String(e) }));
    }, d.tickMs ?? 100);
    t.unref?.();
    timers.push(t);
    return room;
  };

  const reply = (ack: Ack | undefined, fn: () => Promise<unknown>) => {
    fn()
      .then((data) => ack?.({ ok: true, data: JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) }))
      .catch((e) => ack?.({ ok: false, ...toErrorResponse(e).body }));
  };

  nsp.on('connection', (socket: Socket) => {
    let actorP: Promise<Actor> | null = null;
    const actor = () => {
      if (!actorP) {
        const a = (socket.handshake.auth ?? {}) as Record<string, unknown>;
        actorP = (async () => {
          const principal = typeof a.token === 'string' ? (await d.auth.verify(a.token)) ?? undefined : undefined;
          return d.play.resolveActor({
            principal,
            sessionToken: typeof a.session === 'string' ? a.session : undefined,
            mode: a.mode === 'demo' || (!principal && typeof a.demoSession === 'string') ? 'demo' : undefined,
            demoSession: typeof a.demoSession === 'string' ? a.demoSession : undefined,
            operatorId: typeof a.operatorId === 'string' ? a.operatorId : undefined,
          });
        })();
        actorP.catch(() => {
          actorP = null;
        });
      }
      return actorP;
    };

    socket.on('crash:join', (_p: unknown, ack?: Ack) => {
      reply(typeof _p === 'function' ? (_p as Ack) : ack, async () => {
        const a = await actor();
        await socket.join(`crash:${a.operatorId}`);
        const room = roomFor(a.operatorId);
        socket.emit('crash:state', JSON.parse(JSON.stringify(room.snapshot(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))));
        return room.snapshot();
      });
    });

    socket.on('crash:bet', (p: Record<string, unknown> | undefined, ack?: Ack) => {
      reply(ack, async () => {
        const a = await actor();
        const currency = await d.play.betCurrency(a, typeof p?.currency === 'string' ? p.currency : undefined);
        const amount = parseAmount(p?.amount);
        await d.play.assertBetLimits(a, 'nymfo-crash', amount, currency);
        return roomFor(a.operatorId).placeBet(a, amount, currency, (p?.autoCashout as number | null | undefined) ?? null);
      });
    });

    socket.on('crash:cashout', (_p: unknown, ack?: Ack) => {
      reply(typeof _p === 'function' ? (_p as Ack) : ack, async () => {
        const a = await actor();
        return roomFor(a.operatorId).cashout(a);
      });
    });
  });

  return {
    rooms,
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}
