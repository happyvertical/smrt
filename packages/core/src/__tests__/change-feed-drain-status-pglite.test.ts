/**
 * The status drain and the v7 helper install, on PGlite (#5402).
 *
 * The drain body moved into `_smrt_drain_changes(integer, text[], jsonb)`,
 * which ends its result with one status row; the two older identities
 * delegate to it and keep their seven columns. Everything a pass locks sits
 * in one block that a pass finding no work rolls back, so no lock it took
 * outlives the call, even as the first statement of a caller transaction.
 *
 * PGlite is one session, so contention cases run in the PostgreSQL lane
 * (`change-feed-drain-liveness-postgres.optional.test.ts`); here the bodies,
 * statuses, grants and the helper probe states are checked on a real
 * PostgreSQL engine. Runs under `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainChangeFeed,
  ensureChangeFeedTable,
  ensurePostgresChangeFeedAppendFunction,
  ensurePostgresChangeFeedHelpers,
  probeChangeFeedHelperState,
  resetChangeFeedWarnings,
} from '../change-feed';
import { getTestDatabase } from '../testing/database';

const SUBJECT = 'drain_status_pglite_notes';
const SECRET = 'sessions';
const STATUS_DRAIN = '_smrt_drain_changes(integer,text[],jsonb)';
const IDENTITIES = [
  '_smrt_append_change(text,text,text,text,timestamp with time zone)',
  '_smrt_append_changes(jsonb)',
  '_smrt_drain_changes(integer,text[])',
  '_smrt_drain_changes(integer)',
  STATUS_DRAIN,
];
const MARKERS = [
  'smrt-change-feed-helpers:v7',
  'smrt-change-feed-helpers:v6',
  'smrt-change-feed-helpers:v5',
  'smrt-change-feed-helpers:v4',
];
const RUNTIME_ROLE = 'drain_status_runtime';

/**
 * A v6-shaped two-argument drain: drain lock and head tried, staged rows
 * sequenced, no status overload. Stands in for a database a v6 build
 * installed.
 */
