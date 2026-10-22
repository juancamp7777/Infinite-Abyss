import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** Validaciones anti-SSRF (postbacks) y anti open-redirect (clics). */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return false;
}

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.');
}

export const POSTBACK_PLACEHOLDERS = ['click_id', 'player_id', 'event', 'amount'] as const;

/** Valida sintácticamente la plantilla de postback. En producción exige https y rechaza hosts privados/localhost. */
export function validatePostbackTemplate(template: string, production: boolean): URL {
  const probe = template.replace(/\{(\w+)\}/g, (m, k: string) => ((POSTBACK_PLACEHOLDERS as readonly string[]).includes(k) ? 'x' : m));
  if (/[{}]/.test(probe)) throw new UnsafeUrlError('La plantilla solo admite {click_id}, {player_id}, {event} y {amount}');
  let url: URL;
  try {
    url = new URL(probe);
  } catch {
    throw new UnsafeUrlError('URL de postback inválida');
  }
  if (url.username || url.password) throw new UnsafeUrlError('La URL no puede incluir credenciales');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    throw new UnsafeUrlError('El postback debe usar https');
  }
  if (production) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) ? isPrivateIp(host) : isPrivateHostname(host)) throw new UnsafeUrlError('Host no permitido (privado o localhost)');
  }
  return url;
}

export type HostResolver = (host: string) => Promise<string[]>;

export const defaultResolver: HostResolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

/** Comprobación en el momento del envío (defensa contra DNS que apunta a IP privada). Solo en producción. */
export async function assertResolvesPublic(url: URL, resolver: HostResolver = defaultResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : await resolver(host);
  if (ips.length === 0 || ips.some(isPrivateIp)) throw new UnsafeUrlError('El host resuelve a una IP privada');
}

/** ¿El destino del clic pertenece a la lista de dominios permitidos (host exacto o subdominio)? Solo http(s). */
export function isAllowedRedirect(target: string, allowedDomains: string[]): URL | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const ok = allowedDomains.some((d) => {
    const dom = d.toLowerCase().replace(/^\*?\./, '');
    return dom !== '' && (host === dom || host.endsWith(`.${dom}`));
  });
  return ok ? url : null;
}
