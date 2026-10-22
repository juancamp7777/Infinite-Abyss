import { logger } from '../logging/logger';

interface Reconciler {
  run(input?: { operatorId?: string }): Promise<{ totalDiscrepancies: number }>;
}

export interface ReconciliationJobOptions {
  intervalMinutes: number;
  /** Desactiva el job (devuelve un handle vacío). Nunca se activa en tests. */
  disabled?: boolean;
}

export interface ReconciliationJobHandle {
  stop(): void;
  /** Ejecuta una pasada ahora (usado por el temporizador). */
  runOnce(): Promise<void>;
}

/** Reconciliación periódica; las discrepancias se registran con nivel error. */
export function startReconciliationJob(service: Reconciler, opts: ReconciliationJobOptions): ReconciliationJobHandle {
  let running = false;

  const runOnce = async () => {
    if (running) return; // evita solapar pasadas lentas
    running = true;
    try {
      const report = await service.run();
      if (report.totalDiscrepancies > 0) {
        logger.error('Reconciliation found discrepancies', {
          event: 'RECONCILIATION_DISCREPANCIES',
          totalDiscrepancies: report.totalDiscrepancies,
          report: JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        });
      } else {
        logger.info('Reconciliation OK', { event: 'RECONCILIATION_OK' });
      }
    } catch (err) {
      logger.error('Reconciliation job failed', { event: 'RECONCILIATION_FAILED', error: (err as Error).message });
    } finally {
      running = false;
    }
  };

  if (opts.disabled || opts.intervalMinutes <= 0) return { stop() {}, runOnce };
  const timer = setInterval(() => void runOnce(), opts.intervalMinutes * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce };
}
