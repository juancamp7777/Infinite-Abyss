import type { Application } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { ModuleDeps, NymfoModule } from '../shared/module';
import { DashboardService, findService, PromotionsCostSource } from './application/DashboardService';
import { KpiProjection } from './application/KpiProjection';
import { ReportService } from './application/ReportService';
import type { CostSource, KpiRepository, SkinPort } from './domain/types';
import { createBackofficeRouter } from './infrastructure/http';
import { InMemoryKpiRepository, InMemorySkinPort } from './infrastructure/InMemoryRepositories';
import { PrismaKpiRepository, PrismaSkinPort, type BoPrismaLike } from './infrastructure/PrismaRepositories';

export const BACKOFFICE_PREFIX = '/backoffice/v1';

export interface BackofficeOptions {
  repo?: KpiRepository;
  skins?: SkinPort;
  costs?: CostSource;
  clock?: () => Date;
}

export interface BackofficeRuntime {
  repo: KpiRepository;
  skins: SkinPort;
  projection: KpiProjection;
  dashboard: DashboardService;
  reports: ReportService;
  unsubscribe: () => void;
}

const isSkinPort = (v: unknown): v is SkinPort => !!v && typeof (v as SkinPort).get === 'function' && typeof (v as SkinPort).update === 'function';

export function createBackoffice(deps: ModuleDeps, opts: BackofficeOptions = {}): BackofficeRuntime & { router: ReturnType<typeof createBackofficeRouter> } {
  const prisma = deps.prisma as BoPrismaLike | undefined;
  const repo = opts.repo ?? (prisma?.boDayKpi ? new PrismaKpiRepository(prisma) : new InMemoryKpiRepository());
  const existingSkins = findService(deps.services, 'skins');
  const skins = opts.skins ?? (isSkinPort(existingSkins) ? existingSkins : prisma?.boSkin ? new PrismaSkinPort(prisma) : new InMemorySkinPort());
  const clock = opts.clock ?? (() => new Date());
  // Los costos se resuelven en cada consulta: promotions puede montarse después.
  const costs = opts.costs ?? new PromotionsCostSource(deps.services);
  const dashboard = new DashboardService(repo, costs, clock);
  const reports = new ReportService(dashboard, deps.services);
  const projection = new KpiProjection(repo);
  const unsubscribe = projection.subscribe(deps.bus);
  const router = createBackofficeRouter({ deps, dashboard, reports, skins, clock });
  return { repo, skins, projection, dashboard, reports, unsubscribe, router };
}

export const backofficeModule: NymfoModule = {
  name: 'backoffice',
  async register(app: Application, _io: SocketIOServer | undefined, deps: ModuleDeps) {
    const rt = createBackoffice(deps);
    app.use(BACKOFFICE_PREFIX, rt.router);
    return { skins: rt.skins, kpiRepo: rt.repo, dashboard: rt.dashboard, reports: rt.reports };
  },
};

export * from './domain/types';
export { csvCell, toCsv, neutralizeFormula } from './application/csv';
export { sanitizeSvg, skinInputSchema } from './application/skins';
