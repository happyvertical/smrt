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
 * Ensure every framework-owned SMRT system table exists before use.
 *
 * PostgreSQL provisioning is serialized in a bounded advisory-locked
 * transaction; other engines use the schema's idempotent DDL directly.
 */
export async function ensureSystemTables(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (getDatabaseEngine(db, typeHint) !== 'postgres') {
    await bootstrapSystemTables(db, typeHint);
    return;
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
      await bootstrapSystemTables(tx, typeHint);
      await tx.commit();
      return;
    } catch (error) {
      await rollbackBootstrap(tx);
      throw error;
    }
  }

  if (typeof transaction === 'function') {
    await transaction.call(db, async (tx) => {
      for (const sql of SYSTEM_TABLE_BOOTSTRAP_TIMEOUT_SQL) await tx.query(sql);
      await tx.query(SYSTEM_TABLE_BOOTSTRAP_LOCK_SQL);
      await bootstrapSystemTables(tx, typeHint);
    });
    return;
  }

  throw new Error(
    'Postgres system table bootstrap requires a transaction-capable database adapter',
  );
}
