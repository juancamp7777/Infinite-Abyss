/** Fechas locales por zona horaria del operador (IANA). Sin dependencias: usa Intl. */

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD del instante `ms` en la zona `tz`. */
export function localDate(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Lunes de la semana de `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=domingo
  return addDays(date, -((dow + 6) % 7));
}

/** Clave del periodo: día local (daily) o lunes local de la semana (weekly). */
export function periodKey(period: 'daily' | 'weekly', ms: number, tz: string): string {
  const d = localDate(ms, tz);
  return period === 'daily' ? d : weekStart(d);
}
