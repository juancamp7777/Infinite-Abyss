import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { loadConfig } from '../../src/config/env';
import { createTestOperator, createTestPlayer } from './factories';

afterAll(() => prisma.$disconnect());

describe('smoke: BD y migraciones', () => {
  it('conecta y la migración init está aplicada', async () => {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    expect(rows.some((r) => r.migration_name.endsWith('_init'))).toBe(true);
  });

  it('el trigger rechaza UPDATE y DELETE sobre el ledger, pero permite INSERT', async () => {
    const op = await createTestOperator();
    const user = await createTestPlayer(op.id);
    const acc = await prisma.ledgerAccount.create({
      data: { operatorId: op.id, ownerType: 'PLAYER', userId: user.id, ownerKey: user.id, type: 'PLAYER_CASH', currency: 'USD' },
    });
    const house = await prisma.ledgerAccount.create({
      data: { operatorId: op.id, ownerType: 'OPERATOR', ownerKey: 'OPERATOR', type: 'HOUSE', currency: 'USD' },
    });
    const tx = await prisma.ledgerTransaction.create({
      data: {
        operatorId: op.id,
        type: 'MANUAL_ADJUSTMENT',
        idempotencyKey: 'smoke-1',
        currency: 'USD',
        entries: {
          create: [
            { accountId: acc.id, operatorId: op.id, amount: 100n, currency: 'USD' },
            { accountId: house.id, operatorId: op.id, amount: -100n, currency: 'USD' },
          ],
        },
      },
      include: { entries: true },
    });
    expect(tx.entries.reduce((s, e) => s + e.amount, 0n)).toBe(0n);

    await expect(
      prisma.ledgerEntry.update({ where: { id: tx.entries[0].id }, data: { amount: 999n } }),
    ).rejects.toThrow(/immutable/);
    await expect(prisma.ledgerEntry.delete({ where: { id: tx.entries[0].id } })).rejects.toThrow(/immutable/);
    await expect(
      prisma.ledgerTransaction.update({ where: { id: tx.id }, data: { currency: 'EUR' } }),
    ).rejects.toThrow(/immutable/);
  });
});

describe('config', () => {
  it('falla sin JWT_ACCESS_SECRET y no deja valores por defecto de credenciales', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://x' } as NodeJS.ProcessEnv)).toThrow(/JWT_ACCESS_SECRET/);
    const c = loadConfig({ DATABASE_URL: 'postgresql://x', JWT_ACCESS_SECRET: 'x'.repeat(32) } as NodeJS.ProcessEnv);
    expect(c.passimpay.apiKey).toBeUndefined();
    expect(c.wompi.eventsSecret).toBeUndefined();
    expect(c.jwt.accessTtl).toBe('15m');
  });
});
