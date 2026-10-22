import type { PrismaClient } from '@prisma/client';
import type { OperatorBetLimits, OperatorCurrencyInfo, OperatorCurrencyPort } from '../../../modules/shared/ports/OperatorCurrencyPort';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d{1,30}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function limitAmount(v: unknown): bigint | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return typeof v === 'string' && DIGITS_RE.test(v.trim()) ? BigInt(v.trim()) : undefined;
}

/** Extrae minBet/maxBet de Operator.limits (JSON; strings de dígitos en unidades mínimas). */
export function parseBetLimits(limits: unknown): OperatorBetLimits {
  const l = limits && typeof limits === 'object' ? (limits as Record<string, unknown>) : {};
  const out: OperatorBetLimits = {};
  const minBet = limitAmount(l.minBet);
  const maxBet = limitAmount(l.maxBet);
  if (minBet !== undefined) out.minBet = minBet;
  if (maxBet !== undefined) out.maxBet = maxBet;
  return out;
}

/**
 * OperatorCurrencyPort sobre la tabla Operator de la Fase 1.
 * Cachea cada operador unos segundos (se consulta en cada apuesta). Acepta id (uuid) o slug; otros
 * valores (operadores remotos del Hub, sesiones demo sin operador) devuelven null sin tocar la BD.
 */
export class PrismaOperatorCurrency implements OperatorCurrencyPort {
  private readonly cache = new Map<string, { at: number; info: OperatorCurrencyInfo }>();

  constructor(
    private readonly prisma: Pick<PrismaClient, 'operator'>,
    private readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async getCurrencyInfo(operatorId: string): Promise<OperatorCurrencyInfo | null> {
    // Acepta el id (uuid) o el slug del operador; cualquier otro valor no toca la BD.
    const where = UUID_RE.test(operatorId) ? { id: operatorId } : SLUG_RE.test(operatorId) ? { slug: operatorId } : null;
    if (!where) return null;
    const hit = this.cache.get(operatorId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.info;
    const op = await this.prisma.operator.findUnique({
      where,
      select: { defaultCurrency: true, currencies: true, limits: true },
    });
    if (!op) {
      this.cache.delete(operatorId);
      return null;
    }
    const currencies = op.currencies.includes(op.defaultCurrency) ? [...op.currencies] : [op.defaultCurrency, ...op.currencies];
    const info: OperatorCurrencyInfo = { defaultCurrency: op.defaultCurrency, currencies, limits: parseBetLimits(op.limits) };
    this.cache.set(operatorId, { at: this.now(), info });
    return info;
  }
}
