import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type { NymfoModule } from '../shared/module';
import type { IntegrationsPort } from '../shared/ports/IntegrationsPort';
import { LeviathanService, type RealFeed } from './application/LeviathanService';
import { buildLeviathanRouter } from './http/routes';
import { ApiFootball, DEFAULT_LEAGUES } from './infrastructure/apiFootball';

export const LEVIATHAN_PREFIX = '/leviathan/v1';

/**
 * Leviathan: concursos de fichas sobre deportes (heredado de BetBattle). Pozo cerrado con comisión del 5 %, reparto
 * por resto mayor y devolución completa si se cancela. Con API-Football conectada en Integraciones usa partidos reales;
 * si no, partidos simulados. Requiere Postgres. HTTP en /leviathan/v1. Servicio: 'leviathan.service'.
 */
export function createLeviathanModule(opts: { tickMs?: number; now?: () => Date; rand?: () => number; realFeed?: () => Promise<RealFeed> } = {}): NymfoModule {
  return {
    name: 'leviathan',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[leviathan] sin base de datos: el módulo no se monta');
        return {};
      }
      // La llave se lee en cada barrido: conectar o cambiar API-Football no requiere reiniciar.
      let cached: { key: string; api: ApiFootball } | null = null;
      const realFeed = opts.realFeed ?? (async (): Promise<RealFeed> => {
        const svc = deps.services['integrations.service'] as IntegrationsPort | undefined;
        const key = await svc?.value(null, 'api-football', 'apiKey');
        if (!svc || !key) return null;
        const raw = await svc.value(null, 'api-football', 'leagues');
        const leagues = (raw ?? '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!cached || cached.key !== key) cached = { key, api: new ApiFootball(key) };
        return { api: cached.api, leagues: leagues.length ? leagues : DEFAULT_LEAGUES };
      });
      const lev = new LeviathanService(deps.prisma as PrismaClient, deps.wallet, { logger: deps.logger, now: opts.now, rand: opts.rand, realFeed });
      app.use(LEVIATHAN_PREFIX, express.json({ limit: '50kb' }), buildLeviathanRouter({ auth: deps.auth, lev, logger: deps.logger }));
      lev.start(opts.tickMs ?? Number(deps.env.LEVIATHAN_TICK_MS ?? 15_000));
      return { 'leviathan.service': lev };
    },
  };
}

export const leviathanModule = createLeviathanModule();
