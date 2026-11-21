/**
 * Change-feed gap markers on PostgreSQL (#5438, PR 1a): the cases that need
 * two sessions, real lock waits, roles or isolation levels.
 *
 * - A retryable failure (a lock timeout on one row's move, a batch-level lock
 *   timeout, a duplicate on the feed's sequence key) never turns a staged
 *   entry into a marker.
 * - The delivery gate is read under the drain lock and locked FOR SHARE; a
 *   fixed-snapshot drain allocates nothing.
 * - A pass is atomic: cancelled or terminated, it leaves staged rows,
 *   markers and the feed as they were; a caller transaction stays usable.
 * - The version read never raises, also for a role that may not read the
 *   gap table, inside its own transaction.
 * - The version routine takes the two-argument drain's owner and grantees.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`), pinned to this suite's own schema.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  drainChangeFeed,
  ensureChangeFeedTable,
  getChangesSince,
  getTableVersion,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';
import {
  CHANGE_FEED_GAP_DELIVERY_SETTING,
  CREATE_SMRT_BACKFILLS_TABLE,
} from '../system/schema';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const SCHEMA = 'change_feed_gaps_5438';
const SUBJECT = 'gap_pg_subject';

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  return [];
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function connect(
  label: string,
  baseUrl = pgUrl as string,
): Promise<DatabaseInterface> {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return (await getDatabase({
    type: 'postgres',
    url:
      `${baseUrl}${separator}options=-c%20search_path%3D${SCHEMA}` +
      `&application_name=smrtgap_${label}_${randomUUID().slice(0, 8)}`,
    dbid: `smrt-test-gaps-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

function runTransaction<T>(
  handle: DatabaseInterface,
  run: (tx: DatabaseInterface) => Promise<T>,
): Promise<T> {
  const transaction = handle.transaction;
  if (typeof transaction !== 'function') {
    throw new Error('This spec requires a transactional PostgreSQL handle.');
  }
  return transaction.call(handle, run as never) as Promise<T>;
}

/** Hold a transaction open after `start` ran, until `release` is called. */
async function holdTransaction(
  handle: DatabaseInterface,
  start: (tx: DatabaseInterface) => Promise<void>,
): Promise<{ pid: number; release: () => Promise<void> }> {
  const started = deferred<number>();
  const release = deferred();
  const done = runTransaction(handle, async (tx) => {
    const pid = Number(
      rowsOf(await tx.query('SELECT pg_backend_pid() AS pid'))[0]?.pid,
    );
    await start(tx);
    started.resolve(pid);
    await release.promise;
  });
  const pid = await Promise.race([
    started.promise,
    done.then(() => {
      throw new Error('transaction ended before it was held');
    }),
  ]);
  return {
    pid,
    release: async () => {
      release.resolve();
      await done;
    },
  };
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change-feed gap markers (optional, #5438)', () => {
  let setup: DatabaseInterface;
  let other: DatabaseInterface;
  let observer: DatabaseInterface;

  const all = async (sql: string, ...params: unknown[]) =>
    rowsOf(await setup.query(sql, ...params));

  async function stage(rowId: string, table = SUBJECT): Promise<void> {
    await setup.query(
      `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
       VALUES ($1, $2, 'update', now())`,
      table,
      rowId,
    );
  }

  async function addMarker(table = SUBJECT): Promise<void> {
    await setup.query(
      `INSERT INTO _smrt_change_gaps (table_name, row_id, operation, created_at)
       VALUES ($1, 'lost', 'update', clock_timestamp())`,
      table,
    );
  }

  async function enableDelivery(): Promise<void> {
    await setup.query(
      'INSERT INTO _smrt_backfills (name) VALUES ($1) ON CONFLICT DO NOTHING',
      CHANGE_FEED_GAP_DELIVERY_SETTING,
    );
  }

  async function snapshot(): Promise<Row> {
    return {
      feed: await all(
        'SELECT seq::int, row_id, operation FROM _smrt_changes ORDER BY seq',
      ),
      pending: await all(
        'SELECT row_id FROM _smrt_changes_pending ORDER BY pending_id',
      ),
      markers: await all(
        'SELECT gap_id::text, converted_seq::int, blocked_at IS NOT NULL AS blocked FROM _smrt_change_gaps ORDER BY gap_id',
      ),
    };
  }

  async function refuseFeedRow(rowId: string): Promise<void> {
    await setup.query(`
      CREATE OR REPLACE FUNCTION gap_pg_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.row_id = '${rowId}' THEN
          RAISE EXCEPTION 'refused' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $fn$`);
    await setup.query(
      'CREATE TRIGGER gap_pg_refuse BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_pg_refuse()',
    );
  }

  beforeAll(async () => {
    const admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-gaps-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.close?.();
    setup = await connect('setup');
    other = await connect('other');
    observer = await connect('observer');
    await ensureChangeFeedTable(setup);
    await setup.query(CREATE_SMRT_BACKFILLS_TABLE);
  });

  afterAll(async () => {
    for (const handle of [setup, other, observer]) await handle?.close?.();
  });

  beforeEach(async () => {
    resetChangeFeedWarnings();
    await settleChangeFeedDrainers();
    await setup.query('DROP TRIGGER IF EXISTS gap_pg_refuse ON _smrt_changes');
    await setup.query(
      'TRUNCATE _smrt_changes, _smrt_changes_pending, _smrt_change_gaps, _smrt_backfills',
    );
  });

  afterEach(async () => {
    stopChangeFeedDrainers();
    await settleChangeFeedDrainers();
  });

  it('T5: a lock timeout on one valid row after isolation started leaves that row staged for a later pass', async () => {
    await stage('a');
    await stage('poison');
    await stage('locked');
    // The batch fails on 'poison' (row-attributable) before it reaches
    // 'locked'; once isolation moves 'locked' alone, its feed insert waits
    // for a lock another session holds and times out.
    await setup.query(`
      CREATE OR REPLACE FUNCTION gap_pg_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.row_id = 'poison' THEN
          RAISE EXCEPTION 'refused' USING ERRCODE = '23514';
        ELSIF NEW.row_id = 'locked' THEN
          PERFORM pg_advisory_xact_lock(5438, 1);
        END IF;
        RETURN NEW;
      END $fn$`);
    await setup.query(
      'CREATE TRIGGER gap_pg_refuse BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_pg_refuse()',
    );
    const lock = await holdTransaction(other, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(5438, 1)');
    });
    try {
      await runTransaction(setup, async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '200ms'");
        await tx.query(
          "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
        );
      });
    } finally {
      await lock.release();
    }
    const markers = await all('SELECT row_id FROM _smrt_change_gaps');
    expect(markers.map((row) => row.row_id)).toEqual(['poison']);
    expect(
      (await all('SELECT row_id FROM _smrt_changes_pending')).map(
        (r) => r.row_id,
      ),
    ).toContain('locked');
    await drainChangeFeed(setup);
    expect(
      (await all('SELECT row_id FROM _smrt_changes ORDER BY seq')).map(
        (r) => r.row_id,
      ),
    ).toContain('locked');
  }, 30_000);

  it('T5: a batch-level lock timeout and a sequence-key duplicate start no isolation', async () => {
    await stage('a');
    await stage('b');
    const share = await holdTransaction(other, async (tx) => {
      await tx.query('LOCK TABLE _smrt_changes_pending IN SHARE MODE');
    });
    try {
      await runTransaction(setup, async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '200ms'");
        await tx.query(
          "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
        );
      });
    } finally {
      await share.release();
    }
    expect(await all('SELECT 1 FROM _smrt_change_gaps')).toEqual([]);

    // An older appender that ignores the head lock takes the next sequence
    // inside a trigger: the batch insert hits the feed's own key.
    await setup.query(`
      CREATE OR REPLACE FUNCTION gap_pg_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.row_id = 'a' THEN
          RAISE unique_violation USING CONSTRAINT = '_smrt_changes_pkey',
            MESSAGE = 'duplicate key value violates unique constraint "_smrt_changes_pkey"';
        END IF;
        RETURN NEW;
      END $fn$`);
    await setup.query(
      'CREATE TRIGGER gap_pg_refuse BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_pg_refuse()',
    );
    const rows = rowsOf(
      await setup.query(
        "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
      ),
    );
    expect(rows.find((row) => row.error_code != null)?.error_code).toBe(
      '23505',
    );
    expect(await all('SELECT 1 FROM _smrt_change_gaps')).toEqual([]);
    expect((await all('SELECT row_id FROM _smrt_changes_pending')).length).toBe(
      2,
    );
  }, 30_000);

  it('T12: a pass skips when the setting is gone, a fixed snapshot allocates nothing, and a delete waits for a pass holding the row lock', async () => {
    await addMarker();
    // (a) No setting: nothing positioned.
    await drainChangeFeed(setup);
    expect(
      await all("SELECT 1 FROM _smrt_changes WHERE operation = 'gap'"),
    ).toEqual([]);

    // (b) A REPEATABLE READ session whose snapshot predates the delete.
    await enableDelivery();
    const ready = deferred();
    const go = deferred();
    const rr = runTransaction(other, async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await tx.query('SELECT count(*) FROM _smrt_backfills');
      ready.resolve();
      await go.promise;
      const rows = rowsOf(
        await tx.query(
          "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
        ),
      );
      return rows.find((row) => row.status != null)?.status;
    });
    await ready.promise;
    await setup.query('DELETE FROM _smrt_backfills');
    go.resolve();
    expect(await rr).toBe('fixed_snapshot');
    expect(
      await all("SELECT 1 FROM _smrt_changes WHERE operation = 'gap'"),
    ).toEqual([]);

    // (c) A pass holding the row lock: a concurrent delete waits for it.
    await enableDelivery();
    const pass = await holdTransaction(other, async (tx) => {
      await tx.query(
        "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
      );
    });
    const deleted = observer
      .query('DELETE FROM _smrt_backfills')
      .then(() => Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const releasedAt = Date.now();
    await pass.release();
    expect(await deleted).toBeGreaterThanOrEqual(releasedAt);
    expect(
      await all("SELECT 1 FROM _smrt_changes WHERE operation = 'gap'"),
    ).toHaveLength(1);
  }, 30_000);

  it('T11, T23: a cancelled pass is an error row, rolls back as a whole and leaves the caller transaction usable', async () => {
    await enableDelivery();
    await setup.query(
      `INSERT INTO _smrt_change_gaps (table_name, created_at)
       SELECT $1, now() FROM generate_series(1, 150)`,
      SUBJECT,
    );
    await setup.query(`
      CREATE OR REPLACE FUNCTION gap_pg_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.operation = 'gap' THEN PERFORM pg_sleep(0.01); END IF;
        RETURN NEW;
      END $fn$`);
    await setup.query(
      'CREATE TRIGGER gap_pg_refuse BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_pg_refuse()',
    );
    const before = await snapshot();
    const after = await runTransaction(setup, async (tx) => {
      await tx.query("SET LOCAL statement_timeout = '300ms'");
      const rows = rowsOf(
        await tx.query(
          "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
        ),
      );
      const ok = rowsOf(await tx.query('SELECT 1 AS ok'))[0]?.ok;
      return { rows, ok };
    });
    expect(after.rows.find((row) => row.error_code != null)?.error_code).toBe(
      '57014',
    );
    expect(after.ok).toBe(1);
    expect(await snapshot()).toEqual(before);
  }, 30_000);

  it('T23: a terminated pass leaves everything as it was', async () => {
    await enableDelivery();
    await addMarker();
    await stage('a');
    await setup.query(`
      CREATE OR REPLACE FUNCTION gap_pg_refuse() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.operation = 'gap' THEN PERFORM pg_sleep(30); END IF;
        RETURN NEW;
      END $fn$`);
    await setup.query(
      'CREATE TRIGGER gap_pg_refuse BEFORE INSERT ON _smrt_changes FOR EACH ROW EXECUTE FUNCTION gap_pg_refuse()',
    );
    const before = await snapshot();
    const victim = await connect('victim');
    const pid = Number(
      rowsOf(await victim.query('SELECT pg_backend_pid() AS pid'))[0]?.pid,
    );
    const pass = victim
      .query(
        "SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)",
      )
      .catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await observer.query('SELECT pg_terminate_backend($1)', pid);
    await pass;
    await victim.close?.().catch(() => undefined);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it('T13: a gap-only drain in a caller transaction serves nothing at or above its allocation, and a second session never sees it', async () => {
    await stage('e1');
    await drainChangeFeed(setup);
    await enableDelivery();
    await addMarker();
    const rollback = new Error('roll back');
    let inside = -1;
    let seenByOther = -1;
    await expect(
      runTransaction(setup, async (tx) => {
        await drainChangeFeed(tx);
        inside = (await getChangesSince(tx, { since: 0 })).cursor;
        seenByOther = (await getChangesSince(other, { since: 0, drain: false }))
          .cursor;
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(inside).toBe(1);
    expect(seenByOther).toBe(1);
    expect(
      (await all('SELECT converted_seq FROM _smrt_change_gaps'))[0]
        ?.converted_seq,
    ).toBeNull();
  }, 30_000);

  it('T16: a role that may not read the gap table gets an unrepeatable version and keeps its transaction', async () => {
    const role = `gap_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = randomUUID();
    await setup.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    let reader: DatabaseInterface | undefined;
    try {
      await setup.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);
      await setup.query(
        `GRANT SELECT ON _smrt_changes, _smrt_changes_pending TO ${role}`,
      );
      await setup.query(
        `GRANT EXECUTE ON FUNCTION _smrt_change_feed_version(text) TO ${role}`,
      );
      await stage('a');
      await drainChangeFeed(setup);
      const url = new URL(pgUrl as string);
      url.username = role;
      url.password = password;
      reader = await connect('reader', url.toString());
      const result = await runTransaction(reader, async (tx) => {
        const a = await getTableVersion(tx, SUBJECT);
        const b = await getTableVersion(tx, SUBJECT);
        const ok = rowsOf(await tx.query('SELECT 1 AS ok'))[0]?.ok;
        return { a, b, ok };
      });
      expect(result.a).not.toBe(result.b);
      expect(result.ok).toBe(1);
    } finally {
      await reader?.close?.();
      await setup.query(`DROP OWNED BY ${role}`);
      await setup.query(`DROP ROLE ${role}`);
    }
  }, 30_000);

  it('T22: the version routine takes the two-argument drain owner and EXECUTE grantees', async () => {
    const grantees = async (identity: string) =>
      (
        await all(
          `SELECT CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS g
             FROM pg_proc AS p,
                  aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
            WHERE p.oid = to_regprocedure($1) AND acl.privilege_type = 'EXECUTE'
            ORDER BY 1`,
          identity,
        )
      ).map((row) => row.g);
    const owner = async (identity: string) =>
      (
        await all(
          'SELECT proowner::regrole::text AS o FROM pg_proc WHERE oid = to_regprocedure($1)',
          identity,
        )
      )[0]?.o;
    await setup.query(
      'REVOKE EXECUTE ON FUNCTION _smrt_drain_changes(integer, text[]) FROM PUBLIC',
    );
    await setup.query(
      `SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('_smrt_change_feed_version(text)')`,
    );
    // Reinstall: the routine is reconciled against the drain's ACL.
    const { REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION } = await import(
      '../system/schema'
    );
    await setup.query(REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION);
    expect(await grantees('_smrt_change_feed_version(text)')).toEqual(
      await grantees('_smrt_drain_changes(integer,text[])'),
    );
    expect(await owner('_smrt_change_feed_version(text)')).toBe(
      await owner('_smrt_drain_changes(integer,text[])'),
    );
    await setup.query(
      'GRANT EXECUTE ON FUNCTION _smrt_drain_changes(integer, text[]) TO PUBLIC',
    );
    await setup.query(REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION);
  }, 30_000);
});
