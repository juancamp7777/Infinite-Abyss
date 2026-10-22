import express from 'express';
import type { ModuleDeps, NymfoModule } from '../shared/module';
import { createRuntime, type MarketingRuntime } from './application/MarketingRuntime';
import { createMarketingRouter } from './infrastructure/routes';

export { createRuntime } from './application/MarketingRuntime';
export type { MarketingRuntime } from './application/MarketingRuntime';
export { createMarketingRouter } from './infrastructure/routes';

/**
 * Módulo de marketing: campañas, journeys, canales, A/B, afiliados y cumplimiento.
 * Prefijo /marketing/v1. Servicios publicados: 'marketing' (MarketingRuntime) y 'marketing.messaging'.
 */
export const marketingModule: NymfoModule = {
  name: 'marketing',
  async register(app, io, deps: ModuleDeps) {
    const rt: MarketingRuntime = createRuntime(deps, { io });
    app.use('/marketing/v1', express.json({ limit: '256kb' }), createMarketingRouter(rt, deps));
    rt.subscribe(deps.bus);
    if (deps.env.MKT_SCHEDULER !== 'off') rt.start();
    deps.logger.info('[marketing] módulo registrado en /marketing/v1');
    return { marketing: rt, 'marketing.messaging': rt.messaging };
  },
};
