import type { Rule } from '../../shared/ports/SegmentPort';

/** Tipo de jugador para elegir a quién va una push manual. `rule` usa el DSL de segmentos del CRM (null = todos). */
export interface PushAudience {
  key: string;
  label: string;
  hint: string;
  rule: Rule | null;
}

export const PUSH_AUDIENCES: readonly PushAudience[] = [
  { key: 'all', label: 'Todos', hint: 'Todos los jugadores con notificaciones activas.', rule: null },
  {
    key: 'leads', label: 'Nuevos leads', hint: 'Se registraron en los últimos 7 días y todavía no cargan.',
    rule: { all: [{ field: 'registeredAt', op: 'within_days', value: 7 }, { field: 'depositCount', op: 'eq', value: 0 }] },
  },
  { key: 'never', label: 'Nunca han cargado', hint: 'Registrados (de cualquier fecha) sin ninguna carga.', rule: { field: 'depositCount', op: 'eq', value: 0 } },
  { key: 'first', label: 'Primera carga reciente', hint: 'Hicieron su primera carga en los últimos 7 días.', rule: { field: 'firstDepositAt', op: 'within_days', value: 7 } },
  {
    key: 'recurring', label: 'Recurrentes', hint: '3 o más cargas y la última hace 14 días o menos.',
    rule: { all: [{ field: 'depositCount', op: 'gte', value: 3 }, { field: 'lastDepositAt', op: 'within_days', value: 14 }] },
  },
  {
    key: 'inactive', label: 'Inactivos', hint: 'Ya cargaron alguna vez y no juegan hace más de 14 días.',
    rule: { all: [{ field: 'depositCount', op: 'gte', value: 1 }, { field: 'lastActivityAt', op: 'older_than_days', value: 14 }] },
  },
  { key: 'dormant', label: 'Dormidos', hint: 'Sin ninguna actividad hace más de 30 días.', rule: { field: 'lastActivityAt', op: 'older_than_days', value: 30 } },
  { key: 'churn', label: 'En riesgo de irse', hint: 'El CRM los marca con riesgo alto de abandono.', rule: { field: 'churnRisk', op: 'eq', value: 'high' } },
  { key: 'vip', label: 'VIP', hint: 'Los de mayor valor (puntaje VIP 70 o más).', rule: { field: 'vipScore', op: 'gte', value: 70 } },
];
