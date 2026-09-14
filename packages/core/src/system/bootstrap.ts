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

  if (transaction) {
    // `db` has `transaction()` but no `beginTransaction()`. For the one
    // PostgreSQL adapter this codebase ships and tests against
    // (`@happyvertical/sql`), every *fresh* top-level handle carries both
    // methods together (see `getDatabase()`'s returned object); the only
    // handles that carry `transaction` alone are ones `db` already *is*
    // inside — either `beginTransaction()`'s own returned handle (which
    // additionally carries `commit`/`rollback`/`isActive`, e.g.
    // `createIsolatedTestDb()`'s per-test transaction, #2861 review
    // Finding 3: `packages/vitest/src/__tests__/
    // issue-2429-postgres-system-tables.optional.test.ts` hands one straight
    // to `createDispatchBus`) or the callback argument of `db.transaction(cb)`
    // itself (which carries neither — #2861 review recall: `class.ts`/
    // `agent.ts` can reach this shape via `db: tx` inside such a callback).
    // Treating "has `transaction`, lacks `beginTransaction`" as "already
    // inside a transaction" is therefore exhaustive for this adapter, without
    // needing to separately probe for `commit`/`rollback`.
    //
    // A custom `DatabaseInterface` that implements only `transaction()` and
    // is *not* already inside one is a real, if currently unexercised, gap
    // this local heuristic cannot rule out — `@happyvertical/sql` has no
    // public marker for "this handle is already inside a transaction"
    // (upstream tracked: happyvertical/sdk#1249). Filed rather than silently
    // widened further.
    //
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
    // No `SET LOCAL` timeout raise here: that GUC change is exactly what
    // leaked before, and this branch must not touch the caller's session
    // timeouts. A lock wait that exceeds whatever `lock_timeout` the
    // caller's session already has fails closed with PostgreSQL's own
    // "canceling statement due to lock timeout" instead of hanging.
    await db.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
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
