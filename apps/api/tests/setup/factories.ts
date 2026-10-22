import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { BackofficeRole, Operator, User, BackofficeUser } from '@prisma/client';
import { prisma } from '../../src/infrastructure/database/prisma';

export const TEST_PASSWORD = 'Test-Passw0rd!';

// Coste bajo: solo para tests.
const hash = (pw: string) => bcrypt.hash(pw, 4);

export interface TestOperator extends Operator {
  host: string;
}

/** Crea un operador aislado con slug aleatorio, dominio y marca. */
export async function createTestOperator(
  overrides: Partial<{
    currencies: string[];
    defaultCurrency: string;
    chipsEnabled: boolean;
    chipMinorUnitsPerChip: bigint | null;
    status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
    limits: Record<string, unknown>;
  }> = {},
): Promise<TestOperator> {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  const slug = `t-${id}`;
  const host = `${slug}.test.local`;
  const op = await prisma.operator.create({
    data: {
      slug,
      name: `Test Operator ${id}`,
      status: overrides.status ?? 'ACTIVE',
      defaultCurrency: overrides.defaultCurrency ?? 'USD',
      currencies: overrides.currencies ?? ['USD'],
      chipsEnabled: overrides.chipsEnabled ?? false,
      chipMinorUnitsPerChip: overrides.chipMinorUnitsPerChip ?? null,
      limits: (overrides.limits ?? {}) as object,
      domains: { create: [{ host, isPrimary: true }] },
      brand: {
        create: {
          displayName: `Test ${id}`,
          logoUrl: '/logo.svg',
          colors: {
            primary: '#7c3aed',
            secondary: '#1e1b4b',
            accent: '#22d3ee',
            background: '#0b0b14',
            surface: '#151526',
            text: '#f5f5ff',
          },
          fontFamily: 'Inter, sans-serif',
          legal: {
            termsUrl: '/terms',
            privacyUrl: '/privacy',
            responsibleGamingText: 'Juega con responsabilidad.',
            licenseText: 'Operador de pruebas',
            minAge: 18,
          },
        },
      },
    },
  });
  return { ...op, host };
}

export async function createTestPlayer(
  operatorId: string,
  overrides: Partial<{
    email: string;
    username: string | null;
    password: string;
    currency: string;
    isDemo: boolean;
    kycStatus: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
    status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  }> = {},
): Promise<User> {
  const email = (overrides.email ?? `p-${randomUUID().slice(0, 12)}@test.local`).trim();
  return prisma.user.create({
    data: {
      operatorId,
      email,
      emailNormalized: email.toLowerCase(),
      username: overrides.username ?? null,
      passwordHash: await hash(overrides.password ?? TEST_PASSWORD),
      currency: overrides.currency ?? 'USD',
      isDemo: overrides.isDemo ?? false,
      kycStatus: overrides.kycStatus ?? 'NONE',
      status: overrides.status ?? 'ACTIVE',
    },
  });
}

export async function createBackofficeUser(
  role: BackofficeRole,
  operatorId: string | null,
  overrides: Partial<{ email: string; password: string }> = {},
): Promise<BackofficeUser> {
  const email = (overrides.email ?? `bo-${randomUUID().slice(0, 12)}@test.local`).trim().toLowerCase();
  return prisma.backofficeUser.create({
    data: {
      email,
      passwordHash: await hash(overrides.password ?? TEST_PASSWORD),
      role,
      operatorId: role === 'PLATFORM_ADMIN' ? null : operatorId,
    },
  });
}
