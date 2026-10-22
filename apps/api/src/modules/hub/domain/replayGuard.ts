/**
 * Anti-replay de callbacks firmados: ventana de tiempo sobre X-Timestamp y nonce de un solo uso.
 * El nonce solo se "gasta" después de verificar la firma (un tercero no puede quemar nonces ajenos).
 */

export interface NonceStore {
  /** true si el nonce es nuevo (y queda reservado ttlMs); false si ya se usó. */
  claim(key: string, ttlMs: number): Promise<boolean>;
}

/**
 * Memoria del proceso. Con varias instancias de la API hace falta un almacén compartido (Redis SET NX EX):
 * mismo contrato, otra implementación.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now, private readonly maxEntries = 200_000) {}

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const t = this.now();
    if (t - this.lastSweep > 60_000 || this.seen.size >= this.maxEntries) this.sweep(t);
    const until = this.seen.get(key);
    if (until !== undefined && until > t) return false;
    this.seen.set(key, t + ttlMs);
    return true;
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [k, until] of this.seen) if (until <= t) this.seen.delete(k);
    // Lleno incluso tras limpiar: se descartan los más antiguos (orden de inserción) para no crecer sin límite.
    while (this.seen.size >= this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
  }
}

/** Timestamp Unix en segundos, solo dígitos (sin decimales, espacios ni unidades). */
export function parseUnixSeconds(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

/** ¿El timestamp está dentro de ±windowSec del reloj (bordes incluidos)? */
export function withinWindow(tsSec: number, nowMs: number, windowSec: number): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - tsSec) <= windowSec;
}
