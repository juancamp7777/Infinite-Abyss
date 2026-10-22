import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { ProcessBetUseCase } from '../../application/use-cases/ProcessBetUseCase';
import { PlaySlotsUseCase } from '../../application/use-cases/PlaySlotsUseCase';
import { StartBlackjackHandUseCase } from '../../application/use-cases/blackjack/StartBlackjackHandUseCase';
import { HitBlackjackUseCase } from '../../application/use-cases/blackjack/HitBlackjackUseCase';
import { StandBlackjackUseCase } from '../../application/use-cases/blackjack/StandBlackjackUseCase';
import { StartMinesUseCase } from '../../application/use-cases/mines/StartMinesUseCase';
import { RevealMinesUseCase } from '../../application/use-cases/mines/RevealMinesUseCase';
import { CashoutMinesUseCase } from '../../application/use-cases/mines/CashoutMinesUseCase';
import { PlaceCrashBetUseCase } from '../../application/use-cases/crash/PlaceCrashBetUseCase';
import { CashoutCrashUseCase } from '../../application/use-cases/crash/CashoutCrashUseCase';
import { PlayPlinkoUseCase } from '../../application/use-cases/plinko/PlayPlinkoUseCase';
import { Bet, BetType, BetValue } from '../../domain/entities/Bet';
import { AppError } from '../../domain/errors/AppError';
import { PlayerAuth } from '../../domain/contracts';
import { toJsonSafe } from '../http/serialize';
import { logger } from '../logging/logger';
import { amountSchema, betSchema, requestIdSchema } from './middlewares/betValidation';

const slotsSchema = z.object({ amount: amountSchema, requestId: requestIdSchema });
const blackjackStartSchema = z.object({ amount: amountSchema, requestId: requestIdSchema });
const blackjackActionSchema = z.object({ sessionId: z.string().uuid() });
const minesStartSchema = z.object({ amount: amountSchema, numMines: z.number().int().min(1).max(24), requestId: requestIdSchema });
const minesRevealSchema = z.object({ sessionId: z.string().uuid(), index: z.number().int().min(0).max(24) });
const sessionOnlySchema = z.object({ sessionId: z.string().uuid() });
const crashBetSchema = z.object({ amount: amountSchema, requestId: requestIdSchema });
const plinkoDropSchema = z.object({ 
  amount: amountSchema,
  rows: z.union([z.literal(8), z.literal(12), z.literal(16)]),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  requestId: requestIdSchema
});

type Callback = (response: any) => void;

export interface SocketServerDeps {
  /** Servidor HTTP de Node sobre el que se monta socket.io. */
  server: any;
  /** Middleware de io.use: debe fijar `socket.data.auth` (PlayerAuth) o rechazar la conexión. */
  authMiddleware: (socket: Socket, next: (err?: Error) => void) => void;
  /** Orígenes CORS permitidos (nunca '*'). */
  corsOrigins: string[];
  processBetUseCase: ProcessBetUseCase;
  playSlotsUseCase: PlaySlotsUseCase;
  startBlackjackHandUseCase: StartBlackjackHandUseCase;
  hitBlackjackUseCase: HitBlackjackUseCase;
  standBlackjackUseCase: StandBlackjackUseCase;
  startMinesUseCase: StartMinesUseCase;
  revealMinesUseCase: RevealMinesUseCase;
  cashoutMinesUseCase: CashoutMinesUseCase;
  placeCrashBetUseCase: PlaceCrashBetUseCase;
  cashoutCrashUseCase: CashoutCrashUseCase;
  playPlinkoUseCase: PlayPlinkoUseCase;
}

export class SocketServer {
  private io: Server;

  constructor(private readonly deps: SocketServerDeps) {
    this.io = new Server(deps.server, {
      cors: { origin: deps.corsOrigins },
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        // Re-ejecutar la autenticación también al recuperar la sesión
        skipMiddlewares: false,
      }
    });
    this.io.use(deps.authMiddleware);

