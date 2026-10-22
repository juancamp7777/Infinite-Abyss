/** Render de plantillas con variables {{a.b}} y valor por defecto {{firstName|Jugador}}. */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESC[c]);
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export interface RenderOptions {
  /** 'html': escapa las variables (las plantillas HTML son de confianza, los valores no). 'text': sin escape. */
  mode: 'html' | 'text';
  /** Variables que se insertan sin escapar (p. ej. un enlace ya construido y seguro). Solo claves de primer nivel. */
  rawKeys?: string[];
}

export function renderTemplate(template: string, vars: Record<string, unknown>, opts: RenderOptions): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_m, path: string, fallback?: string) => {
    const v = lookup(vars, path);
    const str = v === undefined || v === null || v === '' ? (fallback ?? '').trim() : typeof v === 'bigint' ? v.toString() : String(v);
    if (opts.mode === 'text') return str;
    return opts.rawKeys?.includes(path) ? str : escapeHtml(str);
  });
}

/** Texto plano aproximado a partir de HTML (alternativa text/plain del email). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
