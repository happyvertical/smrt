/**
 * The PostgreSQL change-feed drain never sequences credential-bearing tables
 * (#2982).
 *
 * `_smrt_drain_changes()` used to move every staged row in
 * `_smrt_changes_pending` into `_smrt_changes`. The writer already refuses
 * sensitive tables, so such rows only exist when an older replica staged them
 * during a mixed-version rollout, or when they were staged before an upgrade —
 * and the drain then gave them sequences, putting credential-table row ids
 * into `_smrt_changes` until the next retention sweep.
 *
 * Runs only in the disposable PostgreSQL shard, against the real helpers in an
 * isolated schema. Legacy pending rows are written directly, the way an older
 * replica's staging append would have left them.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  drainChangeFeed,
  ensureChangeFeedTable,
  ensurePostgresChangeFeedHelpers,
  getChangesSince,
} from '../change-feed';
import { declareChangeFeedSensitiveTable } from '../change-feed-sensitivity';
import { POSTGRES_CHANGE_FEED_HELPER_MARKER } from '../system/schema';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const SCHEMA = 'issue_2982_drain';
const DECLARED_SENSITIVE = 'issue_2982_declared_secrets';
const PUBLIC_TABLE = 'issue_2982_public';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function connect(label: string): Promise<DatabaseInterface> {
  const separator = (pgUrl as string).includes('?') ? '&' : '?';
  return (await getDatabase({
    type: 'postgres',
    url: `${pgUrl}${separator}options=-c%20search_path%3D${SCHEMA}`,
    dbid: `smrt-test-2982-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

/** Stage a row exactly as an older replica's deferred append would. */
async function stage(db: DatabaseInterface, table: string): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, tenant_id, created_at)
     VALUES ($1, $2, 'update', NULL, now())`,
    table,
    randomUUID(),
  );
}

async function tablesIn(
  db: DatabaseInterface,
  relation: '_smrt_changes' | '_smrt_changes_pending',
): Promise<string[]> {
  return rowsOf(
    await db.query(
      `SELECT table_name FROM ${relation} ORDER BY ${
        relation === '_smrt_changes' ? 'seq' : 'pending_id'
      }`,
    ),
  ).map((row) => String(row.table_name));
}

describe.skipIf(!pgUrl)(
  'PostgreSQL drain excludes sensitive tables (#2982)',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      declareChangeFeedSensitiveTable(DECLARED_SENSITIVE);
      const admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2982-admin-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);
      db = await connect('setup');
      await ensureChangeFeedTable(db);
    }, 120_000);

    afterAll(async () => {
      await db?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    });

    beforeEach(async () => {
      await db.query('DELETE FROM _smrt_changes');
      await db.query('DELETE FROM _smrt_changes_pending');
    });

    it('purges staged credential-table rows and sequences only the rest', async () => {
      await stage(db, PUBLIC_TABLE);
      await stage(db, 'sessions');
      await stage(db, DECLARED_SENSITIVE);
      await stage(db, PUBLIC_TABLE);
      await stage(db, 'api_keys');

      expect(await drainChangeFeed(db)).toBe(2);

      expect(await tablesIn(db, '_smrt_changes')).toEqual([
        PUBLIC_TABLE,
        PUBLIC_TABLE,
      ]);
      // The sensitive rows were deleted from staging, not left for later.
      expect(await tablesIn(db, '_smrt_changes_pending')).toEqual([]);
      // Sequences stay contiguous: nothing was allocated for a dropped row.
      const seqs = rowsOf(
        await db.query('SELECT seq FROM _smrt_changes ORDER BY seq'),
      ).map((row) => Number(row.seq));
      expect(seqs).toEqual([1, 2]);
      const { changes } = await getChangesSince(db, { since: 0, limit: 100 });
      expect(changes.map((change) => change.table)).toEqual([
        PUBLIC_TABLE,
        PUBLIC_TABLE,
      ]);
    });

    it('drops a backlog made only of sensitive rows without allocating anything', async () => {
      for (let i = 0; i < 5; i++) await stage(db, 'sessions');
      expect(await drainChangeFeed(db)).toBe(0);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([]);
      expect(await tablesIn(db, '_smrt_changes_pending')).toEqual([]);
    });

    it('keeps the single-argument drain an older replica calls working', async () => {
      await stage(db, PUBLIC_TABLE);
      const rows = rowsOf(
        await db.query('SELECT * FROM _smrt_drain_changes()'),
      );
      expect(rows.filter((row) => row.error_code != null)).toEqual([]);
      expect(rows.map((row) => row.drained_table)).toEqual([PUBLIC_TABLE]);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([PUBLIC_TABLE]);
    });

    it('converts a pre-#2982 full single-argument body into the delegating compat drain', async () => {
      // An older SMRT's own (integer) drain: same signature and result, its own
      // body. The upgrade must CREATE OR REPLACE over it without changing the
      // identity older replicas call.
      await db.query(
        'DROP FUNCTION IF EXISTS _smrt_drain_changes(integer, text[])',
      );
      await db.query(`
      CREATE OR REPLACE FUNCTION _smrt_drain_changes(p_limit INTEGER DEFAULT 1000)
      RETURNS TABLE(
        drained_seq BIGINT, drained_table TEXT, drained_row_id TEXT,
        drained_operation TEXT, drained_tenant_id TEXT,
        error_code TEXT, error_message TEXT
      )
      LANGUAGE plpgsql SECURITY INVOKER
      AS $pre_2982$
      -- ${POSTGRES_CHANGE_FEED_HELPER_MARKER}
      BEGIN
        RETURN;
      END;
      $pre_2982$;
    `);

      await ensurePostgresChangeFeedHelpers(db);

      const compat = rowsOf(
        await db.query(
          `SELECT p.prosrc FROM pg_proc AS p
          WHERE p.oid = to_regprocedure('_smrt_drain_changes(integer)')`,
        ),
      );
      expect(String(compat[0]?.prosrc)).toContain('ARRAY[]::TEXT[]');
      await stage(db, PUBLIC_TABLE);
      const rows = rowsOf(
        await db.query('SELECT * FROM _smrt_drain_changes()'),
      );
      expect(rows.map((row) => row.drained_table)).toEqual([PUBLIC_TABLE]);
    });

    it("gives a newly created drain the compat drain's reconciled EXECUTE grants", async () => {
      // A permissions-managed database revokes PUBLIC EXECUTE on the framework
      // routines. The new identity must not arrive with the default ACL.
      await db.query(
        'DROP FUNCTION IF EXISTS _smrt_drain_changes(integer, text[])',
      );
      await db.query(
        'REVOKE ALL ON FUNCTION _smrt_drain_changes(integer) FROM PUBLIC',
      );

      await ensurePostgresChangeFeedHelpers(db);

      const acl = rowsOf(
        await db.query(
          `SELECT acl.grantee, acl.privilege_type
           FROM pg_proc AS p, aclexplode(p.proacl) AS acl
          WHERE p.oid = to_regprocedure('_smrt_drain_changes(integer,text[])')`,
        ),
      );
      expect(acl.length).toBeGreaterThan(0);
      expect(acl.some((entry) => Number(entry.grantee) === 0)).toBe(false);
      expect(
        rowsOf(
          await db.query(
            `SELECT has_function_privilege(current_user, '_smrt_drain_changes(integer,text[])', 'EXECUTE') AS can`,
          ),
        )[0]?.can,
      ).toBe(true);
      await db.query(
        'GRANT EXECUTE ON FUNCTION _smrt_drain_changes(integer) TO PUBLIC',
      );
    });

    it('purges a sensitive backlog larger than one batch across passes without stalling', async () => {
      await db.query(
        `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, tenant_id, created_at)
       SELECT 'sessions', gen_random_uuid()::text, 'update', NULL, now()
       FROM generate_series(1, 2500)`,
      );
      await stage(db, PUBLIC_TABLE);
      // The public entry behind the backlog is sequenced at once: each pass
      // purges one bounded batch and the sequencing batch skips the rest.
      expect(await drainChangeFeed(db)).toBe(1);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([PUBLIC_TABLE]);
      // Later drains purge the remainder, a batch per pass.
      for (let i = 0; i < 3; i++) await drainChangeFeed(db);
      expect(await tablesIn(db, '_smrt_changes_pending')).toEqual([]);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([PUBLIC_TABLE]);
    });

    it('installs the current drain on a database that only has the pre-#2982 helper', async () => {
      // A database last bootstrapped by an older SMRT has the single-argument
      // drain only. The current runtime must not call a function that is not
      // there; the bootstrap path installs it first.
      await db.query(
        'DROP FUNCTION IF EXISTS _smrt_drain_changes(integer, text[])',
      );
      expect(
        rowsOf(
          await db.query(
            `SELECT to_regprocedure('_smrt_drain_changes(integer,text[])') AS current`,
          ),
        )[0]?.current,
      ).toBeNull();

      await ensurePostgresChangeFeedHelpers(db);

      const installed = rowsOf(
        await db.query(
          `SELECT p.prosrc LIKE $1 AS current
           FROM pg_proc AS p
          WHERE p.oid = to_regprocedure('_smrt_drain_changes(integer,text[])')`,
          `%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%`,
        ),
      );
      expect(installed[0]?.current).toBe(true);

      await stage(db, 'sessions');
      await stage(db, PUBLIC_TABLE);
      // The public entry behind the backlog is sequenced at once: each pass
      // purges one bounded batch and the sequencing batch skips the rest.
      expect(await drainChangeFeed(db)).toBe(1);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([PUBLIC_TABLE]);
      // Later drains purge the remainder, a batch per pass.
      for (let i = 0; i < 3; i++) await drainChangeFeed(db);
      expect(await tablesIn(db, '_smrt_changes_pending')).toEqual([]);
      expect(await tablesIn(db, '_smrt_changes')).toEqual([PUBLIC_TABLE]);
    });
  },
);
