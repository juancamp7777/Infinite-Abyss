/**
 * Seed SOLO PARA DESARROLLO (CLI). Idempotente (upsert). Se niega a correr en producción.
 * La lógica vive en prisma/seedLib.ts (runSeed), que también usan las pruebas.
 *
 * Variables:
 * - SEED_ADMIN_PASSWORD: contraseña de todos los usuarios demo; si falta se genera una aleatoria y se muestra una sola vez.
 * - SEED_DEMO_CHIPS=true: acredita fichas demo vía el ledger (asiento DEMO_CREDIT).
 * - SEED_EXTRA_DOMAINS: dominios extra para la vista previa, separados por comas: `host` (operador nymfo) o `slug=host`.
 */
import { PrismaClient } from '@prisma/client';
import { runSeed } from './seedLib';

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Seed rechazado: NODE_ENV=production. El seed es solo para desarrollo.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const r = await runSeed(prisma, {
      password: process.env.SEED_ADMIN_PASSWORD,
      demoChips: process.env.SEED_DEMO_CHIPS === 'true',
      extraDomains: process.env.SEED_EXTRA_DOMAINS,
      log: (m) => console.log(m),
    });

    for (const d of r.extraDomains) console.log(`✔ Dominio extra ${d.host} → ${d.slug}`);
    console.log('\nUsuarios de backoffice:');
    console.log(`  PLATFORM_ADMIN (vista de plataforma): ${r.credentials.platformAdmin}`);
    console.log(`  OPERATOR_ADMIN: ${r.credentials.operatorAdmins.join(', ')}`);
    console.log(`  OPERATOR_FINANCE: ${r.credentials.finance.join(', ')}`);
    console.log(`Jugadores demo: ${r.credentials.players.join(', ')} (isDemo, saldo 0 salvo SEED_DEMO_CHIPS=true)`);
    if (r.generatedPassword) {
      console.log(`\nContraseña generada (se muestra UNA sola vez): ${r.password}\n`);
    } else {
      console.log('Contraseña: la de SEED_ADMIN_PASSWORD.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed falló:', err);
  process.exit(1);
});
