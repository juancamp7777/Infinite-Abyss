import type { InboxService } from '../inbox/application/InboxService';
import type { NymfoModule } from '../shared/module';
import { FlowService } from './application/FlowService';
import { TideEngine } from './application/TideEngine';
import type { TideRepository } from './domain/types';
import { buildTideRouter } from './http/routes';
import { InMemoryTideRepository } from './infrastructure/InMemoryTideRepository';
import { PrismaTideRepository, type TidePrismaLike } from './infrastructure/PrismaTideRepository';

export const TIDE_PREFIX = '/tide/v1';

export interface TideModuleOptions {
  repo?: TideRepository;
  /** Intervalo del barrido de esperas vencidas (ms); 0 = apagado. Por defecto TIDE_TICK_MS o 15000. */
  tickMs?: number;
}

/**
 * Tide: constructor de flujos y bots para el inbox Sonar (webchat, WhatsApp, Telegram).
 * Requiere el módulo inbox montado antes ('inbox.service'). HTTP en /tide/v1. Servicios: 'tide.engine', 'tide.flows'.
 */
export function createTideModule(opts: TideModuleOptions = {}): NymfoModule {
  return {
    name: 'tide',
    async register(app, _io, deps) {
      const inbox = deps.services['inbox.service'] as InboxService | undefined;
      if (!inbox) throw new Error('tide necesita el módulo inbox montado antes');
      const repo = opts.repo ?? (deps.prisma ? new PrismaTideRepository(deps.prisma as TidePrismaLike) : new InMemoryTideRepository());
      const engine = new TideEngine(repo, inbox, { logger: deps.logger });
      inbox.onEvent((e) => engine.onInboxEvent(e));
      const flows = new FlowService(repo);
      app.use(TIDE_PREFIX, buildTideRouter({ auth: deps.auth, flows, logger: deps.logger }));

      const tickMs = opts.tickMs ?? Number(deps.env.TIDE_TICK_MS ?? 15_000);
      if (Number.isFinite(tickMs) && tickMs > 0) {
        const t = setInterval(() => void engine.tick().catch((e) => deps.logger.error('[tide] barrido de esperas', { error: (e as Error).message })), tickMs);
        t.unref?.();
      }
      return { 'tide.engine': engine, 'tide.flows': flows };
    },
  };
}

export const tideModule = createTideModule();
