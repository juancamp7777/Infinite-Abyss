/**
 * Ascend para el equipo: XP por trabajo bien hecho (no por volumen vacío), niveles, ligas semanales e insignias.
 * Reglas puras; la actividad la registran Sonar (respuestas), Pearl (cargas aprobadas) y Crew (puntualidad,
 * checklist, tareas, cajas sin diferencia).
 */

export type ActivityType = 'first_response' | 'deposit_approved' | 'checklist' | 'task_done' | 'on_time' | 'cash_perfect';

/** XP de la primera respuesta según la velocidad: premia atender rápido, no escribir mucho. */
export function firstResponseXp(seconds: number): number {
  if (seconds <= 120) return 5;
  if (seconds <= 300) return 3;
  if (seconds <= 900) return 2;
  return 1;
}

export const XP: Record<Exclude<ActivityType, 'first_response'>, number> = {
  deposit_approved: 5,
  checklist: 2,
  task_done: 10,
  on_time: 5,
  cash_perfect: 10,
};

/** Nivel n requiere 25·(n−1)² XP: 1→0, 2→25, 3→100, 4→225, 5→400… */
export function levelFor(xp: number): { level: number; currentLevelXp: number; nextLevelXp: number } {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;
  return { level, currentLevelXp: 25 * (level - 1) ** 2, nextLevelXp: 25 * level ** 2 };
}

export const LEAGUES = [
  { key: 'abismo', label: 'Abismo', minWeeklyXp: 500 },
  { key: 'diamante', label: 'Diamante', minWeeklyXp: 300 },
  { key: 'oro', label: 'Oro', minWeeklyXp: 150 },
  { key: 'plata', label: 'Plata', minWeeklyXp: 60 },
  { key: 'bronce', label: 'Bronce', minWeeklyXp: 0 },
] as const;

export const leagueFor = (weeklyXp: number) => LEAGUES.find((l) => weeklyXp >= l.minWeeklyXp)!;

export interface Counters {
  first_response: number;
  fast_response: number;
  deposit_approved: number;
  checklist: number;
  task_done: number;
  on_time: number;
  cash_perfect: number;
}

export const BADGES: Array<{ key: string; label: string; description: string; earned: (c: Counters) => boolean }> = [
  { key: 'primeras_100', label: 'Voz del Abismo', description: '100 primeras respuestas', earned: (c) => c.first_response >= 100 },
  { key: 'rayo', label: 'Rayo', description: '50 respuestas en menos de 2 minutos', earned: (c) => c.fast_response >= 50 },
  { key: 'perla', label: 'Cazador de perlas', description: '50 cargas aprobadas', earned: (c) => c.deposit_approved >= 50 },
  { key: 'puntual', label: 'Reloj suizo', description: '20 entradas puntuales', earned: (c) => c.on_time >= 20 },
  { key: 'caja_perfecta', label: 'Caja perfecta', description: '10 cierres de caja sin diferencia', earned: (c) => c.cash_perfect >= 10 },
  { key: 'checklist', label: 'Sin cabos sueltos', description: '100 ítems de checklist completados', earned: (c) => c.checklist >= 100 },
  { key: 'tareas', label: 'Ejecutor', description: '25 tareas terminadas', earned: (c) => c.task_done >= 25 },
];

/** Inicio de la semana (lunes 00:00 UTC) para el ranking semanal. */
export function weekStart(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7;
  return new Date(x.getTime() - dow * 86_400_000);
}