    this.initialize();
  }

  public getIO(): Server {
    return this.io;
  }

  /**
   * Registra un evento: valida con zod, toma el contexto de socket.data.auth (nunca del cliente),
   * ejecuta el caso de uso y serializa la respuesta (bigint → string).
   */
  private on<S extends z.ZodTypeAny>(
    socket: Socket,
    event: string,
    schema: S,
    invalidMessage: string,
    run: (auth: PlayerAuth, data: z.infer<S>) => Promise<unknown>
  ) {
    socket.on(event, async (payload: any, callback: Callback) => {
      const traceId = uuidv4();
      if (typeof callback !== 'function') return;

      const auth = socket.data.auth as PlayerAuth | undefined;
      if (!auth) {
        return callback({ success: false, error: { message: 'Authentication required', code: 401, errorCode: 'UNAUTHORIZED' } });
      }

      const validation = schema.safeParse(payload);
      if (!validation.success) {
        return callback({ success: false, error: { message: invalidMessage, code: 400, errorCode: 'VALIDATION_ERROR' } });
      }

      try {
        const data = await run(auth, validation.data);
        callback({ success: true, data: toJsonSafe(data) });
      } catch (error: any) {
        this.handleError(error, callback, traceId);
      }
    });
  }

  private initialize() {
    const d = this.deps;

    this.io.on('connection', (socket: Socket) => {
      const auth = socket.data.auth as PlayerAuth | undefined;
      if (!auth) {
        socket.disconnect(true);
        return;
      }
      logger.info(`User connected: ${socket.id}`, { traceId: uuidv4(), event: 'CONNECT', userId: auth.userId, operatorId: auth.operatorId });

      // ROULETTE
      this.on(socket, 'placeBet', betSchema, 'Invalid bet', async (a, p) => {
        const bet = new Bet(p.type as BetType, p.value as BetValue, p.amount);
        const response = await d.processBetUseCase.execute(a, bet, p.requestId);
        return {
          number: response.result.number,
          color: response.result.color,
          payout: response.payout,
          newBalance: response.newBalance
        };
      });

      // SLOTS
      this.on(socket, 'playSlots', slotsSchema, 'Invalid amount', (a, p) =>
        d.playSlotsUseCase.execute(a, p.amount, p.requestId));

      // BLACKJACK
      this.on(socket, 'blackjack:start', blackjackStartSchema, 'Invalid amount', (a, p) =>
        d.startBlackjackHandUseCase.execute(a, p.amount, p.requestId));
      this.on(socket, 'blackjack:hit', blackjackActionSchema, 'Invalid session ID', (a, p) =>
        d.hitBlackjackUseCase.execute(a, p.sessionId));
      this.on(socket, 'blackjack:stand', blackjackActionSchema, 'Invalid session ID', (a, p) =>
        d.standBlackjackUseCase.execute(a, p.sessionId));

      // MINES
      this.on(socket, 'mines:start', minesStartSchema, 'Invalid payload', (a, p) =>
        d.startMinesUseCase.execute(a, p.amount, p.numMines, p.requestId));
      this.on(socket, 'mines:reveal', minesRevealSchema, 'Invalid payload', (a, p) =>
        d.revealMinesUseCase.execute(a, p.sessionId, p.index));
      this.on(socket, 'mines:cashout', sessionOnlySchema, 'Invalid session ID', (a, p) =>
        d.cashoutMinesUseCase.execute(a, p.sessionId));

      // CRASH
      this.on(socket, 'crash:placeBet', crashBetSchema, 'Invalid amount', (a, p) =>
        d.placeCrashBetUseCase.execute(a, p.amount, p.requestId));
      this.on(socket, 'crash:cashout', sessionOnlySchema, 'Invalid session ID', (a, p) =>
        d.cashoutCrashUseCase.execute(a, p.sessionId));

      // PLINKO
      this.on(socket, 'plinko:drop', plinkoDropSchema, 'Invalid input', (a, p) =>
        d.playPlinkoUseCase.execute(a, p.amount, p.rows, p.risk, p.requestId));

      socket.on('disconnect', () => {
        logger.info(`User disconnected: ${socket.id}`, { traceId: uuidv4(), event: 'DISCONNECT' });
      });
    });
  }

  private handleError(error: any, callback: Callback, traceId: string) {
    if (error instanceof AppError) {
      logger.warn(`Domain error`, { traceId, event: 'DOMAIN_ERROR', message: error.message, statusCode: error.statusCode });
      callback({ success: false, error: { message: error.message, code: error.statusCode, errorCode: error.code } });
    } else {
      logger.error(`Internal error`, { traceId, event: 'INTERNAL_ERROR', error });
      callback({ success: false, error: { message: 'Internal Server Error', code: 500, errorCode: 'INTERNAL_ERROR' } });
    }
  }
}
