import { randomBytes } from 'crypto';
import type { NymfoModule } from '../shared/module';
import { FeedService } from './application/FeedService';
import { DEFAULT_FEED_CONFIG, parseHighRollerMin } from './domain/BetFeed';
import { buildFeedRouter } from './http/routes';
import { attachFeedSocket } from './infrastructure/socket';

export const FEED_PREFIX = '/feed/v1';

const positiveInt = (raw: string | undefined, fallback: number, name: string): number => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} debe ser un número > 0`);
  return n;
};

export interface FeedModuleOptions {
  /** Ventana de agrupado del socket en ms (por defecto FEED_FLUSH_MS o 300). */
  flushMs?: number;
}

/**
 * Feed de apuestas en vivo del lobby: todas, grandes apostadores (FEED_HIGH_ROLLER_MIN) y grandes victorias
 * (FEED_LUCKY_MULTIPLIER). Se alimenta de `bet.settled` (Hub y Studios); el jugador sale con pseudónimo HMAC
 * (FEED_PSEUDONYM_SECRET). HTTP en /feed/v1 y socket.io en el namespace /feed.
 * Servicio publicado: 'feed.service'.
 */
export function createFeedModule(opts: FeedModuleOptions = {}): NymfoModule {
  return {
    name: 'feed',
    async register(app, io, deps) {
      const env = deps.env;
      let secret = env.FEED_PSEUDONYM_SECRET;
      if (!secret) {
        secret = randomBytes(32).toString('hex');
        deps.logger.warn('[feed] FEED_PSEUDONYM_SECRET no definido: se usa un secreto efímero (los alias cambian al reiniciar)');
      }
      const svc = new FeedService({
        bus: deps.bus,
        catalog: deps.catalog,
        logger: deps.logger,
        pseudonymSecret: secret,
        pseudonymPrefix: env.FEED_PSEUDONYM_PREFIX || undefined,
        config: {
          ...DEFAULT_FEED_CONFIG,
          highRollerMin: parseHighRollerMin(env.FEED_HIGH_ROLLER_MIN),
          luckyMultiplier: positiveInt(env.FEED_LUCKY_MULTIPLIER, DEFAULT_FEED_CONFIG.luckyMultiplier, 'FEED_LUCKY_MULTIPLIER'),
        },
      });
      if (io) {
        const flushMs = opts.flushMs ?? positiveInt(env.FEED_FLUSH_MS, 300, 'FEED_FLUSH_MS');
        svc.setNotifier(attachFeedSocket(io, deps.auth, svc, { flushMs, maxBatch: DEFAULT_FEED_CONFIG.size }));
      }
      app.use(FEED_PREFIX, buildFeedRouter({ auth: deps.auth, svc, logger: deps.logger }));
      svc.start();
      return { 'feed.service': svc };
    },
  };
}

export const feedModule = createFeedModule();

export { FeedService } from './application/FeedService';
