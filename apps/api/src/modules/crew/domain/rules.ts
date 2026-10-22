/**
 * Reglas puras de Crew (sin E/S, con `now` inyectable): jornada neta, tardanza, cierres de seguridad, nómina y caja.
 * Una sola definición de turno: el turno planificado (inicio/fin en UTC) — nada de turnos por hora de pared.
 */

export interface Pause {
  from: Date;
  to?: Date;
}

const MIN = 60_000;

/** Minutos netos trabajados: duración menos pausas (una pausa abierta cuenta hasta `end`). */
export function netMinutes(startedAt: Date, end: Date, pauses: Pause[]): number {
  const total = Math.max(0, end.getTime() - startedAt.getTime());
  const paused = pauses.reduce((acc, p) => acc + Math.max(0, Math.min((p.to ?? end).getTime(), end.getTime()) - Math.max(p.from.getTime(), startedAt.getTime())), 0);
  return Math.max(0, Math.floor((total - paused) / MIN));
}

/** Tardanza en minutos respecto al turno planificado, con tolerancia. 0 si llegó a tiempo o sin turno planificado. */
export function lateMinutes(plannedStart: Date | null | undefined, startedAt: Date, graceMinutes = 5): number {
  if (!plannedStart) return 0;
  const late = Math.floor((startedAt.getTime() - plannedStart.getTime()) / MIN);
  return late > graceMinutes ? late : 0;
}

export const AUTO_CLOSE = { maxNetMinutes: 14 * 60, maxWallMinutes: 20 * 60 } as const;

/**
 * Cierre de seguridad de una jornada olvidada abierta: a las 14 h netas o 20 h de reloj.
 * Devuelve el instante de cierre (nunca descarta la jornada: queda registrada y marcada como cierre automático).
 */
export function autoCloseAt(startedAt: Date, pauses: Pause[], now: Date): Date | null {
  const wallLimit = new Date(startedAt.getTime() + AUTO_CLOSE.maxWallMinutes * MIN);
  // Instante exacto en que se alcanzaron las horas netas máximas (avanza saltando las pausas).
  let netLimit = new Date(startedAt.getTime() + AUTO_CLOSE.maxNetMinutes * MIN);
  for (let i = 0; i < 20; i++) {
    const net = netMinutes(startedAt, netLimit, pauses);
    if (net >= AUTO_CLOSE.maxNetMinutes || netLimit >= wallLimit) break;
    netLimit = new Date(netLimit.getTime() + (AUTO_CLOSE.maxNetMinutes - net) * MIN);
  }
  const limit = netLimit < wallLimit ? netLimit : wallLimit;
  return now >= limit ? limit : null;
}

export type PayType = 'monthly' | 'hourly';
export type SessionKind = 'normal' | 'extra' | 'dayoff';

export interface PayrollInput {
  payType: PayType;
  /** Sueldo mensual (monthly) o valor hora (hourly), en unidades mínimas. */
  baseAmount: bigint;
  /** Horas de referencia del mes para derivar el valor hora del mensual (por defecto 240 = 30 días × 8 h). */
  monthlyHours?: number;
  overtimeMultiplier?: number;
  sessions: Array<{ kind: SessionKind; netMinutes: number }>;
  adjustments: Array<{ type: 'bonus' | 'discount'; amount: bigint }>;
}

export interface PayrollResult {
  normalMinutes: number;
  extraMinutes: number;
  hourlyRate: bigint;
  base: bigint;
  overtime: bigint;
  bonuses: bigint;
  discounts: bigint;
  total: bigint;
}

/**
 * Nómina del mes: mensual = sueldo + horas extra (y francos trabajados) a valor hora × 1,5;
 * por hora = horas normales × valor + extra × valor × 1,5. Ajustes manuales encima. Todo en bigint (sin redondeos flotantes).
 */
export function computePayroll(p: PayrollInput): PayrollResult {
  const monthlyHours = p.monthlyHours ?? 240;
  const mult = Math.round((p.overtimeMultiplier ?? 1.5) * 100);
  const normalMinutes = p.sessions.filter((s) => s.kind === 'normal').reduce((a, s) => a + s.netMinutes, 0);
  const extraMinutes = p.sessions.filter((s) => s.kind !== 'normal').reduce((a, s) => a + s.netMinutes, 0);
  const hourlyRate = p.payType === 'monthly' ? p.baseAmount / BigInt(monthlyHours) : p.baseAmount;
  const base = p.payType === 'monthly' ? p.baseAmount : (hourlyRate * BigInt(normalMinutes)) / 60n;
  const overtime = (hourlyRate * BigInt(extraMinutes) * BigInt(mult)) / 6000n;
  const bonuses = p.adjustments.filter((a) => a.type === 'bonus').reduce((a, x) => a + x.amount, 0n);
  const discounts = p.adjustments.filter((a) => a.type === 'discount').reduce((a, x) => a + x.amount, 0n);
  return { normalMinutes, extraMinutes, hourlyRate, base, overtime, bonuses, discounts, total: base + overtime + bonuses - discounts };
}

/** Caja: saldo esperado = apertura + ingresos − egresos; diferencia = declarado − esperado. */
export function cashExpected(opening: bigint, movements: Array<{ type: 'in' | 'out'; amount: bigint }>): bigint {
  return movements.reduce((acc, m) => (m.type === 'in' ? acc + m.amount : acc - m.amount), opening);
}

export const monthKey = (d: Date) => d.toISOString().slice(0, 7);
export const monthRange = (month: string): { from: Date; to: Date } => {
  const [y, m] = month.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
};
