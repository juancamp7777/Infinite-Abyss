import type { DomainEventName, DomainEvents, EventBus } from '../../../modules/shared/events/EventBus';

/** Lo mínimo que los casos de uso de la Fase 1 necesitan del bus de eventos de los módulos. */
/** Logger mínimo (compatible con winston y con el Logger de los módulos). */
export interface ErrorLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

export type DomainEventSink = Pick<EventBus, 'publish'>;

/**
 * Publica un evento de dominio sin romper nunca al llamador: se invoca DESPUÉS del commit
 * (la operación ya es firme) y cualquier error del bus o de sus listeners se registra y se descarta.
 */
export async function publishSafe<K extends DomainEventName>(
  bus: DomainEventSink | undefined,
  name: K,
  payload: DomainEvents[K],
  logger?: ErrorLogger,
): Promise<void> {
  if (!bus) return;
  try {
    await bus.publish(name, payload);
  } catch (e) {
    logger?.error('domain event publish failed', { event: name, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Variante "dispara y olvida" para caminos calientes (apuestas): no añade latencia a la respuesta. */
export function publishInBackground<K extends DomainEventName>(
  bus: DomainEventSink | undefined,
  name: K,
  payload: DomainEvents[K],
  logger?: ErrorLogger,
): void {
  if (!bus) return;
  void publishSafe(bus, name, payload, logger);
}

export const nowIso = (): string => new Date().toISOString();
