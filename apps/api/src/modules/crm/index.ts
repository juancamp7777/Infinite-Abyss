import express from 'express';
import type { NymfoModule, ModuleDeps } from '../shared/module';
import { InMemoryCrmRepository, type CrmRepository } from './application/CrmRepository';
import { CrmProfileService, CrmSegmentService, CrmTicketService, CrmTimelineService, type Clock } from './application/services';
import { PrismaCrmRepository, type CrmPrismaLike } from './infrastructure/PrismaCrmRepository';
import { createCrmRouter } from './http/routes';

export * from './domain/types';
export * from './application/services';
export { InMemoryCrmRepository } from './application/CrmRepository';
export { ruleSchema, evaluateRule } from './domain/segments';

export interface CrmOptions {
  repo?: CrmRepository;
  clock?: Clock;
}

/** Construye servicios y router sin montar nada (lo usan register y las pruebas). */
export function createCrm(deps: ModuleDeps, opts: CrmOptions = {}) {
  const clock = opts.clock ?? (() => new Date());
  const repo = opts.repo ?? (deps.prisma ? new PrismaCrmRepository(deps.prisma as CrmPrismaLike) : new InMemoryCrmRepository());
  const timeline = new CrmTimelineService(repo, clock);
  const profiles: CrmProfileService = new CrmProfileService(repo, timeline, deps.compliance, clock, deps.logger);
  const segments = new CrmSegmentService(repo, () => profiles, clock);
  const tickets = new CrmTicketService(repo, timeline, clock);
  const router = createCrmRouter({ auth: deps.auth, profiles, segments, timeline, tickets, logger: deps.logger });
  return { repo, timeline, profiles, segments, tickets, router };
}

/**
 * Módulo CRM: prefijo /crm/v1. Servicios publicados:
 *  crmProfiles (getProfile), crmSegments (SegmentPort) y crmTimeline (add).
 */
export const crmModule: NymfoModule = {
  name: 'crm',
  async register(app, _io, deps) {
    const crm = createCrm(deps);
    crm.profiles.subscribe(deps.bus);
    app.use('/crm/v1', express.json({ limit: '100kb' }), crm.router);
    return { crmProfiles: crm.profiles, crmSegments: crm.segments, crmTimeline: crm.timeline };
  },
};
