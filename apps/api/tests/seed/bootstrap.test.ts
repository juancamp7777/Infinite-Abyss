import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/infrastructure/database/prisma';
import { runBootstrap } from '../../prisma/bootstrapLib';
import { createBackofficeUser } from '../setup/factories';

// Bootstrap de producción: sin datos demo, idempotente y sin pisar otros operadores.
const input = (u: string, over: Record<string, unknown> = {}) => ({
  adminEmail: `ops-${u}@empresa.test`,
  adminPassword: 'Prueba-Segura-123',
  operator: { slug: `op-${u}`, name: 'Casino Uno', defaultCurrency: 'cop', currencies: ['USD'], domains: [`casino-${u}.test`, `admin-${u}.test`] },
  ...over,
});

describe('bootstrap de producción', () => {
  it('crea admin, operador, marca y dominios; re-ejecutar no cambia nada', async () => {
    const u = randomUUID().slice(0, 8);
    const r1 = await runBootstrap(prisma, input(u), { bcryptCost: 4 });
    expect(r1).toMatchObject({ admin: { created: true }, operator: { created: true }, brandCreated: true });
    expect(r1.domains).toEqual([{ host: `casino-${u}.test`, created: true, primary: true }, { host: `admin-${u}.test`, created: true, primary: false }]);
    const op = await prisma.operator.findUniqueOrThrow({ where: { slug: `op-${u}` } });
    expect(op).toMatchObject({ defaultCurrency: 'COP', currencies: ['COP', 'USD'] });
    expect(await prisma.user.count({ where: { operatorId: op.id } })).toBe(0);
    const hash1 = (await prisma.backofficeUser.findUniqueOrThrow({ where: { email: `ops-${u}@empresa.test` } })).passwordHash;
    const r2 = await runBootstrap(prisma, input(u, { adminPassword: 'Otra-Clave-456789' }), { bcryptCost: 4 });
    expect(r2).toMatchObject({ admin: { created: false, passwordReset: false }, operator: { created: false }, brandCreated: false });
    expect((await prisma.backofficeUser.findUniqueOrThrow({ where: { email: `ops-${u}@empresa.test` } })).passwordHash).toBe(hash1);
    const r3 = await runBootstrap(prisma, input(u, { adminPassword: 'Otra-Clave-456789', resetPassword: true }), { bcryptCost: 4 });
    expect(r3.admin.passwordReset).toBe(true);
  });

  it('rechaza dominios de otro operador, cuentas de otro rol y datos inválidos', async () => {
    const a = randomUUID().slice(0, 8);
    const b = randomUUID().slice(0, 8);
    await runBootstrap(prisma, input(a), { bcryptCost: 4 });
    await expect(runBootstrap(prisma, input(b, { operator: { ...input(b).operator, domains: [`casino-${a}.test`] } }), { bcryptCost: 4 })).rejects.toThrow(/otro operador/);
    expect(await prisma.operator.findUnique({ where: { slug: `op-${b}` } })).toBeNull(); // transacción revertida
    const staff = await createBackofficeUser('OPERATOR_ADMIN', (await prisma.operator.findUniqueOrThrow({ where: { slug: `op-${a}` } })).id);
    await expect(runBootstrap(prisma, input(b, { adminEmail: staff.email }), { bcryptCost: 4 })).rejects.toThrow(/rol OPERATOR_ADMIN/);
    for (const bad of [{ adminPassword: 'corta' }, { adminEmail: 'no-email' }, { operator: { ...input(b).operator, slug: 'Mal Slug' } }, { operator: { ...input(b).operator, defaultCurrency: 'XYZ' } }, { operator: { ...input(b).operator, domains: [] } }, { operator: { ...input(b).operator, domains: ['http://x.com'] } }]) {
      await expect(runBootstrap(prisma, input(b, bad), { bcryptCost: 4 })).rejects.toThrow();
    }
  });
});
