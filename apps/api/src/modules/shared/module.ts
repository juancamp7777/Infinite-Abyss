import type { Application } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import type { EventBus } from './events/EventBus';
import type { AuthPort } from './ports/AuthPort';
import type { BetGuardPort } from './ports/BetGuardPort';
import type { GameCatalogPort } from './ports/GameCatalogPort';
import type { OperatorCurrencyPort } from './ports/OperatorCurrencyPort';
import type { PlayerCompliancePort } from './ports/PlayerCompliancePort';
import type { SegmentPort } from './ports/SegmentPort';
import type { WalletPort } from './ports/WalletPort';

/** Logger mínimo compatible con winston (apps/api/src/infrastructure/logging/logger.ts). */
export interface ModuleLogger {
  info(message: string, meta?: Record<string, unknown>): unknown;
  warn(message: string, meta?: Record<string, unknown>): unknown;
  error(message: string, meta?: Record<string, unknown>): unknown;
  debug?(message: string, meta?: Record<string, unknown>): unknown;
}

export interface ModuleDeps {
  wallet: WalletPort;
  bus: EventBus;
  auth: AuthPort;
  compliance: PlayerCompliancePort;
  catalog?: GameCatalogPort;
  betGuard?: BetGuardPort;
  segments?: SegmentPort;
  /** Moneda y límites de apuesta del operador. Sin él (dev-server) los módulos usan su variable de entorno de respaldo. */
  operators?: OperatorCurrencyPort;
  /** PrismaClient opcional: sin él los módulos usan repositorios InMemory. */
  prisma?: unknown;
  logger: ModuleLogger;
  env: NodeJS.ProcessEnv;
  /** Servicios publicados por los módulos ya montados (clave: `<modulo>.<servicio>`, p. ej. 'crm.segments'). */
  services: Record<string, unknown>;
}

export interface NymfoModule {
  name: string;
  /** Monta rutas/sockets/suscripciones y devuelve los servicios que publica. */
  register(app: Application, io: SocketIOServer | undefined, deps: ModuleDeps): Promise<Record<string, unknown>>;
}

/** Logger silencioso para pruebas. */
export const silentLogger: ModuleLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
