import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { fund, reconciliation, setup, wallet } from '../ledger/helpers';

const failed = (report: Awaited<ReturnType<typeof reconciliation.run>>) =>
  report.checks.filter((c) => !c.passed).map((c) => c.name);

describe('ReconciliationService', () => {
  it('operador sano: 0 discrepancias y 4 checks', async () => {
    const { operator, player, currency } = await setup();
    await fund(operator.id, player.id, 2_000n);
    await wallet.betAndSettle({ operatorId: operator.id, userId: player.id, currency, betAmount: 100n, winAmount: 50n, gameType: 'SLOTS', idempotencyKey: 'bet:1' });
    const r = await reconciliation.run({ operatorId: operator.id });
    expect(r.scope).toBe(operator.id);
    expect(r.checks.map((c) => c.name)).toEqual(['TX_SUM_ZERO', 'GLOBAL_SUM_ZERO', 'CACHED_VS_DERIVED', 'PSP_DEPOSITS_VS_CLEARING']);
    expect(r.totalDiscrepancies).toBe(0);
  });

  it('(1) una LedgerEntry extra en una transacción existente rompe TX_SUM_ZERO y GLOBAL_SUM_ZERO', async () => {
    const { operator, player } = await setup();
    const { result } = await fund(operator.id, player.id, 1_000n);
    const accountId = (await prisma.ledgerAccount.findFirstOrThrow({ where: { operatorId: operator.id, type: 'PSP_CLEARING' } })).id;
    await prisma.$executeRaw`
      INSERT INTO "LedgerEntry" ("id","transactionId","accountId","operatorId","amount","currency")
      VALUES (${randomUUID()}::uuid, ${result.ledgerTransactionId}::uuid, ${accountId}::uuid, ${operator.id}::uuid, 7, 'USD')`;
    const r = await reconciliation.run({ operatorId: operator.id });
    const names = failed(r);
    expect(names).toContain('TX_SUM_ZERO');
    expect(names).toContain('GLOBAL_SUM_ZERO');
    const tx = r.checks.find((c) => c.name === 'TX_SUM_ZERO')!;
    expect(tx.discrepancies[0]).toMatchObject({ ref: result.ledgerTransactionId, actual: '7', expected: '0' });
  });

  it('(2) alterar el balance cacheado rompe CACHED_VS_DERIVED', async () => {
    const { operator, player } = await setup();
    await fund(operator.id, player.id, 1_000n);
    const cash = await prisma.ledgerAccount.findFirstOrThrow({ where: { operatorId: operator.id, ownerKey: player.id, type: 'PLAYER_CASH' } });
    await prisma.$executeRaw`UPDATE "LedgerAccount" SET "balance" = "balance" + 999 WHERE "id" = ${cash.id}::uuid`;
    const r = await reconciliation.run({ operatorId: operator.id });
    expect(failed(r)).toEqual(['CACHED_VS_DERIVED']);
    expect(r.checks[2].discrepancies[0]).toMatchObject({ ref: cash.id, expected: '1000', actual: '1999' });
  });

  it('(3) un Deposit CONFIRMED sin asiento rompe PSP_DEPOSITS_VS_CLEARING', async () => {
    const { operator, player } = await setup();
    await fund(operator.id, player.id, 1_000n);
    const ghost = await prisma.deposit.create({
      data: {
        operatorId: operator.id, userId: player.id, provider: 'PASSIMPAY', status: 'CONFIRMED',
        amount: 5_000n, currency: 'USD', providerReference: `ghost-${randomUUID()}`,
      },
    });
    const r = await reconciliation.run({ operatorId: operator.id });
    expect(failed(r)).toEqual(['PSP_DEPOSITS_VS_CLEARING']);
    const refs = r.checks[3].discrepancies.map((d) => d.ref);
    expect(refs).toContain(ghost.id);
    expect(r.checks[3].discrepancies.some((d) => d.expected === '5000' && d.actual === '0')).toBe(true);
  });

  it('con filtro no mezcla operadores: el descuadre de A no aparece en B', async () => {
    const a = await setup();
    const b = await setup();
    await fund(a.operator.id, a.player.id, 1_000n);
    await fund(b.operator.id, b.player.id, 1_000n);
    const cash = await prisma.ledgerAccount.findFirstOrThrow({ where: { operatorId: a.operator.id, type: 'PLAYER_CASH' } });
    await prisma.$executeRaw`UPDATE "LedgerAccount" SET "balance" = 1 WHERE "id" = ${cash.id}::uuid`;
    expect((await reconciliation.run({ operatorId: a.operator.id })).totalDiscrepancies).toBe(1);
    expect((await reconciliation.run({ operatorId: b.operator.id })).totalDiscrepancies).toBe(0);
    const all = await reconciliation.run();
    expect(all.scope).toBe('ALL');
    expect(all.checks[2].discrepancies.map((d) => d.ref)).toContain(cash.id);
  });
});
