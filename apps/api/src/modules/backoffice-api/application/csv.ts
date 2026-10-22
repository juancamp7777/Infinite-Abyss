export type CsvCell = string | number | bigint | boolean | null | undefined | Date;

/** Neutraliza inyección de fórmulas (Excel/Sheets): las cadenas que empiezan por = + - @ (o tab/CR) llevan un apóstrofo delante. */
export function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** Escapa una celda CSV (RFC 4180). Números y bigint van tal cual (un negativo legítimo no es fórmula). */
export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'bigint') s = v.toString();
  else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else if (v instanceof Date) s = v.toISOString();
  else s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}
