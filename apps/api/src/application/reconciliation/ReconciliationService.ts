import { Prisma, PrismaClient } from '@prisma/client';
import type {
  IReconciliationService,
  ReconciliationCheck,
  ReconciliationDiscrepancy,
  ReconciliationReport,
} from '../../domain/contracts';

/**
 * Cuadre del money-path. SQL agregado (sumas en Postgres, casteadas a text para no perder
 * precisión) y comparación en bigint. Filtro opcional por operador.
 */
export class ReconciliationService implements IReconciliationService {
  constructor(private readonly prisma: PrismaClient) {}

  async run(input: { operatorId?: string } = {}): Promise<ReconciliationReport> {
    const operatorId = input.operatorId;
    const checks: ReconciliationCheck[] = [
      await this.txSumZero(operatorId),
      await this.globalSumZero(operatorId),
      await this.cachedVsDerived(operatorId),
      await this.pspDepositsVsClearing(operatorId),
    ];
    return {
      generatedAt: new Date().toISOString(),
      scope: operatorId ?? 'ALL',
      checks,
      totalDiscrepancies: checks.reduce((n, c) => n + c.discrepancies.length, 0),
    };
  }

  private check(name: ReconciliationCheck['name'], discrepancies: ReconciliationDiscrepancy[]): ReconciliationCheck {
    return { name, passed: discrepancies.length === 0, discrepancies };
  }

