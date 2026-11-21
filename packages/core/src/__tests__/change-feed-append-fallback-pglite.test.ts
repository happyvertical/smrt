/**
 * A direct change-feed append that fails on contention is staged, not
 * dropped (PostgreSQL, #5438).
 *
 * When the direct allocation fails with a lock timeout (`55P03`), a deadlock
 * (`40P01`) or a duplicate on the feed's own sequence key (`23505` naming
 * that constraint), the helper stages the entry in the same statement and
 * returns the staged marker, with the original SQLSTATE noted in
 * `error_message`; the next drain sequences it. A cancelled statement
 * (`57014`), a duplicate on any other constraint, and every other error are
 * returned as before and stage nothing. The batch helper returns one row per
 * entry, the same shape as its staged branch.
 *
 * PGlite is one session, so the failures are raised by a trigger on the feed
 * table; the contention itself runs in the PostgreSQL lane. Runs under
 * `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  appendChanges,
  bumpChangeFeed,
  drainChangeFeed,
  ensureChangeFeedTable,
  getChangesSince,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';
import { getTestDatabase } from '../testing/database';

const SUBJECT = 'append_fallback_pglite_notes';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function count(db: DatabaseInterface, table: string): Promise<number> {
  return Number(
    rowsOf(await db.query(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n,
  );
}

/** Make every direct insert into the feed fail with `code` (and `constraint`). */
async function failDirectInserts(
  db: DatabaseInterface,
  code: string,
  constraint?: string,
): Promise<void> {
  const using = constraint
    ? `ERRCODE = '${code}', CONSTRAINT = '${constraint}'`
    : `ERRCODE = '${code}'`;
  await db.query(`
    CREATE OR REPLACE FUNCTION append_fallback_fail() RETURNS trigger
    LANGUAGE plpgsql AS $fail$
    BEGIN
      RAISE EXCEPTION 'simulated direct-allocation failure' USING ${using};
    END;
    $fail$`);
  await db.query(
    'DROP TRIGGER IF EXISTS append_fallback_fail ON _smrt_changes',
  );
  await db.query(
    `CREATE TRIGGER append_fallback_fail BEFORE INSERT ON _smrt_changes
     FOR EACH ROW EXECUTE FUNCTION append_fallback_fail()`,
  );
}

async function restoreDirectInserts(db: DatabaseInterface): Promise<void> {
  await db.query(
    'DROP TRIGGER IF EXISTS append_fallback_fail ON _smrt_changes',
  );
}

async function feedPrimaryKey(db: DatabaseInterface): Promise<string> {
  return String(
    rowsOf(
      await db.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = to_regclass('_smrt_changes') AND contype = 'p'`,
      ),
    )[0]?.conname,
  );
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'change-feed append fallback on PGlite (#5438)',
  () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      resetChangeFeedWarnings();
      db = (await getTestDatabase({
        type: 'pglite',
        classes: [],
      })) as DatabaseInterface;
      await ensureChangeFeedTable(db);
    });

    afterEach(async () => {
      stopChangeFeedDrainers();
      await settleChangeFeedDrainers();
      await db.close?.();
    });

    for (const code of ['55P03', '40P01']) {
      it(`stages an append whose direct allocation fails with ${code}, and a drain delivers it`, async () => {
        await failDirectInserts(db, code);
        const rows = rowsOf(
          await db.query(
            `SELECT * FROM _smrt_append_change($1, 'r1', 'update', NULL, now())`,
            SUBJECT,
          ),
        );
        expect(rows).toEqual([
          expect.objectContaining({ allocated_seq: null, error_code: null }),
        ]);
        expect(String(rows[0]?.error_message)).toContain(code);
        expect(await appendChange(db, { table: SUBJECT, rowId: 'r2' })).toBe(
          null,
        );
        await expect(
          bumpChangeFeed(db, { table: SUBJECT, rowId: 'r3' }),
        ).resolves.toBeUndefined();
        expect(await count(db, '_smrt_changes_pending')).toBe(3);
        await restoreDirectInserts(db);
        stopChangeFeedDrainers();
        await settleChangeFeedDrainers();
        expect(await drainChangeFeed(db)).toBe(3);
        const page = await getChangesSince(db, { since: 0 });
        expect(page.changes.map((change) => change.rowId)).toEqual([
          'r1',
          'r2',
          'r3',
        ]);
      });
    }

    it('stages a duplicate on the feed sequence key, and returns one on any other constraint', async () => {
      await failDirectInserts(db, '23505', await feedPrimaryKey(db));
      expect(await appendChange(db, { table: SUBJECT, rowId: 'pk' })).toBe(
        null,
      );
      await failDirectInserts(db, '23505', 'some_other_unique_key');
      await expect(
        appendChange(db, { table: SUBJECT, rowId: 'other' }),
      ).rejects.toMatchObject({ code: '23505' });
      expect(await count(db, '_smrt_changes_pending')).toBe(1);
    });

    it('returns a cancelled statement as an error and stages nothing', async () => {
      await failDirectInserts(db, '57014');
      await expect(
        appendChange(db, { table: SUBJECT, rowId: 'cancelled' }),
      ).rejects.toMatchObject({ code: '57014' });
      await expect(
        appendChanges(db, [{ table: SUBJECT, rowId: 'cancelled-batch' }]),
      ).rejects.toMatchObject({ code: '57014' });
      expect(await count(db, '_smrt_changes_pending')).toBe(0);
    });

    it('returns a data error as before and stages nothing', async () => {
      await failDirectInserts(db, '22P02');
      await expect(
        appendChange(db, { table: SUBJECT, rowId: 'bad' }),
      ).rejects.toMatchObject({ code: '22P02' });
      expect(await count(db, '_smrt_changes_pending')).toBe(0);
    });

    it('stages a whole batch with one row per entry, like its staged branch', async () => {
      await failDirectInserts(db, '55P03');
      const rows = rowsOf(
        await db.query(
          'SELECT * FROM _smrt_append_changes($1::jsonb)',
          JSON.stringify([
            {
              table: SUBJECT,
              rowId: 'b0',
              operation: 'update',
              tenantId: null,
              timestamp: new Date().toISOString(),
            },
            {
              table: SUBJECT,
              rowId: 'b1',
              operation: 'create',
              tenantId: null,
              timestamp: new Date().toISOString(),
            },
          ]),
        ),
      );
      expect(rows.map((row) => row.entry_index)).toEqual([0, 1]);
      for (const row of rows) {
        expect(row).toMatchObject({ allocated_seq: null, error_code: null });
        expect(String(row.error_message)).toContain('55P03');
      }
      expect(
        await appendChanges(db, [
          { table: SUBJECT, rowId: 'b2' },
          { table: SUBJECT, rowId: 'b3' },
        ]),
      ).toEqual([null, null]);
      expect(await count(db, '_smrt_changes_pending')).toBe(4);
    });
  },
);
