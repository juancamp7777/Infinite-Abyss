import type { NymfoModule } from '../shared/module';
import { GamificationService } from './application/service';
import type { PromotionsLike } from './application/context';
import { InMemoryDocStore, PrismaDocStore } from './infrastructure/DocStore';
import { attachSocket } from './infrastructure/socket';
import { buildRouter } from './http/routes';

export const GAMIFICATION_PREFIX = '/gamification/v1';

/**
 * Gamificación: VIP/rakeback, misiones, logros, racha, rueda y torneos.
 * Servicios publicados: 'gamification.service' (GamificationService).
 * Usa deps.services.promotions (opcional, con grantBonus) para bonos; sin él acredita BONUS_GRANT.
 */
export const gamificationModule: NymfoModule = {
  name: 'gamification',
  async register(app, io, deps) {
    const store = deps.prisma ? new PrismaDocStore(deps.prisma) : new InMemoryDocStore();
    const svc = new GamificationService({
      store,
      wallet: deps.wallet,
      bus: deps.bus,
      logger: deps.logger,
      compliance: deps.compliance,
      promotions: deps.services.promotions as PromotionsLike | undefined,
      operators: deps.operators,
      fallbackCurrency: deps.env.GAMIFICATION_DEFAULT_CURRENCY || undefined,
    });
    if (io) svc.setNotifier(attachSocket(io, deps.auth, svc));
    app.use(GAMIFICATION_PREFIX, buildRouter({ auth: deps.auth, svc, logger: deps.logger }));
    svc.start();
    return { 'gamification.service': svc };
  },
};

export { GamificationService } from './application/service';
