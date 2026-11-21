// The registered `test:postgres` suite (CI's "Registered PostgreSQL Suites"
// lane): the engine on a database server. Each file runs on an in-process
// PGlite (its twin) and, when SMRT_TEST_POSTGRES_URL is set, on the real
// server. They are excluded from `vitest.config.ts` and
// `vitest.pglite.config.ts` so the PGlite pass runs once, here, not three
// times. Run it with `pnpm test:postgres`.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export const POSTGRES_SUITES = [
  'src/engine/postgres-server.test.ts',
  'src/engine/postgres-drafts.test.ts',
  'src/engine/portable-export-postgres.test.ts',
  'src/engine/postgres-claim-connection.test.ts',
  'src/engine/store-in-swap.test.ts',
  'src/lib/server/storage-metering-postgres.test.ts',
];

const baseTest = (base as { test?: Record<string, unknown> }).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: POSTGRES_SUITES,
    exclude: ['**/node_modules/**'],
  },
});
