/**
 * The protected-field write rule (#5195) on PostgreSQL: `numeric` and `int8`
 * hydrate from strings, `jsonb` reorders keys, `timestamptz` and `boolean`
 * are native. Runs in core's PostgreSQL lane (`pnpm test:postgres`), which
 * supplies `SMRT_TEST_POSTGRES_URL`; skipped without it.
 */

import { getDatabase } from '@happyvertical/sql';
import { describe, it } from 'vitest';
import { getTestDatabase } from '../testing/database.js';
import {
  describeProtectedFieldWrites,
  PROTECTED_WRITE_CLASSES,
} from './fixtures/protected-field-writes.js';

const postgresUrl = process.env.SMRT_TEST_POSTGRES_URL;

if (postgresUrl) {
  describeProtectedFieldWrites(
    'PostgreSQL',
    async () => {
      const db = await getTestDatabase({
        db: await getDatabase({
          type: 'postgres',
          url: postgresUrl,
          dbid: crypto.randomUUID(),
        }),
        classes: PROTECTED_WRITE_CLASSES,
      });
      return { db, dbUrl: postgresUrl };
    },
    async (db) => {
      await db.query(
        'DROP TABLE IF EXISTS protected_write_records, protected_write_listeds',
      );
      await db.close?.();
    },
  );
} else {
  describe('protected field writes (PostgreSQL)', () => {
    it.skip('needs SMRT_TEST_POSTGRES_URL (core PostgreSQL lane)', () => {});
  });
}
