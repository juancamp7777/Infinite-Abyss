import { prisma } from '../src/infrastructure/database/prisma';
import { ReconciliationService } from '../src/application/reconciliation/ReconciliationService';

/**
 * Uso: npm run reconcile [-- --operator=<operatorId>]
 * Imprime el informe en JSON y sale con código 1 si hay discrepancias.
 */
async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--operator='));
  const operatorId = arg ? arg.slice('--operator='.length) : undefined;
  const report = await new ReconciliationService(prisma).run({ operatorId });
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(report.totalDiscrepancies > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(2);
});
