/**
 * Feed público de apuestas liquidadas (como "Apuestas en vivo" del lobby): reglas puras, sin E/S.
 * Montos bigint en unidades mínimas. El jugador nunca aparece por su id: solo por pseudónimo.
 */

export type FeedKind = 'all' | 'high' | 'lucky';
export const FEED_KINDS: readonly FeedKind[] = ['all', 'high', 'lucky'];

export interface FeedBet {
  /** Único por operador: `<provider>:<roundId>`. */
  id: string;
  gameId: string;
  gameTitle: string;
  provider: string;
  category: string;
  player: string;
  currency: string;
  amount: bigint;
  win: bigint;
  multiplier: number;
  at: string;
}

export interface FeedConfig {
  /** Entradas que se guardan por lista (todas, grandes apostadores, grandes victorias y las de cada jugador). */
  size: number;
  /** Apuesta mínima por moneda para "grandes apostadores". Sin entrada para la moneda, la apuesta no entra. */
  highRollerMin: Record<string, bigint>;
  /** Multiplicador mínimo para "grandes victorias" (solo apuestas con monto > 0). */
  luckyMultiplier: number;
  /** Jugadores con historial propio en memoria por operador; se descartan los menos recientes. */
  maxPlayers: number;
}

export const DEFAULT_FEED_CONFIG: FeedConfig = { size: 50, highRollerMin: {}, luckyMultiplier: 10, maxPlayers: 10_000 };

/** Lista acotada: la más reciente primero. */
class Recent<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.items.unshift(item);
    if (this.items.length > this.cap) this.items.length = this.cap;
  }
  take(limit: number): T[] {
    return this.items.slice(0, Math.max(0, limit));
  }
}

interface OperatorFeed {
  lists: Record<FeedKind, Recent<FeedBet>>;
  /** Ventana de ids ya vistos para descartar entregas duplicadas. */
  ids: Set<string>;
  idOrder: string[];
  /** Map con orden de inserción = orden de uso (LRU). */
  players: Map<string, Recent<FeedBet>>;
}

/** Clasifica una apuesta en las listas públicas a las que pertenece. */
export function classify(bet: Pick<FeedBet, 'amount' | 'currency' | 'multiplier'>, cfg: FeedConfig): FeedKind[] {
  const kinds: FeedKind[] = ['all'];
  const min = cfg.highRollerMin[bet.currency.toUpperCase()];
  if (min !== undefined && bet.amount >= min) kinds.push('high');
  if (bet.amount > 0n && Number.isFinite(bet.multiplier) && bet.multiplier >= cfg.luckyMultiplier) kinds.push('lucky');
  return kinds;
}

export class BetFeed {
  private readonly ops = new Map<string, OperatorFeed>();
  /** Dueño de cada apuesta, ligado al objeto: privado (nunca sale en el feed) y se libera al salir de todas las listas. */
  private readonly owners = new WeakMap<FeedBet, string>();

  constructor(private readonly cfg: FeedConfig = DEFAULT_FEED_CONFIG) {
    if (!Number.isInteger(cfg.size) || cfg.size < 1) throw new Error('FeedConfig.size debe ser un entero ≥ 1');
    if (!Number.isInteger(cfg.maxPlayers) || cfg.maxPlayers < 1) throw new Error('FeedConfig.maxPlayers debe ser un entero ≥ 1');
  }

  /**
   * Registra una apuesta. Devuelve las listas públicas donde entró, o null si es un duplicado
   * (el bus entrega al menos una vez: la misma ronda no se cuenta dos veces).
   */
  add(operatorId: string, playerId: string, bet: FeedBet): FeedKind[] | null {
    const op = this.operator(operatorId);
    if (op.ids.has(bet.id)) return null;
    op.ids.add(bet.id);
    this.owners.set(bet, playerId);
    op.idOrder.push(bet.id);
    // Recordamos ids suficientes para cubrir todas las listas; más allá, un duplicado tardío ya no es visible.
    const keep = this.cfg.size * (FEED_KINDS.length + 1);
    while (op.idOrder.length > keep) op.ids.delete(op.idOrder.shift()!);

    const kinds = classify(bet, this.cfg);
    for (const k of kinds) op.lists[k].push(bet);

    let mine = op.players.get(playerId);
    if (mine) op.players.delete(playerId);
    else mine = new Recent<FeedBet>(this.cfg.size);
    mine.push(bet);
    op.players.set(playerId, mine);
    if (op.players.size > this.cfg.maxPlayers) op.players.delete(op.players.keys().next().value!);
    return kinds;
  }

  list(operatorId: string, kind: FeedKind, limit = this.cfg.size): FeedBet[] {
    return this.ops.get(operatorId)?.lists[kind].take(limit) ?? [];
  }

  /** true si la apuesta (un objeto devuelto por list/listMine) es del jugador. */
  isOwner(bet: FeedBet, playerId: string): boolean {
    return this.owners.get(bet) === playerId;
  }

  listMine(operatorId: string, playerId: string, limit = this.cfg.size): FeedBet[] {
    return this.ops.get(operatorId)?.players.get(playerId)?.take(limit) ?? [];
  }

  private operator(operatorId: string): OperatorFeed {
    let op = this.ops.get(operatorId);
    if (!op) {
      const lists = Object.fromEntries(FEED_KINDS.map((k) => [k, new Recent<FeedBet>(this.cfg.size)])) as Record<FeedKind, Recent<FeedBet>>;
      op = { lists, ids: new Set(), idOrder: [], players: new Map() };
      this.ops.set(operatorId, op);
    }
    return op;
  }
}

/**
 * Lee `FEED_HIGH_ROLLER_MIN`: pares `MONEDA:monto` en unidades mínimas separados por coma,
 * p. ej. `USD:100000,COP:400000000`. Lanza si el formato es inválido (mejor fallar al arrancar que en silencio).
 */
export function parseHighRollerMin(raw: string | undefined): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const part of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z]{3,10}):(\d{1,30})$/.exec(part);
    if (!m) throw new Error(`FEED_HIGH_ROLLER_MIN inválido: "${part}" (formato MONEDA:monto)`);
    out[m[1].toUpperCase()] = BigInt(m[2]);
  }
  return out;
}
