/** Canonical, idempotent SMRT system-table provisioning. */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import {
  ensurePostgresChangeFeedAppendFunction,
  ensurePostgresChangeFeedHelpers,
} from '../change-feed.js';
import {
  assertPostgresSystemTimestampsCurrent,
  ensureBootstrapSystemTableCompatibility,
  getDatabaseEngine,
  tableExists,
} from './compatibility.js';
import { getSystemTableDDL, SMRT_SCHEMA_VERSION } from './schema.js';

const SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('smrt'), hashtext('system-tables'))";

/**
 * Timeout budget for the PostgreSQL system-table bootstrap transaction.
 *
 * The runtime pool's session `lock_timeout`/`statement_timeout` (#2377) are
 * sized for request work. This transaction is not request work: it holds the
 * advisory lock across up to 29 sequential DDL round-trips — ~18.85 s on a
 * high-latency link at 650 ms per round trip — and a second replica cold-starting
 * against the same fresh database *waits* on that lock. Both GUCs bound that
 * wait, because `pg_advisory_xact_lock` is an ordinary statement in the lock
 * manager, so at the runtime defaults the second replica would abort with
 * "canceling statement due to lock timeout" where it previously waited and
 * succeeded.
 *
 * Five minutes is an order of magnitude above the documented worst case and
 * still bounded — this is a raise, not a disable. `SET LOCAL` scopes it to this
 * transaction, the same lever migrations use for the same reason (#2362).
 */
const SYSTEM_TABLE_BOOTSTRAP_TIMEOUT_SQL = [
  "SET LOCAL lock_timeout = '300000ms'",
  "SET LOCAL statement_timeout = '300000ms'",
];
const logger = createLogger({ level: 'info' });

