import { execSync } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://nymfo_test:nymfo_test@localhost:5433/nymfo_test?schema=public';

/** Aplica las migraciones reales (migrate deploy) sobre la BD de pruebas, una vez por corrida. */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  process.env.DATABASE_URL = url;
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
