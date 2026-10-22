import { defineConfig } from 'vitest/config';

// Config único (vitest 4). Debe ser .mts: el paquete es CommonJS y un .ts falla con ERR_REQUIRE_ESM.
// - tests/**: pruebas de la Fase 1 contra Postgres (globalSetup aplica `prisma migrate deploy` sobre TEST_DATABASE_URL).
// - src/modules/**: pruebas de los módulos. Las de RTP largo solo corren completas con RTP_LONG=1 (npm run test:long).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/modules/**/*.test.ts'],
    globalSetup: ['tests/setup/globalSetup.ts'],
    setupFiles: ['tests/setup/env.ts'],
    // Los tests comparten BD: cada test crea su propio operador y acota sus aserciones.
    // Las simulaciones de RTP de Studios necesitan más margen que los tests de la Fase 1.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: true,
  },
});
