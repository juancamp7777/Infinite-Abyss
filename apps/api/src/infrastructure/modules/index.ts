import type { PrismaClient } from '@prisma/client';
import type { IResponsibleGamingPolicy } from '../../domain/contracts';
import type { JwtService } from '../auth/JwtService';
import type { PrismaWalletService } from '../ledger/PrismaWalletService';
import type { RegisterModulesDeps } from '../../modules';
import type { EventBus } from '../../modules/shared/events/EventBus';
import type { ModuleLogger } from '../../modules/shared/module';
import { createModuleWalletAdapters } from './wallet';
import { Phase1ModuleAuth } from './auth/Phase1ModuleAuth';
import { Phase1BetGuard, Phase1PlayerCompliance } from './compliance/Phase1Compliance';
import { PrismaOperatorCurrency } from './operators/PrismaOperatorCurrency';

export { PrismaOperatorCurrency, parseBetLimits } from './operators/PrismaOperatorCurrency';
export { Phase1ModuleAuth, BACKOFFICE_ROLE_MAP } from './auth/Phase1ModuleAuth';
export { Phase1PlayerCompliance, Phase1BetGuard } from './compliance/Phase1Compliance';
export { Phase1GameEvents, PHASE1_PROVIDER, phase1GameId } from './events/Phase1GameEvents';
export { publishSafe, publishInBackground, type DomainEventSink } from './events/publishSafe';

export interface ModuleIntegrationInput {
  prisma: PrismaClient;
  /** Billetera Prisma SIN decorar: los módulos emiten sus propios eventos de apuesta. */
  walletService: PrismaWalletService;
  jwt: JwtService;
  rgPolicy: IResponsibleGamingPolicy;
  bus: EventBus;
  logger: ModuleLogger;
  env: NodeJS.ProcessEnv;
}

/**
 * Adaptadores reales de la Fase 1 para los módulos Infinite Abyss (lo que dev-server.ts sustituye por InMemoryWallet/MockAuth):
 * billetera y fondos de bono sobre el ledger Prisma, auth sobre los JWT, cumplimiento y betGuard sobre juego responsable.
 * Devuelve los deps listos para `registerModules`.
 */
export function buildModuleDeps(input: ModuleIntegrationInput): RegisterModulesDeps {
  const adapters = createModuleWalletAdapters({ prisma: input.prisma, wallet: input.walletService, logger: input.logger });
  return {
    wallet: adapters.wallet,
    bus: input.bus,
    auth: new Phase1ModuleAuth(input.jwt, input.prisma),
    operators: new PrismaOperatorCurrency(input.prisma),
    compliance: new Phase1PlayerCompliance(input.prisma),
    betGuard: new Phase1BetGuard(input.prisma, input.rgPolicy),
    prisma: input.prisma,
    logger: input.logger,
    env: input.env,
    services: {
      'wallet.bonusFunds': adapters.bonusFunds,
      'wallet.jackpotLedger': adapters.jackpotLedger,
    },
  };
}
