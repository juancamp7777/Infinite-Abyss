import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/infrastructure/database/prisma';
import { PrismaWalletService } from '../../src/infrastructure/ledger/PrismaWalletService';
import { ReconciliationService } from '../../src/application/reconciliation/ReconciliationService';
import { createTestOperator, createTestPlayer } from '../setup/factories';

export const wallet = new PrismaWalletService(prisma);
export const reconciliation = new ReconciliationService(prisma);

export async function setup(currency = 'USD') {
  const operator = await createTestOperator({ currencies: [currency], defaultCurrency: currency });
  const player = await createTestPlayer(operator.id, { currency });
  return { operator, player, currency };
}

/** Crea el Deposit (PENDING) y lo acredita vía el servicio, como haría el webhook. */
export async function fund(operatorId: string, userId: string, amount: bigint, currency = 'USD') {
  const dep = await prisma.deposit.create({
    data: {
      operatorId,
      userId,
      provider: 'WOMPI',
      status: 'PENDING',
      amount,
      currency,
      providerReference: `ref-${randomUUID()}`,
    },
  });
  const res = await wallet.creditDeposit({
    operatorId,
    userId,
    currency,
    amount,
    depositId: dep.id,
    provider: 'WOMPI',
    idempotencyKey: `deposit:${dep.id}`,
  });
  return { deposit: dep, result: res };
}

/** Todas las transacciones del operador deben sumar exactamente 0. */
export async function nonZeroTransactions(operatorId: string) {
  return prisma.$queryRaw<{ id: string; total: string }[]>`
    SELECT t."id", COALESCE(SUM(e."amount"),0)::text AS total
    FROM "LedgerTransaction" t LEFT JOIN "LedgerEntry" e ON e."transactionId" = t."id"
    WHERE t."operatorId" = ${operatorId}::uuid
    GROUP BY t."id" HAVING COALESCE(SUM(e."amount"),0) <> 0`;
}

export async function derivedCash(operatorId: string, userId: string) {
  const rows = await prisma.$queryRaw<{ s: string | null }[]>`
    SELECT SUM(e."amount")::text AS s FROM "LedgerEntry" e JOIN "LedgerAccount" a ON a."id" = e."accountId"
    WHERE a."operatorId" = ${operatorId}::uuid AND a."ownerKey" = ${userId} AND a."type" = 'PLAYER_CASH'`;
  return BigInt(rows[0]?.s ?? '0');
}
