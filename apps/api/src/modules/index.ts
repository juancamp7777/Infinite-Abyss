import type { Application } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { ModuleDeps, NymfoModule } from './shared/module';
import type { BetCheckRequest, BetGuardPort } from './shared/ports/BetGuardPort';
import type { GameCatalogPort } from './shared/ports/GameCatalogPort';
import type { SegmentPort } from './shared/ports/SegmentPort';
import { hubModule } from './hub';
import { studioModule } from './studio';
import { promotionsModule } from './promotions';
import { crmModule } from './crm';
import { marketingModule } from './marketing';
import { gamificationModule } from './gamification';
import { backofficeModule } from './backoffice-api';
import { feedModule } from './feed';
import { inboxModule } from './inbox';
import { tideModule } from './tide';
import { pearlModule } from './pearl';

export { captureRawBody } from './hub';
export type { ModuleDeps, NymfoModule } from './shared/module';

/** Orden de montaje: los proveedores de servicios van antes que sus consumidores (los consumidores igualmente resuelven en cada llamada). */
export const ALL_MODULES: NymfoModule[] = [
  hubModule,
  studioModule,
  promotionsModule,
  crmModule,
  marketingModule,
  gamificationModule,
  backofficeModule,
  feedModule,
  inboxModule,
  tideModule,
  pearlModule,
];

export type RegisterModulesDeps = Omit<ModuleDeps, 'services' | 'catalog' | 'betGuard' | 'segments'> & {
  /** Puertos externos opcionales (p. ej. límites de juego responsable de la Fase 1). Se combinan con los de los módulos. */
  catalog?: GameCatalogPort;
  betGuard?: BetGuardPort;
  segments?: SegmentPort;
  /** Servicios previos, p. ej. 'wallet.bonusFunds' de la Fase 1. */
  services?: Record<string, unknown>;
};

export interface RegisterModulesOptions {
  /** Subconjunto de módulos (por nombre). Por defecto todos. */
  only?: string[];
}

function first<T>(services: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) if (services[k] !== undefined) return services[k] as T;
  return undefined;
}

/**
 * Monta todos los módulos de Infinite Abyss (Hub, Studio, promociones, CRM, marketing, gamificación, backoffice)
 * sobre la app Express y el servidor socket.io de la Fase 1.
 *
 * Los servicios publicados por cada módulo quedan con su clave original y también como `<módulo>.<clave>`
 * (salvo que ya traigan el prefijo), para que los consumidores los encuentren de ambas formas.
 * catalog, betGuard y segments se resuelven perezosamente contra los servicios publicados.
 */
export async function registerModules(
  app: Application,
  io: SocketIOServer | undefined,
  base: RegisterModulesDeps,
  opts: RegisterModulesOptions = {},
): Promise<Record<string, unknown>> {
  const services: Record<string, unknown> = { ...(base.services ?? {}) };

  const catalog: GameCatalogPort = {
    async getGame(gameId) {
      const hub = first<GameCatalogPort>(services, 'hub.catalog');
      const fromHub = hub ? await hub.getGame(gameId) : null;
      return fromHub ?? (base.catalog ? base.catalog.getGame(gameId) : null);
    },
  };
  const betGuard: BetGuardPort = {
    async checkBet(req: BetCheckRequest) {
      if (base.betGuard) {
        const r = await base.betGuard.checkBet(req);
        if (!r.allowed) return r;
      }
      const promo = first<BetGuardPort>(services, 'promotions.betGuard');
      return promo ? promo.checkBet(req) : { allowed: true };
    },
  };
  const segmentsPort = (): SegmentPort | undefined => first<SegmentPort>(services, 'crm.crmSegments', 'crmSegments') ?? base.segments;
  const segments: SegmentPort = {
    async listPlayers(op, seg) {
      const s = segmentsPort();
      return s ? s.listPlayers(op, seg) : [];
    },
    async isMember(op, seg, player) {
      const s = segmentsPort();
      return s ? s.isMember(op, seg, player) : false;
    },
  };

  const deps: ModuleDeps = { ...base, catalog, betGuard, segments, services };
  const modules = opts.only ? ALL_MODULES.filter((m) => opts.only!.includes(m.name)) : ALL_MODULES;

  for (const mod of modules) {
    const published = await mod.register(app, io, deps);
    for (const [key, value] of Object.entries(published ?? {})) {
      const prefixed = key.startsWith(`${mod.name}.`) ? key : `${mod.name}.${key}`;
      services[prefixed] = value;
      if (services[key] === undefined) services[key] = value;
    }
    base.logger.info(`Módulo montado: ${mod.name}`, { services: Object.keys(published ?? {}) });
  }
  return services;
}
