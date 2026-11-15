import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../../system/bootstrap.js';
import {
  readLastMigrateRecord,
  recordSuccessfulMigrate,
} from '../migrate-record.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'migrate ledger PostgreSQL types and ordering (#4926)',
  () => {
    let db: DatabaseInterface;
    beforeAll(async () => {
      db = await getDatabase({ type: 'postgres', url: pgUrl });
      await ensureSystemTables(db, 'postgres');
    });
    afterAll(async () => {
      await db.close?.();
    });

    it('uses TEXT payloads and timestamptz, preserves rollback and timestamp-tie ordering', async () => {
      const columns =
        await db.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = '_smrt_migrate_runs'`);
      expect(
        Object.fromEntries(
          columns.rows.map((row) => [row.column_name, row.data_type]),
        ),
      ).toEqual({
        id: 'text',
        release: 'text',
        packages: 'text',
        fingerprint: 'text',
        created_at: 'timestamp with time zone',
      });
      // Everything is rolled back, including writes by the public writer.
      if (!db.beginTransaction)
        throw new Error('PostgreSQL transaction support required');
      const previous = await readLastMigrateRecord(db, {
        engineHint: 'postgres',
      });
      const tx = await db.beginTransaction();
      try {
        await tx.query('DELETE FROM _smrt_migrate_runs');
        expect(
          await readLastMigrateRecord(tx, { engineHint: 'postgres' }),
        ).toEqual({ state: 'none' });
        const input = {
          release: 'fixture',
          packages: ['@fixture/app'],
          fingerprint: 'a'.repeat(64),
        };
        await recordSuccessfulMigrate(tx, { input, engineHint: 'postgres' });
        expect(
          (await recordSuccessfulMigrate(tx, { input, engineHint: 'postgres' }))
            .written,
        ).toBe(false);
        for (const id of ['a', 'z']) {
          await tx.query(
            `INSERT INTO _smrt_migrate_runs (id, release, packages, fingerprint, created_at)
          VALUES ($1, $1, '[]', $2, '2099-01-01T00:00:00Z')`,
            id,
            input.fingerprint,
          );
        }
        expect(
          await readLastMigrateRecord(tx, { engineHint: 'postgres' }),
        ).toEqual({
          state: 'recorded',
          record: {
            release: 'z',
            packages: [],
            fingerprint: input.fingerprint,
            createdAt: '2099-01-01T00:00:00.000Z',
          },
        });
      } finally {
        await tx.rollback();
      }
      expect(
        await readLastMigrateRecord(db, { engineHint: 'postgres' }),
      ).toEqual(previous);
    });
  },
);