  // (a) cada LedgerTransaction suma 0
  private async txSumZero(operatorId?: string): Promise<ReconciliationCheck> {
    const filter = operatorId ? Prisma.sql`WHERE t."operatorId" = ${operatorId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { id: string; operatorId: string; currency: string; total: string; entries: bigint }[]
    >`
      SELECT t."id", t."operatorId", t."currency", COALESCE(SUM(e."amount"), 0)::text AS total, COUNT(e."id") AS entries
      FROM "LedgerTransaction" t
      LEFT JOIN "LedgerEntry" e ON e."transactionId" = t."id"
      ${filter}
      GROUP BY t."id", t."operatorId", t."currency"
      HAVING COALESCE(SUM(e."amount"), 0) <> 0`;
    return this.check(
      'TX_SUM_ZERO',
      rows.map((r) => ({
        ref: r.id,
        detail: `LedgerTransaction ${r.id} entries sum to ${r.total} instead of 0 (${r.entries} entries)`,
        expected: '0',
        actual: r.total,
        operatorId: r.operatorId,
        currency: r.currency,
      })),
    );
  }

  // (b) suma por (operador, moneda) = 0 y, sin filtro, por moneda = 0
  private async globalSumZero(operatorId?: string): Promise<ReconciliationCheck> {
    const filter = operatorId ? Prisma.sql`WHERE "operatorId" = ${operatorId}::uuid` : Prisma.empty;
    const perOperator = await this.prisma.$queryRaw<{ operatorId: string; currency: string; total: string }[]>`
      SELECT "operatorId", "currency", SUM("amount")::text AS total
      FROM "LedgerEntry" ${filter}
      GROUP BY "operatorId", "currency"
      HAVING SUM("amount") <> 0`;
    const out: ReconciliationDiscrepancy[] = perOperator.map((r) => ({
      ref: `${r.operatorId}:${r.currency}`,
      detail: `Operator ${r.operatorId} ledger in ${r.currency} sums to ${r.total} instead of 0`,
      expected: '0',
      actual: r.total,
      operatorId: r.operatorId,
      currency: r.currency,
    }));
    if (!operatorId) {
      const perCurrency = await this.prisma.$queryRaw<{ currency: string; total: string }[]>`
        SELECT "currency", SUM("amount")::text AS total
        FROM "LedgerEntry"
        GROUP BY "currency"
        HAVING SUM("amount") <> 0`;
      for (const r of perCurrency) {
        out.push({
          ref: r.currency,
          detail: `Global ledger in ${r.currency} sums to ${r.total} instead of 0`,
          expected: '0',
          actual: r.total,
          currency: r.currency,
        });
      }
    }
    return this.check('GLOBAL_SUM_ZERO', out);
  }

  // (c) saldo cacheado == suma derivada de las entradas
  private async cachedVsDerived(operatorId?: string): Promise<ReconciliationCheck> {
    const filter = operatorId ? Prisma.sql`WHERE a."operatorId" = ${operatorId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      { id: string; operatorId: string; type: string; ownerKey: string; currency: string; cached: string; derived: string }[]
    >`
      SELECT a."id", a."operatorId", a."type"::text AS type, a."ownerKey", a."currency",
             a."balance"::text AS cached, COALESCE(SUM(e."amount"), 0)::text AS derived
      FROM "LedgerAccount" a
      LEFT JOIN "LedgerEntry" e ON e."accountId" = a."id"
      ${filter}
      GROUP BY a."id"
      HAVING a."balance" <> COALESCE(SUM(e."amount"), 0)`;
    return this.check(
      'CACHED_VS_DERIVED',
      rows.map((r) => ({
        ref: r.id,
        detail: `Account ${r.type} (${r.ownerKey}) cached balance ${r.cached} != derived ${r.derived}`,
        expected: r.derived,
        actual: r.cached,
        operatorId: r.operatorId,
        currency: r.currency,
      })),
    );
  }

  // (d) depósitos CONFIRMED del PSP == entradas de PSP_CLEARING de transacciones DEPOSIT
  private async pspDepositsVsClearing(operatorId?: string): Promise<ReconciliationCheck> {
    const depFilter = operatorId ? Prisma.sql`AND d."operatorId" = ${operatorId}::uuid` : Prisma.empty;
    const clrFilter = operatorId ? Prisma.sql`AND t."operatorId" = ${operatorId}::uuid` : Prisma.empty;

    const confirmed = await this.prisma.$queryRaw<
      { operatorId: string; provider: string; currency: string; total: string }[]
    >`
      SELECT d."operatorId", d."provider"::text AS provider, d."currency", SUM(d."amount")::text AS total
      FROM "Deposit" d
      WHERE d."status" = 'CONFIRMED' ${depFilter}
      GROUP BY d."operatorId", d."provider", d."currency"`;

    const clearing = await this.prisma.$queryRaw<
      { operatorId: string; provider: string | null; currency: string; total: string }[]
    >`
      SELECT t."operatorId", t."metadata"->>'provider' AS provider, t."currency", SUM(e."amount")::text AS total
      FROM "LedgerEntry" e
      JOIN "LedgerTransaction" t ON t."id" = e."transactionId"
      JOIN "LedgerAccount" a ON a."id" = e."accountId"
      WHERE t."type" = 'DEPOSIT' AND a."type" = 'PSP_CLEARING' ${clrFilter}
      GROUP BY t."operatorId", t."metadata"->>'provider', t."currency"`;

    const key = (o: string, p: string | null, c: string) => `${o}|${p ?? '?'}|${c}`;
    const map = new Map<string, { operatorId: string; provider: string; currency: string; deposits: bigint; clearing: bigint }>();
    for (const r of confirmed) {
      map.set(key(r.operatorId, r.provider, r.currency), {
        operatorId: r.operatorId,
        provider: r.provider,
        currency: r.currency,
        deposits: BigInt(r.total),
        clearing: 0n,
      });
    }
    for (const r of clearing) {
      const k = key(r.operatorId, r.provider, r.currency);
      const cur = map.get(k) ?? {
        operatorId: r.operatorId,
        provider: r.provider ?? '?',
        currency: r.currency,
        deposits: 0n,
        clearing: 0n,
      };
      cur.clearing += -BigInt(r.total); // PSP_CLEARING es contrapartida (negativa) del depósito
      map.set(k, cur);
    }

    const out: ReconciliationDiscrepancy[] = [];
    for (const v of map.values()) {
      if (v.deposits !== v.clearing) {
        out.push({
          ref: `${v.operatorId}:${v.provider}:${v.currency}`,
          detail: `Confirmed ${v.provider} deposits (${v.deposits}) != PSP_CLEARING deposit entries (${v.clearing}) in ${v.currency}`,
          expected: v.deposits.toString(),
          actual: v.clearing.toString(),
          operatorId: v.operatorId,
          currency: v.currency,
        });
      }
    }

    // Cada Deposit CONFIRMED debe apuntar a una LedgerTransaction DEPOSIT existente.
    const orphans = await this.prisma.$queryRaw<
      { id: string; operatorId: string; currency: string; amount: string; ledgerTransactionId: string | null }[]
    >`
      SELECT d."id", d."operatorId", d."currency", d."amount"::text AS amount, d."ledgerTransactionId"
      FROM "Deposit" d
      LEFT JOIN "LedgerTransaction" t ON t."id" = d."ledgerTransactionId" AND t."type" = 'DEPOSIT'
      WHERE d."status" = 'CONFIRMED' AND t."id" IS NULL ${depFilter}`;
    for (const r of orphans) {
      out.push({
        ref: r.id,
        detail: r.ledgerTransactionId
          ? `Deposit ${r.id} is CONFIRMED but its ledgerTransactionId ${r.ledgerTransactionId} is not a DEPOSIT transaction`
          : `Deposit ${r.id} is CONFIRMED but has no ledgerTransactionId`,
        expected: 'ledgerTransactionId',
        actual: r.ledgerTransactionId ?? 'null',
        operatorId: r.operatorId,
        currency: r.currency,
      });
    }
    return this.check('PSP_DEPOSITS_VS_CLEARING', out);
  }
}