type TransactionCapableDatabase = DatabaseInterface & {
  transaction?: <T>(
    this: DatabaseInterface,
    callback: (tx: DatabaseInterface) => Promise<T>,
  ) => Promise<T>;
};

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function isSystemSchemaVersionApplied(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<boolean> {
  const engine = getDatabaseEngine(db, typeHint);
  if (
    engine === 'postgres' &&
    !(await tableExists(db, '_smrt_migrations', typeHint))
  ) {
    return false;
  }
  try {
    const versionParam = engine === 'postgres' ? '$1' : '?';
    const rows = await db.query(
      `SELECT 1 FROM _smrt_migrations WHERE version = ${versionParam} LIMIT 1`,
      SMRT_SCHEMA_VERSION,
    );
    return getQueryRows(rows).length > 0;
  } catch (error) {
    if (engine === 'postgres') throw error;
    return false;
  }
}

async function bootstrapSystemTables(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  // #2649: the change-feed helpers changed without a change to the portable
  // system DDL, so a database already stamped with this version would never
  // reach the install below and would keep the deadlocking append function.
  // Ordinary model writes do not call ensureChangeFeedTable(), so nothing else
  // would repair it. One catalog probe when the helpers are already current.
  await ensurePostgresChangeFeedHelpers(db, typeHint);

  if (await isSystemSchemaVersionApplied(db, typeHint)) return;

  await ensureBootstrapSystemTableCompatibility(db, typeHint);
  const engine = getDatabaseEngine(db, typeHint);
  for (const ddl of getSystemTableDDL(engine)) {
    for (const statement of ddl
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      await db.query(statement);
    }
  }
  await ensurePostgresChangeFeedAppendFunction(db, { typeHint });
  await assertPostgresSystemTimestampsCurrent(db, typeHint);

  const id = crypto.randomUUID();
  const description = 'Initial SMRT system tables';
  await db.execute`
    INSERT INTO _smrt_migrations (id, version, description)
    VALUES (${id}, ${SMRT_SCHEMA_VERSION}, ${description})
    ON CONFLICT(version) DO NOTHING
  `;
}

async function rollbackBootstrap(tx: TransactionHandle): Promise<void> {
  try {
    if (typeof tx.isActive !== 'function' || tx.isActive()) await tx.rollback();
  } catch (error) {
    logger.warn(
      `[smrt] Failed to rollback system table bootstrap transaction: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Run `work` serialized against concurrent SMRT system-table bootstrap.
 *
 * `_smrt_dispatch`/`_smrt_dispatch_subscriptions` (and every other
 * framework-owned `_smrt_*` table) are catalog objects shared by every
 * caller against one physical database — including standalone initializers
 * such as `DispatchBus.initialize()` that provision or verify a subset of
 * {@link ALL_SYSTEM_TABLES} outside of a full {@link ensureSystemTables} run
 * (#2861). PostgreSQL DDL against the same object from concurrent sessions is
 * not internally serialized (`CREATE TABLE IF NOT EXISTS` races on
 * `pg_type_typname_nsp_index` under true concurrency; `ALTER TABLE`/`CREATE
 * INDEX` take catalog locks that queue behind each other), so every writer of
 * a system table — full bootstrap or a standalone initializer alike — must
 * take the *same* advisory lock before touching it. Using one shared lock key
 * across all of them is what makes them mutually exclusive rather than each
 * safe only against itself.
 *
 * PostgreSQL: wraps `work` in the same bounded advisory-locked transaction
 * {@link bootstrapSystemTables} uses. Other engines have no comparable
 * catalog race for this codebase's supported deployment shapes, so `work`
 * runs directly against `db`.
 */
export async function runSerializedAgainstSystemTableBootstrap<T>(
  db: DatabaseInterface,
  typeHint: string | undefined,
  work: (scopedDb: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (getDatabaseEngine(db, typeHint) !== 'postgres') {
    return work(db);
  }

  const beginTransaction = db.beginTransaction;
  const transaction = (db as TransactionCapableDatabase).transaction;

  if (typeof beginTransaction === 'function') {
    const tx = await beginTransaction.call(db);
    if (!tx) throw new Error('Database transaction could not be started');
    try {
      // Raise the budget before taking the lock — the wait itself is what the
      // runtime session timeouts would otherwise cancel (#2377).
      for (const sql of SYSTEM_TABLE_BOOTSTRAP_TIMEOUT_SQL) await tx.query(sql);
      await tx.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await rollbackBootstrap(tx);
      throw error;
    }
  }

  if (typeof transaction === 'function') {
    // `db` has `transaction()` but no `beginTransaction()`. Two distinct
    // shapes reach here, and they are NOT the same case:
    //
    // - `beginTransaction()`'s own returned handle additionally carries
    //   `commit`/`rollback`/`isActive` (e.g. `createIsolatedTestDb()`'s
    //   per-test transaction, #2861 review Finding 3:
    //   `packages/vitest/src/__tests__/
    //   issue-2429-postgres-system-tables.optional.test.ts` hands one
    //   straight to `createDispatchBus`). That handle already *is* inside a
    //   transaction.
    // - Everything else that carries `transaction` alone and neither
    //   `commit` nor `rollback` is NOT necessarily already inside one.
    //   Issue #35's pre-existing contract
    //   (`packages/core/src/__tests__/
    //   issue-35-system-tables-initialization.test.ts`) requires a
    //   transaction-capable-but-idle adapter of exactly this shape to run
    //   its DDL through `db.transaction(cb)`, not directly against `db`.
    //   The callback argument of `db.transaction(cb)` itself (#2861 review
    //   recall: `class.ts`/`agent.ts` can reach this shape via `db: tx`)
    //   carries the identical shape while already being inside the
    //   enclosing transaction — `@happyvertical/sql` has no public marker
    //   for "this handle is already inside a transaction" to tell the two
    //   apart (upstream tracked: happyvertical/sdk#1249). Filed rather than
    //   silently widened further: opening via `db.transaction(cb)` serves
    //   both — for a genuinely idle handle it is an ordinary transaction
    //   (issue #35's contract), and for the callback-argument shape
    //   `@happyvertical/sql` documents that nesting re-enters the enclosing
    //   transaction under a `SAVEPOINT` on the same connection, so the DDL
    //   still runs against the one real transaction either way.
    const alreadyInTransaction =
      typeof (db as Partial<TransactionHandle>).commit === 'function' &&
      typeof (db as Partial<TransactionHandle>).rollback === 'function';

    if (!alreadyInTransaction) {
      // Capture on `db` *before* opening the nested scope: for the
      // callback-argument shape this reads the enclosing transaction's
      // current budget so it can be restored; for a genuinely idle handle
      // it reads the ambient session default, which the restore below then
      // harmlessly reapplies to the (about to end) fresh transaction.
      const priorLockTimeout = getQueryRows(
        await db.query('SHOW lock_timeout'),
      )[0]?.lock_timeout;
      const priorStatementTimeout = getQueryRows(
        await db.query('SHOW statement_timeout'),
      )[0]?.statement_timeout;
      return (db as TransactionCapableDatabase).transaction?.(
        async (tx): Promise<T> => {
          for (const sql of SYSTEM_TABLE_BOOTSTRAP_TIMEOUT_SQL) {
            await tx.query(sql);
          }
          await tx.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
          const result = await work(tx);
          // Restore only on success. On failure — DDL error or a timed-out
          // lock wait — the (sub)transaction is already aborted (PostgreSQL
          // 25P02: no statement but ROLLBACK/ROLLBACK TO SAVEPOINT is
          // accepted), so issuing `SET LOCAL` here would itself error and
          // replace the real failure. That path needs no explicit restore
          // anyway: `db.transaction(cb)` rolls back to the savepoint on a
          // thrown error, and `ROLLBACK TO SAVEPOINT` *does* undo `SET
          // LOCAL` (unlike the `RELEASE SAVEPOINT` success path this
          // restore guards against — confirmed directly against a live
          // PostgreSQL 17 instance).
          if (typeof priorLockTimeout === 'string') {
            await tx.query(`SET LOCAL lock_timeout = '${priorLockTimeout}'`);
          }
          if (typeof priorStatementTimeout === 'string') {
            await tx.query(
              `SET LOCAL statement_timeout = '${priorStatementTimeout}'`,
            );
          }
          return result;
        },
      );
    }

    // `pg_advisory_xact_lock` run directly against `db` here (no new
    // transaction, no savepoint) scopes to the transaction `db` is already
    // in and auto-releases only when *that* transaction commits or rolls
    // back — exactly like the branch above, which opens and promptly
    // commits its own. This matters for more than tidiness:
    //
    // - Wrapping `db`'s own `transaction()` (a savepoint) to take the lock
    //   was tried and reverted: PostgreSQL does not scope
    //   `pg_advisory_xact_lock`/`SET LOCAL` to a savepoint — both live for
    //   the rest of the *transaction* — so it leaked the lock hold and a
    //   raised timeout budget into the caller's transaction (confirmed:
    //   `SHOW lock_timeout` read back the raised `5min` budget instead of
    //   the caller's original value after `createDispatchBus()` returned).
    // - A session-scoped `pg_advisory_lock`/`pg_advisory_unlock` pair
    //   released right after `work()` was tried next and also reverted:
    //   releasing the lock before the caller's own transaction ends does
    //   not close the actual race — two callers each holding their own
    //   uncommitted transaction still deadlock on PostgreSQL's ordinary
    //   catalog lock for the not-yet-visible `CREATE TABLE`, entirely
    //   independent of our advisory lock, because that catalog lock is held
    //   until the *first* caller's transaction ends, not until it releases
    //   our lock (confirmed by direct reproduction).
    //
    // Taking the xact-scoped lock directly on `db` is the only scheme that
    // actually closes this: a second caller's lock acquisition blocks until
    // the first caller's transaction ends, by which point its DDL is either
    // committed (visible) or rolled back (gone) — no catalog-lock stall
    // either way.
    //
    // The wait for this lock still needs the same raised budget the
    // sibling branch above gives itself — every framework-owned connection
    // (`applyPostgresRuntimeTimeouts()`, wired into `SmrtClass`,
    // `createDispatchBus`'s own `getDatabase()` path, and the generators)
    // bakes a request-sized `lock_timeout=10000ms` into the connection by
    // default, so without a raise here a caller-owned transaction that
    // holds this lock for longer than 10s (concurrent callers now correctly
    // serialize on it — see the shapes above) would abort the *next*
    // waiter with "canceling statement due to lock timeout", reproducing
    // the #2861 symptom class through the timeout door instead of the
    // catalog-race door. Unlike the sibling branch, this one must not keep
    // the raise for the caller's remaining transaction: capture the
    // caller's current values first and restore them immediately after
    // acquiring the lock, before `work(db)` runs — the raise covers only
    // the wait PostgreSQL's own lock manager enforces, never the caller's
    // subsequent statements.
    const priorLockTimeout = getQueryRows(
      await db.query('SHOW lock_timeout'),
    )[0]?.lock_timeout;
    const priorStatementTimeout = getQueryRows(
      await db.query('SHOW statement_timeout'),
    )[0]?.statement_timeout;
    for (const sql of SYSTEM_TABLE_BOOTSTRAP_TIMEOUT_SQL) await db.query(sql);
    await db.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
    // Restore only after the lock is actually acquired. `db` here is the
    // caller's real top-level transaction, not a savepoint: if the wait
    // itself times out, PostgreSQL has already aborted that transaction
    // (25P02 — no statement but ROLLBACK is accepted until it ends), so a
    // `finally`-scoped restore would itself error and replace the real
    // lock-timeout failure with a confusing "transaction is aborted"
    // error. There is nothing to restore in that case either: the caller's
    // transaction never reaches `work()` and ends via rollback, which
    // discards the raised values along with everything else.
    if (typeof priorLockTimeout === 'string') {
      await db.query(`SET LOCAL lock_timeout = '${priorLockTimeout}'`);
    }
    if (typeof priorStatementTimeout === 'string') {
      await db.query(
        `SET LOCAL statement_timeout = '${priorStatementTimeout}'`,
      );
    }
    return work(db);
  }

  throw new Error(
    'Postgres system table bootstrap requires a transaction-capable database adapter',
  );
}

/**
 * Ensure every framework-owned SMRT system table exists before use.
 *
 * PostgreSQL provisioning is serialized in a bounded advisory-locked
 * transaction; other engines use the schema's idempotent DDL directly.
 */
export async function ensureSystemTables(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  await runSerializedAgainstSystemTableBootstrap(db, typeHint, (scopedDb) =>
    bootstrapSystemTables(scopedDb, typeHint),
  );
}
