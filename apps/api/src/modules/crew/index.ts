import type { PrismaClient } from '@prisma/client';
import type { NymfoModule } from '../shared/module';
import { AscendService } from './application/AscendService';
import { CrewService } from './application/CrewService';
import type { InboxService } from '../inbox/application/InboxService';
import type { PearlService } from '../pearl/application/PearlService';
import { buildCrewRouter } from './http/routes';

export const CREW_PREFIX = '/crew/v1';

/**
 * Crew: el equipo del operador (cajeros, agentes, supervisores): turnos planificados, fichaje con pausas y cierre
 * de seguridad, tareas, checklist por turno, avisos con confirmación, caja por turno y nómina con mes congelado.
 * Requiere Postgres (sin Prisma el módulo no se monta). HTTP en /crew/v1. Servicio: 'crew.service'.
 */
export function createCrewModule(opts: { tickMs?: number } = {}): NymfoModule {
  return {
    name: 'crew',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[crew] sin base de datos: el módulo Crew no se monta');
        return {};
      }
      const db = deps.prisma as PrismaClient;
      const ascend = new AscendService(db);
      const crew = new CrewService(db, {
        onActivity: (a) => (a.memberId ? ascend.record(a.operatorId, a.memberId, a.type, a.refId) : ascend.recordForUser(a.operatorId, a.userId!, a.type, a.refId)),
      });
      // KPIs reales: tiempo de primera respuesta (Sonar) y cargas aprobadas por cajeros (Pearl).
      (deps.services['inbox.service'] as InboxService | undefined)?.onEvent((e) => ascend.onInboxEvent(e).catch(() => undefined), 100);
      (deps.services['pearl.service'] as PearlService | undefined)?.onReviewed((r) => (r.reviewerId ? ascend.recordForUser(r.operatorId, r.reviewerId, 'deposit_approved', r.id) : Promise.resolve(false)));
      app.use(CREW_PREFIX, buildCrewRouter({ auth: deps.auth, crew, ascend, logger: deps.logger }));
      const tickMs = opts.tickMs ?? Number(deps.env.CREW_TICK_MS ?? 300_000);
      if (Number.isFinite(tickMs) && tickMs > 0) {
        const t = setInterval(() => void crew.autoCloseTick().catch((e) => deps.logger.error('[crew] cierre automático', { error: (e as Error).message })), tickMs);
        t.unref?.();
      }
      return { 'crew.service': crew, 'crew.ascend': ascend };
    },
  };
}

export const crewModule = createCrewModule();