const V6_DRAIN = `
CREATE OR REPLACE FUNCTION _smrt_drain_changes(p_limit INTEGER, p_excluded_tables TEXT[])
RETURNS TABLE(
  drained_seq BIGINT, drained_table TEXT, drained_row_id TEXT,
  drained_operation TEXT, drained_tenant_id TEXT, error_code TEXT, error_message TEXT
)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
AS $v6_drain$
-- smrt-change-feed-helpers:v6
-- smrt-change-feed-helpers:v5
-- smrt-change-feed-helpers:v4
DECLARE
  v_base BIGINT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('smrt'), hashtext('change-feed-drain')) THEN
    RETURN;
  END IF;
  SELECT COALESCE(MAX(seq), 0) INTO v_base FROM _smrt_changes;
  RETURN QUERY
  WITH removed AS (
    DELETE FROM _smrt_changes_pending AS pending
    WHERE pending.pending_id IN (
      SELECT c.pending_id FROM _smrt_changes_pending AS c
      WHERE NOT (c.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[])))
      ORDER BY c.pending_id LIMIT GREATEST(COALESCE(p_limit, 1000), 1)
    )
    RETURNING pending.*
  ), numbered AS (
    SELECT removed.*, v_base + row_number() OVER (ORDER BY removed.pending_id) AS new_seq
    FROM removed
  ), inserted AS (
    INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
    SELECT new_seq, numbered.table_name, numbered.row_id, numbered.operation,
           numbered.tenant_id, numbered.created_at
    FROM numbered
    RETURNING _smrt_changes.seq, _smrt_changes.table_name, _smrt_changes.row_id,
              _smrt_changes.operation, _smrt_changes.tenant_id
  )
  SELECT inserted.seq, inserted.table_name, inserted.row_id, inserted.operation,
         inserted.tenant_id::TEXT, NULL::TEXT, NULL::TEXT
  FROM inserted ORDER BY inserted.seq;
END;
$v6_drain$;
`;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function one(
  db: DatabaseInterface,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>> {
  return rowsOf(await db.query(sql, ...params))[0] ?? {};
}

async function stageCommitted(
  db: DatabaseInterface,
  table: string,
  rowId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
     VALUES ($1, $2, 'update', now())`,
    table,
    rowId,
  );
}

async function statusDrain(
  db: DatabaseInterface,
  excluded: string[] = [],
): Promise<Record<string, unknown>[]> {
  return rowsOf(
    await db.query(
      `SELECT * FROM _smrt_drain_changes(1000, $1::text[], '{}'::jsonb)`,
      `{${excluded.join(',')}}`,
    ),
  );
}

/** Rewrite an installed helper's body with one marker line removed. */
async function stripMarker(
  db: DatabaseInterface,
  identity: string,
  marker: string,
): Promise<void> {
  const row = await one(
    db,
    `SELECT pg_get_functiondef(to_regprocedure($1)) AS def`,
    identity,
  );
  const def = String(row.def).replace(`-- ${marker}\n`, '');
  expect(def).not.toContain(marker);
  await db.query(def);
}

async function helperVersions(
  db: DatabaseInterface,
): Promise<Record<string, boolean[]>> {
  const out: Record<string, boolean[]> = {};
  for (const identity of IDENTITIES) {
    const row = await one(
      db,
      `SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)`,
      identity,
    );
    const source = String(row.prosrc ?? '');
    out[identity] = MARKERS.map((marker) => source.includes(marker));
  }
  return out;
}

async function executeGrantees(
  db: DatabaseInterface,
  identity: string,
): Promise<string[]> {
  const rows = rowsOf(
    await db.query(
      `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                   ELSE pg_get_userbyid(acl.grantee) END AS grantee
         FROM pg_proc AS p,
              aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE p.oid = to_regprocedure($1) AND acl.privilege_type = 'EXECUTE'
        ORDER BY 1`,
      identity,
    ),
  );
  return rows.map((row) => String(row.grantee));
}

async function createRuntimeRole(db: DatabaseInterface): Promise<void> {
  await db.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
  await db.query(`CREATE ROLE ${RUNTIME_ROLE} NOSUPERUSER`);
  await db.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
  await db.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON _smrt_changes, _smrt_changes_pending TO ${RUNTIME_ROLE}`,
  );
  await db.query(
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`,
  );
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'change-feed status drain on PGlite (#5402)',
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
      vi.restoreAllMocks();
      try {
        await db.query('RESET ROLE');
      } catch {
        // The handle may already be closed.
      }
      await db.close?.();
    });

    it('installs the status drain beside the four helpers, each carrying the v7 to v4 markers', async () => {
      const versions = await helperVersions(db);
      for (const identity of IDENTITIES) {
        expect(versions[identity], identity).toEqual([true, true, true, true]);
      }
      expect(await probeChangeFeedHelperState(db)).toBe('current');
    });

    it('keeps the older drain identities to their seven columns and no status row', async () => {
      await stageCommitted(db, SUBJECT, 'a');
      const two = rowsOf(
        await db.query(
          'SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[])',
        ),
      );
      expect(two).toHaveLength(1);
      expect(Object.keys(two[0] ?? {}).sort()).toEqual(
        [
          'drained_seq',
          'drained_table',
          'drained_row_id',
          'drained_operation',
          'drained_tenant_id',
          'error_code',
          'error_message',
        ].sort(),
      );
      expect(two[0]?.drained_row_id).toBe('a');

      await stageCommitted(db, SUBJECT, 'b');
      const one = rowsOf(await db.query('SELECT * FROM _smrt_drain_changes()'));
      expect(one.map((row) => row.drained_row_id)).toEqual(['b']);
      expect(
        rowsOf(await db.query('SELECT * FROM _smrt_drain_changes()')),
      ).toEqual([]);
    });

    it('ends every status-drain call with one status row', async () => {
      const empty = await statusDrain(db);
      expect(empty).toHaveLength(1);
      expect(empty[0]).toMatchObject({
        drained_seq: null,
        error_code: null,
        status: 'empty',
        backlog_remaining: false,
        helpers_current: null,
      });

      await stageCommitted(db, SUBJECT, 'a');
      await stageCommitted(db, SUBJECT, 'b');
      const drained = rowsOf(
        await db.query(
          `SELECT * FROM _smrt_drain_changes(1, ARRAY[]::text[], '{}'::jsonb)`,
        ),
      );
      expect(drained.map((row) => row.drained_row_id)).toEqual(['a', null]);
      expect(drained[1]).toMatchObject({
        status: 'drained',
        backlog_remaining: true,
        helpers_current: true,
      });
      const rest = await statusDrain(db);
      expect(rest.map((row) => row.drained_row_id)).toEqual(['b', null]);
      expect(rest[1]).toMatchObject({
        status: 'drained',
        backlog_remaining: false,
      });
    });

    it('reports a written transaction and a fixed snapshot without sequencing', async () => {
      await stageCommitted(db, SUBJECT, 'a');
      await db.query('BEGIN');
      await db.query('SELECT pg_current_xact_id()');
      expect((await statusDrain(db)).at(-1)?.status).toBe('in_transaction');
      await db.query('ROLLBACK');

      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      expect((await statusDrain(db)).at(-1)?.status).toBe('fixed_snapshot');
      await db.query('ROLLBACK');

      expect(
        Number((await one(db, 'SELECT count(*) AS n FROM _smrt_changes')).n),
      ).toBe(0);
    });

    it('holds no lock on the staging table after finding nothing to drain inside an open transaction', async () => {
      await db.query('BEGIN');
      const rows = rowsOf(
        await db.query(
          'SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[])',
        ),
      );
      expect(rows).toEqual([]);
      const held = await one(
        db,
        `SELECT count(*)::int AS n
           FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND (relation = to_regclass('_smrt_changes_pending')
                 OR (locktype = 'advisory'
                     AND classid::bigint = (hashtext('smrt')::bigint & 4294967295)))`,
      );
      await db.query('ROLLBACK');
      expect(Number(held.n)).toBe(0);
    });

    it('keeps no lock after a pass whose batch comes back empty inside an open transaction', async () => {
      // The candidate is seen, but its delete removes nothing (as when it
      // was deleted while the pass waited): the pass found no work.
      await db.query(`
        CREATE OR REPLACE FUNCTION drain_status_keep_rows() RETURNS trigger
        LANGUAGE plpgsql AS $keep$ BEGIN RETURN NULL; END; $keep$`);
      await db.query(
        `CREATE TRIGGER drain_status_keep_rows BEFORE DELETE ON _smrt_changes_pending
         FOR EACH ROW EXECUTE FUNCTION drain_status_keep_rows()`,
      );
      await stageCommitted(db, SUBJECT, 'kept');
      await db.query('BEGIN');
      const rows = await statusDrain(db);
      const held = await one(
        db,
        `SELECT count(*)::int AS n
           FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND (locktype = 'advisory'
                 OR relation IN (to_regclass('_smrt_changes'),
                                 to_regclass('_smrt_changes_pending')))`,
      );
      await db.query('ROLLBACK');
      expect(rows).toEqual([
        // The candidate is still there: another look is asked for.
        expect.objectContaining({
          status: 'empty',
          drained_seq: null,
          backlog_remaining: true,
        }),
      ]);
      expect(Number(held.n)).toBe(0);
    });

    it('voids every entry of a pass whose sequencing fails after its rows were produced', async () => {
      // An AFTER trigger runs once the sequencing statement has produced
      // its rows; a lock timeout there must not read as a skipped pass.
      await db.query(`
        CREATE OR REPLACE FUNCTION drain_status_late_lock() RETURNS trigger
        LANGUAGE plpgsql AS $late$
        BEGIN
          RAISE EXCEPTION 'lock wait ran out' USING ERRCODE = '55P03';
        END;
        $late$`);
      await db.query(
        `CREATE TRIGGER drain_status_late_lock AFTER INSERT ON _smrt_changes
         FOR EACH ROW EXECUTE FUNCTION drain_status_late_lock()`,
      );
      await stageCommitted(db, SUBJECT, 'late');
      const rows = await statusDrain(db);
      expect(rows.some((row) => row.error_code === '55P03')).toBe(true);
      expect(rows.some((row) => row.status != null)).toBe(false);
      // The public drain voids those entries and reports nothing drained:
      // contention, never thrown at the caller.
      expect(await drainChangeFeed(db)).toBe(0);
      expect(
        Number(
          (await one(db, 'SELECT count(*) AS n FROM _smrt_changes_pending')).n,
        ),
      ).toBe(1);
    });

    it('purges sensitive rows alone without taking the head, and reports drained', async () => {
      await stageCommitted(db, SECRET, 'secret-1');
      await db.query('BEGIN');
      const rows = await statusDrain(db, [SECRET]);
      const head = await one(
        db,
        `SELECT count(*)::int AS n
           FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND locktype = 'advisory'
            AND classid::bigint = (hashtext('smrt-change-feed-head')::bigint & 4294967295)`,
      );
      await db.query('COMMIT');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'drained',
        backlog_remaining: false,
      });
      expect(Number(head.n)).toBe(0);
      expect(
        Number(
          (await one(db, 'SELECT count(*) AS n FROM _smrt_changes_pending')).n,
        ),
      ).toBe(0);
    });

    it('returns 42501 as data to a role that may run only the two-argument drain', async () => {
      await createRuntimeRole(db);
      await db.query(`REVOKE EXECUTE ON FUNCTION ${STATUS_DRAIN} FROM PUBLIC`);
      await stageCommitted(db, SUBJECT, 'a');
      await db.query('BEGIN');
      await db.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      const rows = rowsOf(
        await db.query(
          'SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[])',
        ),
      );
      expect(rows.map((row) => row.error_code)).toEqual(['42501']);
      // The caller's transaction is still usable.
      expect((await one(db, 'SELECT 1 AS ok')).ok).toBe(1);
      await db.query('ROLLBACK');
    });

    it('makes the status drain grantable to exactly the two-argument drain grantees', async () => {
      // Default installation: a NULL ACL on the source compares equal.
      expect(await executeGrantees(db, STATUS_DRAIN)).toEqual(
        await executeGrantees(db, '_smrt_drain_changes(integer,text[])'),
      );

      // Hardened: PUBLIC revoked, one runtime role granted; a default
      // privilege adds an extra grantee to every new function.
      await createRuntimeRole(db);
      await db.query('DROP ROLE IF EXISTS drain_status_extra');
      await db.query('CREATE ROLE drain_status_extra NOSUPERUSER');
      await db.query(
        'REVOKE EXECUTE ON FUNCTION _smrt_drain_changes(integer,text[]) FROM PUBLIC',
      );
      await db.query(
        `GRANT EXECUTE ON FUNCTION _smrt_drain_changes(integer,text[]) TO ${RUNTIME_ROLE}`,
      );
      await db.query(
        'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO drain_status_extra',
      );
      try {
        await db.query(`DROP FUNCTION ${STATUS_DRAIN}`);
        // The explicit replacement (opportunistic upgrades skip a shared
        // PGlite session).
        await ensurePostgresChangeFeedAppendFunction(db);
        const grantees = await executeGrantees(db, STATUS_DRAIN);
        expect(grantees).toEqual(
          await executeGrantees(db, '_smrt_drain_changes(integer,text[])'),
        );
        expect(grantees).toContain(RUNTIME_ROLE);
        expect(grantees).not.toContain('PUBLIC');
        expect(grantees).not.toContain('drain_status_extra');
      } finally {
        await db.query(
          'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM drain_status_extra',
        );
      }
    });

    it('reads a database whose helpers all carry v6 as usable, and leaves a transaction handle alone', async () => {
      await db.query(`DROP FUNCTION ${STATUS_DRAIN}`);
      await db.query(V6_DRAIN);
      for (const identity of [IDENTITIES[0], IDENTITIES[1], IDENTITIES[3]]) {
        await stripMarker(db, identity as string, MARKERS[0] as string);
      }
      expect(await probeChangeFeedHelperState(db)).toBe('usable-older');

      const tx = (await (
        db as unknown as {
          beginTransaction: () => Promise<DatabaseInterface>;
        }
      ).beginTransaction()) as DatabaseInterface & {
        rollback: () => Promise<void>;
      };
      const statements: string[] = [];
      const query = tx.query.bind(tx);
      (tx as { query: unknown }).query = (sql: string, ...rest: unknown[]) => {
        statements.push(sql);
        return query(sql, ...rest);
      };
      await ensureChangeFeedTable(tx);
      expect(statements.some((sql) => /\bDO\b/.test(sql))).toBe(false);
      expect((await one(tx, 'SELECT 1 AS ok')).ok).toBe(1);
      await tx.rollback();
      expect(await probeChangeFeedHelperState(db)).toBe('usable-older');
    });

    it('keeps working on v6 helpers and runs no opportunistic upgrade DDL on one shared session', async () => {
      await db.query(`DROP FUNCTION ${STATUS_DRAIN}`);
      await db.query(V6_DRAIN);
      for (const identity of [IDENTITIES[0], IDENTITIES[1], IDENTITIES[3]]) {
        await stripMarker(db, identity as string, MARKERS[0] as string);
      }
      await stageCommitted(db, SUBJECT, 'a');
      const installs: string[] = [];
      const query = db.query.bind(db);
      (db as { query: unknown }).query = (sql: string, ...rest: unknown[]) => {
        if (/^\s*DO\b/.test(sql)) installs.push(sql);
        return query(sql, ...rest);
      };
      // A caller's raw BEGIN could reach this session between any check and
      // the DDL; the upgrade is left to an explicit replacement.
      await ensurePostgresChangeFeedHelpers(db);
      expect(await drainChangeFeed(db)).toBe(1);
      expect(installs).toHaveLength(0);
      expect(await probeChangeFeedHelperState(db)).toBe('usable-older');
      // The explicit replacement still upgrades it.
      await ensurePostgresChangeFeedAppendFunction(db);
      expect(await probeChangeFeedHelperState(db)).toBe('current');
    });

    it('names the owner upgrade when helpers older than v6 cannot be replaced', async () => {
      await stripMarker(db, IDENTITIES[2] as string, MARKERS[0] as string);
      await stripMarker(db, IDENTITIES[2] as string, MARKERS[1] as string);
      expect(await probeChangeFeedHelperState(db)).toBe('outdated');
      await createRuntimeRole(db);
      await db.query(`SET ROLE ${RUNTIME_ROLE}`);
      const error = await ensurePostgresChangeFeedHelpers(db).then(
        () => null,
        (caught: unknown) => caught as Error & { code?: string },
      );
      expect(error?.message).toMatch(
        /database owner must install the current helpers/,
      );
      // The SQLSTATE, not the SDK wrapper's generic code; and no raw driver
      // error (which can quote a connection string) as its cause.
      expect(error?.code).toBe('42501');
      expect((error as Error & { cause?: unknown })?.cause).toEqual({
        code: '42501',
      });
    });

    it('gives no grantee a grant option on the status drain that the two-argument drain does not give', async () => {
      await createRuntimeRole(db);
      await db.query(
        `GRANT EXECUTE ON FUNCTION _smrt_drain_changes(integer,text[]) TO ${RUNTIME_ROLE}`,
      );
      await db.query(
        `GRANT EXECUTE ON FUNCTION ${STATUS_DRAIN} TO ${RUNTIME_ROLE} WITH GRANT OPTION`,
      );
      // Reinstall through the explicit replacement.
      await ensurePostgresChangeFeedAppendFunction(db);
      const rows = rowsOf(
        await db.query(
          `SELECT acl.is_grantable
             FROM pg_proc AS p, aclexplode(p.proacl) AS acl
            WHERE p.oid = to_regprocedure($1)
              AND acl.grantee = $2::regrole
              AND acl.privilege_type = 'EXECUTE'`,
          STATUS_DRAIN,
          RUNTIME_ROLE,
        ),
      );
      expect(rows.map((row) => row.is_grantable)).toEqual([false]);
    });
  },
);
