import { BlockList, isIP } from 'net';

/**
 * Allowlist de IPs de un proveedor (IPs sueltas y CIDR, IPv4/IPv6), p. ej. "203.0.113.50,198.51.100.0/24".
 * Sin configurar (undefined/vacía) devuelve null = sin restricción; una entrada inválida lanza al arrancar.
 */
export function parseAllowlist(raw: string | undefined): BlockList | null {
  const parts = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const list = new BlockList();
  for (const p of parts) {
    const [addr, prefix] = p.split('/');
    const family = isIP(addr);
    if (!family) throw new Error(`IP inválida en la allowlist: "${p}"`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(addr, type);
    else {
      const bits = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || bits > (family === 6 ? 128 : 32)) throw new Error(`Prefijo CIDR inválido en la allowlist: "${p}"`);
      list.addSubnet(addr, bits, type);
    }
  }
  return list;
}

/** IPv4 mapeada en IPv6 (::ffff:1.2.3.4, típica de Node) → IPv4. */
export function normalizeIp(ip: string | undefined): string {
  const v = (ip ?? '').trim();
  return v.startsWith('::ffff:') && isIP(v.slice(7)) === 4 ? v.slice(7) : v;
}

export function ipAllowed(list: BlockList | null, ip: string | undefined): boolean {
  if (!list) return true;
  const v = normalizeIp(ip);
  const family = isIP(v);
  if (!family) return false;
  return list.check(v, family === 6 ? 'ipv6' : 'ipv4');
}
