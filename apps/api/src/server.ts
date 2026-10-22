import { getConfig } from './config/env';
import { createApp } from './app';
import { logger } from './infrastructure/logging/logger';
import { startReconciliationJob } from './infrastructure/jobs/reconciliationJob';

// Carga .env si existe (Node >= 20.12); en Docker las variables ya vienen del entorno.
try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const config = getConfig();
const { httpServer, services, close, ready } = createApp(config);

// Si los módulos Nymfo no se pueden montar, el proceso no debe quedar sirviendo a medias.
ready.catch((err: unknown) => {
  logger.error('Nymfo modules failed to mount; exiting', { event: 'MODULES_MOUNT_FATAL', error: String(err) });
  process.exit(1);
});

// RECONCILIATION_INTERVAL_MINUTES=0 o RECONCILIATION_DISABLED=true deshabilitan el job.
const job = startReconciliationJob(services.reconciliationService, {
  intervalMinutes: config.reconciliationIntervalMinutes,
  disabled: process.env.RECONCILIATION_DISABLED === 'true' || config.nodeEnv === 'test',
});

httpServer.listen(config.port, () => {
  logger.info(`Nymfo API listening on port ${config.port}`, { event: 'SERVER_START' });
});

let shuttingDown = false;
const gracefulShutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Starting graceful shutdown...`, { event: 'SERVER_SHUTDOWN' });

  // Si algo se cuelga, forzar la salida a los 10 s.
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down', { event: 'FORCE_SHUTDOWN' });
    process.exit(1);
  }, 10_000).unref();

  try {
    job.stop();
    // close() detiene también los temporizadores de los módulos y vacía el bus de eventos.
    await close();
    await services.prisma.$disconnect();
    logger.info('Shutdown complete', { event: 'SERVER_STOPPED' });
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { event: 'SHUTDOWN_ERROR', error: (err as Error).message });
    process.exit(1);
  }
};

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
