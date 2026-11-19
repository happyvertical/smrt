/**
 * A write that names a field the caller may not write is refused only when
 * its value differs from what is stored (#5195), on every write path that
 * shares the rule. The suite lives in `fixtures/protected-field-writes.ts`.
 *
 * `pnpm test` runs it on a real SQLite file. `pnpm test:pglite` (part of
 * core's PostgreSQL lane) runs it on PGlite, a PostgreSQL engine: `numeric`
 * and `int8` hydrate from strings, `jsonb` reorders keys, `timestamptz` and
 * `boolean` are native. `protected-field-writes-postgres.optional.test.ts`
 * runs it on a PostgreSQL server when `SMRT_TEST_POSTGRES_URL` is set.
 * Nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '../testing/database.js';
import {
  describeProtectedFieldWrites,
  PROTECTED_WRITE_CLASSES,
} from './fixtures/protected-field-writes.js';

const pglite = process.env.SMRT_TEST_PGLITE === '1';
let dir = '';

describeProtectedFieldWrites(
  pglite ? 'PGlite' : 'SQLite',
  async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-protected-fields-'));
    const dbUrl = join(dir, 'app.db');
    const db = await getTestDatabase(
      pglite
        ? { type: 'pglite', classes: PROTECTED_WRITE_CLASSES }
        : { type: 'sqlite', url: dbUrl, classes: PROTECTED_WRITE_CLASSES },
    );
    return { db, dbUrl };
  },
  async (db) => {
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  },
);
