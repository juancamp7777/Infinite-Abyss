/**
 * Bootstrap de una instalación (también en producción): admin de plataforma + operador inicial + dominios.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=ops@tuempresa.com BOOTSTRAP_ADMIN_PASSWORD='…' \
 *   BOOTSTRAP_OPERATOR_SLUG=abyss BOOTSTRAP_OPERATOR_NAME='Infinite Abyss' \
 *   BOOTSTRAP_OPERATOR_CURRENCY=COP BOOTSTRAP_OPERATOR_CURRENCIES=COP,USD \
 *   BOOTSTRAP_DOMAINS=casino.ejemplo.com,admin.ejemplo.com npm run bootstrap
 *
 * Idempotente. BOOTSTRAP_RESET_PASSWORD=1 cambia la contraseña de un admin existente. Nunca imprime secretos.
 */
import { PrismaClient } from '@prisma/client';
import { runBootstrap } from '../prisma/bootstrapLib';

try {
  process.loadEnvFile();
} catch {
  /* sin .env: variables del entorno */
}

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const r = await runBootstrap(prisma, {
      adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL ?? '',
      adminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
      resetPassword: process.env.BOOTSTRAP_RESET_PASSWORD === '1',
      operator: {
        slug: process.env.BOOTSTRAP_OPERATOR_SLUG ?? '',
        name: process.env.BOOTSTRAP_OPERATOR_NAME ?? '',
        defaultCurrency: process.env.BOOTSTRAP_OPERATOR_CURRENCY ?? '',
        currencies: list(process.env.BOOTSTRAP_OPERATOR_CURRENCIES),
        domains: list(process.env.BOOTSTRAP_DOMAINS),
      },
    });
    console.log(`Admin de plataforma ${r.admin.email}: ${r.admin.created ? 'creado' : r.admin.passwordReset ? 'contraseña actualizada' : 'ya existía (sin cambios)'}`);
    console.log(`Operador ${r.operator.slug} (${r.operator.id}): ${r.operator.created ? 'creado' : 'ya existía'}${r.brandCreated ? ' · marca inicial creada' : ''}`);
    for (const d of r.domains) console.log(`Dominio ${d.host}: ${d.created ? 'asignado' : 'ya asignado'}${d.primary ? ' (principal)' : ''}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`Bootstrap falló: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
