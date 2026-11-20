// The engine suite's PostgreSQL pass (#5186): the same tests, each app on its
// own in-process PGlite (schema `app`, scoped by a transaction-local
// search_path), reached by the app worker through a MessagePort bridge. Run it
// with `pnpm test:pglite`.
//
// Files excluded here need something only SQLite has. They keep running on
// SQLite (the default config); `src/engine/postgres-engine.test.ts` is the
// PostgreSQL counterpart for the engine paths they cover. Single tests that
// need it skip themselves with `it.skipIf(onPglite)` (pglite-env.ts). Bringing
// the excluded files across needs a dual-database SQL helper for their raw
// assertions, and drafts and publish on PostgreSQL (#5187).
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const SQLITE_ONLY = [
  // draft copies and publish (VACUUM INTO, file swap): #5187
  'draft.test.ts',
  'publish.test.ts',
  'change-engine.test.ts',
  'import-target.test.ts',
  'report-bucket-import.test.ts',
  // read or arrange app.db with node:sqlite (SQLite triggers, pragma, SELECT *)
  'bounded-load-journal.test.ts',
  'calculations.test.ts',
  'extract-model.test.ts',
  'journal-limits.test.ts',
  'load-records.test.ts',
  'merge-records.test.ts',
  'migrations.test.ts',
  'portable-export.test.ts',
  'round3-data.test.ts',
  'safety-round4.test.ts',
  // a story whose steps depend on each other: methods snapshot to a file, and
  // the profiles step reads app.db
  'walkthrough.test.ts',
];

const baseTest = (base as { test?: { exclude?: string[] } }).test ?? {};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    env: { SMRT_APP_SHELL_DB: 'pglite' },
    include: ['src/engine/**/*.test.ts'],
    exclude: [
      ...(baseTest.exclude ?? []),
      ...SQLITE_ONLY.map((f) => `src/engine/${f}`),
    ],
  },
});
