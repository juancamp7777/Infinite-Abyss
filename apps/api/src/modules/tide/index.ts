import type { InboxService } from '../inbox/application/InboxService';
import type { Conversation } from '../inbox/domain/types';
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
      // Cuentas y caja se publican después (inbox.leads, pearl.cashier): se resuelven al ejecutar.
      const engine = new TideEngine(repo, inbox, {
        logger: deps.logger,
        actions: () => {
          const leads = deps.services['inbox.leads'] as { ensurePlayer(c: Conversation): Promise<{ playerId: string; created: boolean }> } | undefined;
          const cashier = deps.services['pearl.cashier'] as { withdraw(c: Conversation, a: string, acc: string, h: string): Promise<{ ok: boolean }> } | undefined;
          return {
            ...(leads ? { ensurePlayer: (c: Conversation) => leads.ensurePlayer(c) } : {}),
            ...(cashier ? { withdraw: (c: Conversation, a: string, acc: string, h: string) => cashier.withdraw(c, a, acc, h) } : {}),
          };
        },
      });
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
