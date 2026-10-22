import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { emailSchema, normalizeEmail, passwordSchema } from '../src/domain/accounts/passwordPolicy';
import { isSupportedCurrency } from '../src/domain/money/currencies';

/**
 * Bootstrap de producción: deja una instalación nueva lista para operar SIN datos demo.
 * - Admin de plataforma (email y contraseña propios; nunca usuarios *.local ni contraseñas compartidas).
 * - Operador inicial con su marca por defecto y sus dominios.
 * Idempotente: re-ejecutarlo no cambia contraseñas (salvo resetPassword), monedas ni dominios de otro operador.
 */

const HOST = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*(:\d{2,5})?$/;
const zCurrency = z.string().trim().toUpperCase().refine(isSupportedCurrency, 'Moneda no soportada');

export const bootstrapSchema = z.object({
  adminEmail: emailSchema,
  adminPassword: passwordSchema,
  resetPassword: z.boolean().default(false),
  operator: z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'slug: minúsculas, números y guiones (2-40)'),
    name: z.string().trim().min(2).max(80),
    defaultCurrency: zCurrency,
    currencies: z.array(zCurrency).default([]),
    domains: z.array(z.string().trim().toLowerCase().regex(HOST, 'dominio inválido')).min(1, 'indica al menos un dominio'),
  }),
});
export type BootstrapInput = z.input<typeof bootstrapSchema>;

export interface BootstrapResult {
  admin: { email: string; created: boolean; passwordReset: boolean };
  operator: { id: string; slug: string; created: boolean };
  brandCreated: boolean;
  domains: Array<{ host: string; created: boolean; primary: boolean }>;
}

/** Marca inicial (el operador la cambia luego desde el backoffice). */
function defaultBrand(name: string) {
  return {
    displayName: name,
    logoUrl: '/brand/infinite-abyss-logo.svg',
    colors: { primary: '#f4b73f', secondary: '#3cc8f0', accent: '#ffd978', background: '#050d1c', surface: '#0b1a30', text: '#e8eef8' },
    fontFamily: 'Inter, system-ui, sans-serif',
    legal: { termsUrl: '/legal/terms', privacyUrl: '/legal/privacy', responsibleGamingText: 'Juega con responsabilidad. Solo mayores de 18 años.', licenseText: '', minAge: 18 },
  };
}

export async function runBootstrap(prisma: PrismaClient, raw: BootstrapInput, opts: { bcryptCost?: number } = {}): Promise<BootstrapResult> {
  const input = bootstrapSchema.parse(raw);
  const op = input.operator;
  const currencies = [...new Set([op.defaultCurrency, ...op.currencies])];
  const email = normalizeEmail(input.adminEmail);
  const hash = await bcrypt.hash(input.adminPassword, opts.bcryptCost ?? 12);

  return prisma.$transaction(async (tx) => {
    // Admin de plataforma: nunca se "asciende" una cuenta existente de otro rol.
    const existingAdmin = await tx.backofficeUser.findUnique({ where: { email } });
    if (existingAdmin && existingAdmin.role !== 'PLATFORM_ADMIN') {
      throw new Error(`${email} ya existe con rol ${existingAdmin.role}: usa otro email para el admin de plataforma`);
    }
    if (!existingAdmin) {
      await tx.backofficeUser.create({ data: { email, passwordHash: hash, role: 'PLATFORM_ADMIN', operatorId: null } });
    } else if (input.resetPassword) {
      await tx.backofficeUser.update({ where: { id: existingAdmin.id }, data: { passwordHash: hash, status: 'ACTIVE' } });
    }

    // Operador: se crea una vez; sus monedas no se cambian por aquí (afectan al ledger existente).
    let operator = await tx.operator.findUnique({ where: { slug: op.slug } });
    const operatorCreated = !operator;
    if (!operator) {
      operator = await tx.operator.create({ data: { slug: op.slug, name: op.name, defaultCurrency: op.defaultCurrency, currencies } });
    }

    const brand = await tx.operatorBrand.findUnique({ where: { operatorId: operator.id } });
    if (!brand) await tx.operatorBrand.create({ data: { operatorId: operator.id, ...defaultBrand(op.name) } });

    const hasPrimary = (await tx.operatorDomain.count({ where: { operatorId: operator.id, isPrimary: true } })) > 0;
    const domains: BootstrapResult['domains'] = [];
    for (const [i, host] of op.domains.entries()) {
      const current = await tx.operatorDomain.findUnique({ where: { host } });
      if (current && current.operatorId !== operator.id) throw new Error(`El dominio ${host} ya pertenece a otro operador`);
      const primary = current?.isPrimary ?? (!hasPrimary && i === 0);
      if (!current) await tx.operatorDomain.create({ data: { host, operatorId: operator.id, isPrimary: primary } });
      domains.push({ host, created: !current, primary });
    }

    return {
      admin: { email, created: !existingAdmin, passwordReset: Boolean(existingAdmin && input.resetPassword) },
      operator: { id: operator.id, slug: operator.slug, created: operatorCreated },
      brandCreated: !brand,
      domains,
    };
  });
}
