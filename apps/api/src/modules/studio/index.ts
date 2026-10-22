import type { NymfoModule } from '../shared/module';
import { StudioConfigService } from './application/StudioConfigService';
import { StudioFairnessService } from './application/StudioFairnessService';
import { HubSession, HubSessionsPort, StudioPlayService } from './application/StudioPlayService';
import { registerGame } from './domain/games/registry';
import { ORIGINAL_GAMES } from './domain/originals';
import type { GameMath } from './domain/GameMath';
import { starfall } from './domain/games/starfall/math';
import { verdantGrid } from './domain/games/verdant-grid/math';
import { emberLines } from './domain/games/ember-lines/math';
import type { OperatorConfigRepository, RoundRepository, SeedPairRepository } from './domain/rounds/types';
import { createStudioRouter } from './infrastructure/http';
import { InMemoryOperatorConfigRepository, InMemoryRoundRepository, InMemorySeedPairRepository } from './infrastructure/memory';
import { PrismaOperatorConfigRepository, PrismaRoundRepository, PrismaSeedPairRepository, StudioPrismaClient } from './infrastructure/prisma';
import { mountCrashSocket } from './infrastructure/socket';

export { StudioConfigService } from './application/StudioConfigService';
export { StudioFairnessService } from './application/StudioFairnessService';
export { StudioPlayService, STUDIO_PROVIDER } from './application/StudioPlayService';
export { CrashLiveRoom } from './application/CrashLiveRoom';

/** Registra los originals (dice, plinko, roulette, crash, mines) en GAMES. Idempotente. */
export function registerOriginals(): void {
  for (const g of ORIGINAL_GAMES) registerGame(g);
}

/** Registra las slots propias (Starfall, Verdant Grid, Ember Lines) en GAMES. Idempotente. */
export function registerSlots(): void {
  for (const g of [starfall, verdantGrid, emberLines]) registerGame(g as GameMath<any, any>);
}
registerOriginals();
registerSlots();

const STUDIO_PREFIX = '/studio/v1';

function bigintEnv(v: string | undefined, def: bigint): bigint {
  return v && /^\d{1,30}$/.test(v) ? BigInt(v) : def;
}

function intEnv(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : def;
}

/**
 * Abyss Studios: originals provably fair, API de juego, rondas, RTP por operador y crash en vivo (/studio).
 * Servicios publicados: studioPlay, studioConfig, studioFairness (+ crashLive si hay socket.io).
 */
export const studioModule: NymfoModule = {
  name: 'studio',
  async register(app, io, deps) {
    registerOriginals();
    registerSlots();
    const prisma = deps.prisma as StudioPrismaClient | undefined;
    const usePrisma = !!prisma?.studioRound;
    const rounds: RoundRepository = usePrisma ? new PrismaRoundRepository(prisma!) : new InMemoryRoundRepository();
    const seeds: SeedPairRepository = usePrisma ? new PrismaSeedPairRepository(prisma!) : new InMemorySeedPairRepository();
    const configs: OperatorConfigRepository = usePrisma ? new PrismaOperatorConfigRepository(prisma!) : new InMemoryOperatorConfigRepository();

    // El Hub puede montarse antes o después: se resuelve en cada llamada.
    const hubPort = (): Partial<HubSessionsPort> | undefined => {
      const s = deps.services;
      const sessions = (s['hub.sessions'] ?? (s.hub as { sessions?: unknown } | undefined)?.sessions ?? s.hub) as Partial<HubSessionsPort> | undefined;
      if (sessions?.resolveSession && sessions.walletForSession) return sessions;
      const resolveSession = s['hub.resolveSession'] as HubSessionsPort['resolveSession'] | undefined;
      const walletForSession = s['hub.walletForSession'] as HubSessionsPort['walletForSession'] | undefined;
      return resolveSession && walletForSession ? { resolveSession, walletForSession } : undefined;
    };
    const hub: HubSessionsPort = {
      async resolveSession(token: string) {
        const h = hubPort();
        return h?.resolveSession ? h.resolveSession(token) : null;
      },
      walletForSession(session: HubSession | string) {
        const h = hubPort();
        return h?.walletForSession ? h.walletForSession(session) : deps.wallet;
      },
    };

    const config = new StudioConfigService(configs);
    const fairness = new StudioFairnessService(seeds, rounds);
    const play = new StudioPlayService({
      wallet: deps.wallet,
      bus: deps.bus,
      betGuard: deps.betGuard,
      rounds,
      fairness,
      config,
      logger: deps.logger,
      hub,
      operators: deps.operators,
      demoBalance: deps.env.STUDIO_DEMO_BALANCE ? bigintEnv(deps.env.STUDIO_DEMO_BALANCE, 1_000_000n) : undefined,
      // Solo respaldo del dev-server: en la plataforma la divisa sale del jugador o del operador.
      demoCurrency: deps.env.STUDIO_DEMO_CURRENCY || undefined,
      defaultCurrency: deps.env.STUDIO_DEFAULT_CURRENCY || undefined,
    });

    app.use(STUDIO_PREFIX, createStudioRouter({ auth: deps.auth, play, fairness, config, logger: deps.logger }));

    const services: Record<string, unknown> = { studioPlay: play, studioConfig: config, studioFairness: fairness };
    if (io && deps.env.STUDIO_CRASH_LIVE !== 'false') {
      services.crashLive = mountCrashSocket(io, {
        auth: deps.auth,
        play,
        config,
        rounds,
        bus: deps.bus,
        logger: deps.logger,
        waitMs: intEnv(deps.env.STUDIO_CRASH_WAIT_MS, 5000),
        pauseMs: intEnv(deps.env.STUDIO_CRASH_PAUSE_MS, 3000),
      });
    }
    deps.logger.info(`Studio montado en ${STUDIO_PREFIX}`, { persistence: usePrisma ? 'prisma' : 'memory' });
    return services;
  },
};

export default studioModule;
