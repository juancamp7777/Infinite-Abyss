/**
 * Vigilantes de Nautilus: reglas deterministas (sin IA) que miran una foto del casino y devuelven hallazgos.
 * La IA solo explica y prioriza; lo que dispara una alerta es siempre una regla verificable.
 */

export type Severity = 'info' | 'warn' | 'high';

export interface Snapshot {
  /** Conversaciones abiertas con mensajes sin leer y su último mensaje (del jugador) más viejo que el umbral. */
  unansweredChats: { count: number; oldestMinutes: number };
  pearlPendingReview: { count: number; oldestMinutes: number };
  pearlWaitingBank: { count: number; oldestMinutes: number };
  /** Feeds bancarios activos sin eventos recientes. */
  staleFeeds: Array<{ name: string; hoursSilent: number }>;
  withdrawalsPending: { count: number; oldestHours: number; totalMinor: bigint; currency: string | null };
  integrationErrors: Array<{ key: string; message: string | null }>;
  /** Jugadores con muchos depósitos fallidos en la última hora (prueba de tarjetas robadas, abuso). */
  failedDepositBursts: Array<{ userId: string; username: string | null; failed: number }>;
}

export interface Thresholds {
  chatMinutes: number;
  reviewMinutes: number;
  waitingBankMinutes: number;
  feedSilentHours: number;
  withdrawalHours: number;
  failedDepositsPerHour: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  chatMinutes: 10,
  reviewMinutes: 15,
  waitingBankMinutes: 60,
  feedSilentHours: 6,
  withdrawalHours: 2,
  failedDepositsPerHour: 5,
};

export interface Finding {
  /** Estable entre escaneos: el mismo problema actualiza el mismo hallazgo en vez de duplicarlo. */
  key: string;
  kind: 'support' | 'cashier' | 'payments' | 'integrations' | 'fraud';
  severity: Severity;
  title: string;
  detail: string;
  data: Record<string, unknown>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ageText = (min: number) => (min >= 120 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`);

export function detectFindings(s: Snapshot, t: Thresholds = DEFAULT_THRESHOLDS): Finding[] {
  const out: Finding[] = [];

  if (s.unansweredChats.count > 0) {
    const old = s.unansweredChats.oldestMinutes;
    out.push({
      key: 'support:unanswered', kind: 'support', severity: old >= t.chatMinutes * 3 ? 'high' : 'warn',
      title: `${plural(s.unansweredChats.count, 'jugador espera', 'jugadores esperan')} respuesta`,
      detail: `El más antiguo lleva ${ageText(old)} sin respuesta en Sonar · Inbox.`,
      data: { ...s.unansweredChats },
    });
  }
  if (s.pearlPendingReview.count > 0) {
    const old = s.pearlPendingReview.oldestMinutes;
    out.push({
      key: 'cashier:pending_review', kind: 'cashier', severity: old >= t.reviewMinutes * 3 ? 'high' : 'warn',
      title: `${plural(s.pearlPendingReview.count, 'comprobante', 'comprobantes')} para revisar en Pearl`,
      detail: `El más antiguo espera hace ${ageText(old)}. Cada minuto es un jugador sin sus fichas.`,
      data: { ...s.pearlPendingReview },
    });
  }
  if (s.pearlWaitingBank.count > 0) {
    out.push({
      key: 'cashier:waiting_bank', kind: 'cashier', severity: 'warn',
      title: `${plural(s.pearlWaitingBank.count, 'depósito', 'depósitos')} sin pago en el banco`,
      detail: `Llevan más de ${ageText(t.waitingBankMinutes)} esperando el movimiento bancario (el más antiguo, ${ageText(s.pearlWaitingBank.oldestMinutes)}). Revisa el feed o el banco.`,
      data: { ...s.pearlWaitingBank },
    });
  }
  for (const f of s.staleFeeds) {
    out.push({
      key: `payments:feed_silent:${f.name}`, kind: 'payments', severity: f.hoursSilent >= t.feedSilentHours * 4 ? 'high' : 'warn',
      title: `El feed bancario «${f.name}» no reporta`,
      detail: `Sin movimientos hace ${Math.round(f.hoursSilent)} h: Pearl no puede confirmar depósitos automáticamente.`,
      data: { ...f },
    });
  }
  if (s.withdrawalsPending.count > 0) {
    const w = s.withdrawalsPending;
    out.push({
      key: 'payments:withdrawals_pending', kind: 'payments', severity: w.oldestHours >= t.withdrawalHours * 6 ? 'high' : 'warn',
      title: `${plural(w.count, 'retiro', 'retiros')} pendientes de aprobar`,
      detail: `El más antiguo espera hace ${Math.round(w.oldestHours)} h. Los retiros lentos son la primera causa de reclamos.`,
      data: { count: w.count, oldestHours: w.oldestHours, totalMinor: w.totalMinor.toString(), currency: w.currency },
    });
  }
  for (const e of s.integrationErrors) {
    out.push({
      key: `integrations:error:${e.key}`, kind: 'integrations', severity: 'high',
      title: `La integración «${e.key}» falla`,
      detail: e.message ?? 'La última prueba de conexión dio error.',
      data: { ...e },
    });
  }
  for (const p of s.failedDepositBursts) {
    out.push({
      key: `fraud:failed_deposits:${p.userId}`, kind: 'fraud', severity: 'high',
      title: `Posible prueba de tarjetas: ${p.username ?? p.userId.slice(0, 8)}`,
      detail: `${p.failed} depósitos fallidos en la última hora. Revisa la cuenta antes de aprobar retiros.`,
      data: { ...p },
    });
  }
  return out;
}
