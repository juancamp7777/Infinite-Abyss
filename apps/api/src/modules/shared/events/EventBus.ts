/**
 * Bus de eventos de dominio compartido. CRM, marketing, promociones y gamificación consumen estos eventos.
 * Los montos son bigint en unidades mínimas; `at` es ISO-8601.
 */

export interface EventBase {
  operatorId: string;
  playerId: string;
  at: string;
}

export interface UtmParams {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
}

export type GameCategory = 'slots' | 'originals' | 'live' | 'table' | 'other';

export interface DomainEvents {
  'player.registered': EventBase & {
    currency: string;
    country?: string;
    /** YYYY-MM-DD */
    birthDate?: string;
    email?: string;
    utm?: UtmParams;
    affiliateCode?: string;
  };
  'deposit.completed': EventBase & { amount: bigint; currency: string; isFirst: boolean; txId: string };
  'withdrawal.completed': EventBase & { amount: bigint; currency: string; txId: string };
  'bet.placed': EventBase & {
    amount: bigint;
    currency: string;
    gameId: string;
    provider: string;
    category: GameCategory | string;
    roundId: string;
    isBonusMoney?: boolean;
  };
  'bet.settled': EventBase & {
    amount: bigint;
    win: bigint;
    currency: string;
    gameId: string;
    provider: string;
    category: GameCategory | string;
    roundId: string;
    multiplier: number;
  };
  'session.started': EventBase & { sessionId: string; device?: string };
  login: EventBase & { ip?: string };
}

export type DomainEventName = keyof DomainEvents;
export type EventHandler<K extends DomainEventName> = (payload: DomainEvents[K]) => void | Promise<void>;

export interface EventBus {
  publish<K extends DomainEventName>(name: K, payload: DomainEvents[K]): Promise<void>;
  /** Devuelve la función para desuscribirse. */
  subscribe<K extends DomainEventName>(name: K, handler: EventHandler<K>): () => void;
}

interface MinimalLogger {
  error(message: string, meta?: Record<string, unknown>): unknown;
}

/**
 * Implementación en memoria. Los handlers se ejecutan de forma asíncrona tras publish
 * (publish espera a que todos terminen) y sus errores se registran sin romper al publicador
 * ni a los demás handlers. drain() espera a que terminen todas las entregas pendientes.
 */
export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Map<DomainEventName, Set<EventHandler<any>>>();
  private readonly pending = new Set<Promise<void>>();
  /** Errores capturados (útil en pruebas). */
  readonly errors: Array<{ event: DomainEventName; error: unknown }> = [];

  constructor(private readonly logger?: MinimalLogger) {}

  subscribe<K extends DomainEventName>(name: K, handler: EventHandler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async publish<K extends DomainEventName>(name: K, payload: DomainEvents[K]): Promise<void> {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return;
    const deliveries = [...set].map((h) => this.deliver(name, h, payload));
    await Promise.all(deliveries);
  }

  /** Espera a que se completen todas las entregas en curso (incluidas las encadenadas). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private deliver<K extends DomainEventName>(name: K, handler: EventHandler<K>, payload: DomainEvents[K]): Promise<void> {
    const p = (async () => {
      try {
        await handler(payload);
      } catch (error) {
        this.errors.push({ event: name, error });
        this.logger?.error(`EventBus: fallo en handler de ${name}`, {
          event: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  }
}

/*
 * Adaptador Redis/colas (sin dependencias en este repo). Esquema sugerido:
 *
 *   class RedisStreamsEventBus implements EventBus {
 *     constructor(private redis: RedisLike, private group: string) {}
 *     async publish(name, payload) {
 *       // Serializar con bigintReplacer (money.ts) y XADD `nymfo:events:${name}` * data <json>
 *     }
 *     subscribe(name, handler) {
 *       // XREADGROUP GROUP <group> <consumer> BLOCK 5000 STREAMS `nymfo:events:${name}` >
 *       // Revivir bigint (campos amount/win) con BigInt(), invocar handler y XACK solo si no lanza.
 *       // Los handlers deben ser idempotentes (entrega al-menos-una-vez).
 *       return () => { // detener el bucle de lectura };
 *     }
 *   }
 *
 * Igual para SQS/RabbitMQ: un topic por evento, ack tras el handler y dead-letter tras N reintentos.
 */
