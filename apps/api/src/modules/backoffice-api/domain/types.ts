/**
 * Tipos del módulo backoffice-api.
 *
 * Fórmulas (documentadas aquí y en /dashboard → `formulas`):
 *  - GGR = Σ apuestas liquidadas − Σ ganancias (bet.settled). Se usa lo liquidado para que apuestas y premios sean comparables.
 *  - NGR = GGR − bonos otorgados − jackpots financiados por la casa.
 *      · bonos otorgados: promotions.bonuses (amount de cada PlayerBonus con grantTxId, por fecha de activación);
 *        si el módulo no está montado se informa en `warnings` y el costo es 0.
 *      · jackpots de la casa: seed funding (INITIAL + RESEED) de los jackpots; las contribuciones salen de las apuestas de los jugadores y no cuentan.
 *  - Depositantes únicos: jugadores distintos con deposit.completed en el rango. FTD: deposit.completed con isFirst.
 *  - Jugadores activos: jugadores distintos con cualquier evento (login, apuesta, depósito, retiro, registro).
 *  - Retención Dn: de los registrados el día d (con d+n ya transcurrido), % con actividad el día d+n.
 * Los importes se suman tal cual: se asume una moneda por operador.
 */

export const DAY_COUNTERS = [
  'registrations',
  'logins',
  'activePlayers',
  'depositors',
  'bettors',
  'ftdCount',
  'ftdAmount',
  'depositsCount',
  'depositsAmount',
  'withdrawalsCount',
  'withdrawalsAmount',
  'betCount',
  'stakePlaced',
  'settledCount',
  'settledStake',
  'settledWins',
] as const;

export type DayCounter = (typeof DAY_COUNTERS)[number];

const BIG: ReadonlySet<DayCounter> = new Set<DayCounter>(['ftdAmount', 'depositsAmount', 'withdrawalsAmount', 'stakePlaced', 'settledStake', 'settledWins']);
export const isBigCounter = (c: DayCounter): boolean => BIG.has(c);

export interface DayRow {
  operatorId: string;
  day: string;
  registrations: number;
  logins: number;
  activePlayers: number;
  depositors: number;
  bettors: number;
  ftdCount: number;
  ftdAmount: bigint;
  depositsCount: number;
  depositsAmount: bigint;
  withdrawalsCount: number;
  withdrawalsAmount: bigint;
  betCount: number;
  stakePlaced: bigint;
  settledCount: number;
  settledStake: bigint;
  settledWins: bigint;
}

export const emptyRow = (operatorId: string, day: string): DayRow => ({
  operatorId,
  day,
  registrations: 0,
  logins: 0,
  activePlayers: 0,
  depositors: 0,
  bettors: 0,
  ftdCount: 0,
  ftdAmount: 0n,
  depositsCount: 0,
  depositsAmount: 0n,
  withdrawalsCount: 0,
  withdrawalsAmount: 0n,
  betCount: 0,
  stakePlaced: 0n,
  settledCount: 0,
  settledStake: 0n,
  settledWins: 0n,
});

export type DayDelta = Partial<Record<DayCounter, number | bigint>>;
export type PlayerDayKind = 'active' | 'depositor' | 'bettor';

/** Almacén de la proyección de KPIs. */
export interface KpiRepository {
  /** true si la clave era nueva (idempotencia de eventos). */
  claimEvent(key: string): Promise<boolean>;
  bumpDay(operatorId: string, day: string, delta: DayDelta): Promise<void>;
  /** Marca (jugador, día, tipo). true si era nueva. */
  touchPlayerDay(operatorId: string, day: string, playerId: string, kind: PlayerDayKind): Promise<boolean>;
  /** Fija el día de registro / primer depósito solo si no existían. */
  setPlayerMilestone(operatorId: string, playerId: string, milestone: { registeredDay?: string; firstDepositDay?: string }): Promise<void>;
  /** Filas por operador y día dentro de [from, to] (YYYY-MM-DD, inclusivo). */
  getDays(operatorId: string | undefined, from: string, to: string): Promise<DayRow[]>;
  /** Jugadores distintos con la marca en el rango, por operador. */
  distinctPlayers(operatorId: string | undefined, from: string, to: string, kind: PlayerDayKind): Promise<number>;
  listRegistrations(operatorId: string | undefined, from: string, to: string): Promise<Array<{ operatorId: string; playerId: string; day: string }>>;
  /** Días activos de los jugadores indicados (todos pertenecen al mismo operador). */
  activeDaysOf(operatorId: string, playerIds: string[]): Promise<Map<string, Set<string>>>;
}

export interface Skin {
  name: string;
  logoUrl: string;
  colors: { primary: string; secondary: string; background: string; surface: string; text: string; accent: string };
  banners: Array<{ title: string; subtitle: string; imageUrl?: string; href: string }>;
}

/**
 * Puerto de skins. La Fase 1 tiene el modelo Skin (por operador) y debe implementar:
 *   get(operatorId) → Skin | null   (null = sin skin configurada → se sirve la skin por defecto)
 *   update(operatorId, skin) → Skin (upsert; el skin ya llega validado y saneado)
 * Para sustituir el adaptador por defecto: publicar `services.skins` antes de registrar este módulo.
 */
export interface SkinPort {
  get(operatorId: string): Promise<Skin | null>;
  update(operatorId: string, skin: Skin): Promise<Skin>;
}

/** Costos que restan al GGR para llegar al NGR (fecha = día UTC). */
export interface CostSource {
  bonusGrants(operatorId: string | undefined, from: string, to: string): Promise<Array<{ operatorId: string; day: string; amount: bigint }>>;
  jackpotFunding(operatorId: string | undefined, from: string, to: string): Promise<Array<{ operatorId: string; day: string; amount: bigint }>>;
  /** Fuentes no disponibles (módulo no montado). */
  missing(): string[];
}
