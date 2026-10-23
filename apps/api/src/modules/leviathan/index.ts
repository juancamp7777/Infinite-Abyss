import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type { NymfoModule } from '../shared/module';
import { LeviathanService } from './application/LeviathanService';
import { buildLeviathanRouter } from './http/routes';

export const LEVIATHAN_PREFIX = '/leviathan/v1';

/**
 * Leviathan: concursos de fichas sobre deportes (heredado de BetBattle). Pozo cerrado con comisión del 5 %, reparto
 * por resto mayor y devolución completa si se cancela. Feed simulado hasta conectar un proveedor deportivo.
 * Requiere Postgres. HTTP en /leviathan/v1. Servicio: 'leviathan.service'.
 */
export function createLeviathanModule(opts: { tickMs?: number; now?: () => Date; rand?: () => number } = {}): NymfoModule {
  return {
    name: 'leviathan',
    async register(app, _io, deps) {
      if (!deps.prisma) {
        deps.logger.warn('[leviathan] sin base de datos: el módulo no se monta');
        return {};
      }
      const lev = new LeviathanService(deps.prisma as PrismaClient, deps.wallet, { logger: deps.logger, now: opts.now, rand: opts.rand });
      app.use(LEVIATHAN_PREFIX, express.json({ limit: '50kb' }), buildLeviathanRouter({ auth: deps.auth, lev, logger: deps.logger }));
      lev.start(opts.tickMs ?? Number(deps.env.LEVIATHAN_TICK_MS ?? 15_000));
      return { 'leviathan.service': lev };
    },
  };
}

export const leviathanModule = createLeviathanModule();
