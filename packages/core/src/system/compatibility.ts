import type { DatabaseInterface } from '@happyvertical/sql';
import { detectEngine } from '../schema/ddl/index.js';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
} from './schema.js';

type DatabaseWithConfig = DatabaseInterface & {
  config?: {
    type?: string;
    url?: string;
  };
  type?: string;
};

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }

  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as Record<string, unknown>[];
    }
  }

  return [];
}

export async function tableExists(
  db: DatabaseInterface,
  tableName: string,
  typeHint?: string,
): Promise<boolean> {
  try {
    const engine = getDatabaseEngine(db, typeHint);
    if (engine === 'postgres') {
      const result = await db.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1',
        tableName,
      );
      return getQueryRows(result).length > 0;
    }

    await db.query(`SELECT 1 FROM ${tableName} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function columnExists(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  typeHint?: string,
): Promise<boolean> {
  try {
    const engine = getDatabaseEngine(db, typeHint);
    if (engine === 'postgres') {
      const result = await db.query(
        'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1',
        tableName,
        columnName,
      );
      return getQueryRows(result).length > 0;
    }

    const result = await db.query(`PRAGMA table_info(${tableName})`);
    return getQueryRows(result).some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function getDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseWithConfig;
  return db.url || dbWithConfig.config?.url || '';
}

export function getDatabaseEngine(
  db: DatabaseInterface,
  typeHint?: string,
): ReturnType<typeof detectEngine> {
  const dbWithConfig = db as DatabaseWithConfig;
  return detectEngine(
    getDatabaseUrl(db),
    typeHint || dbWithConfig.type || dbWithConfig.config?.type,
  );
}

/**
 * Upgrade framework-owned PostgreSQL timestamp columns to instant-safe storage.
 *
 * Legacy SMRT and system writers serialized instants as UTC wall times. The
 * conversion is intentionally fail-closed unless the migration session is UTC:
 * operators must first confirm that historical database-default/raw writers
 * also used UTC. A deployment with non-UTC legacy writers needs an explicit,
 * provenance-aware data migration rather than a guessed offset.
 */
export interface PostgresSystemTimestampMigrationConfirmation {
  /**
   * Explicitly confirmed timezone used by every historical writer of legacy
   * timezone-naive system timestamps. Only UTC is supported by this helper.
   */
  legacyTimezone: 'UTC';
}

export interface PostgresSystemTimestampMigrationPlan {
  kind: 'column' | 'change-feed-function';
  tableName: string;
  columnName?: string;
  sql: string;
}

function quotePostgresIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Read-only plan for the framework-owned timestamp conversion. This is kept
 * separate from the atomic mutator so CLI dry-runs can report every ALTER
 * without bootstrapping or changing framework tables.
 */
export async function planPostgresSystemTimestampMigrations(
  db: DatabaseInterface,
  confirmation: PostgresSystemTimestampMigrationConfirmation,
  typeHint?: string,
): Promise<PostgresSystemTimestampMigrationPlan[]> {
  if (getDatabaseEngine(db, typeHint) !== 'postgres') return [];
  if (confirmation.legacyTimezone !== 'UTC') {
    throw new Error(
      'Legacy SMRT system timestamp migration requires an explicit UTC provenance confirmation',
    );
  }

  const sessionRows = getQueryRows(
    await db.query(`
      SELECT
        current_setting('TimeZone') AS timezone,
        to_regprocedure('${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}')
          IS NOT NULL AS legacy_change_feed_function_exists
    `),
  );
  const session = sessionRows[0] ?? {};
  const timezone = String(session.timezone ?? '').toUpperCase();
  if (!['UTC', 'ETC/UTC', 'GMT'].includes(timezone)) {
    throw new Error(
      `Refusing to preview legacy SMRT timestamp migration outside a UTC PostgreSQL session (current TimeZone: ${String(session.timezone ?? 'unknown')})`,
    );
  }

  const rows = getQueryRows(
    await db.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name LIKE '\\_smrt\\_%' ESCAPE '\\'
        AND data_type = 'timestamp without time zone'
      ORDER BY table_name, ordinal_position
    `),
  );

  const plans: PostgresSystemTimestampMigrationPlan[] = rows.map((row) => {
    const tableName = String(row.table_name);
    const columnName = String(row.column_name);
    const table = quotePostgresIdentifier(tableName);
    const column = quotePostgresIdentifier(columnName);
    return {
      kind: 'column',
      tableName,
      columnName,
      sql: `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE TIMESTAMPTZ USING ${column} AT TIME ZONE 'UTC'`,
    };
  });

  if (
    session.legacy_change_feed_function_exists === true ||
    session.legacy_change_feed_function_exists === 't' ||
    session.legacy_change_feed_function_exists === 'true' ||
    session.legacy_change_feed_function_exists === 1
  ) {
    plans.push({
      kind: 'change-feed-function',
      tableName: '_smrt_changes',
      sql: `DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};\n${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}`,
    });
  }

  return plans;
}

/**
 * Fail closed when framework-owned PostgreSQL tables still contain legacy
 * timezone-naive timestamps. Call this before recording the current system
 * schema version so a partial installation cannot be stamped as upgraded.
 */
export async function assertPostgresSystemTimestampsCurrent(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (getDatabaseEngine(db, typeHint) !== 'postgres') return;

  const rows = getQueryRows(
    await db.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name LIKE '\\_smrt\\_%' ESCAPE '\\'
        AND data_type = 'timestamp without time zone'
      ORDER BY table_name, ordinal_position
    `),
  );
  if (rows.length === 0) return;

  const columns = rows
    .map((row) => `${String(row.table_name)}.${String(row.column_name)}`)
    .join(', ');
  throw new Error(
    `Legacy SMRT system timestamps remain (${columns}); run the explicit audited migratePostgresSystemTimestamps() migration before bootstrap`,
  );
}

export async function migratePostgresSystemTimestamps(
  db: DatabaseInterface,
  confirmation: PostgresSystemTimestampMigrationConfirmation,
  typeHint?: string,
): Promise<void> {
  if (getDatabaseEngine(db, typeHint) !== 'postgres') return;
  if (confirmation.legacyTimezone !== 'UTC') {
    throw new Error(
      'Legacy SMRT system timestamp migration requires an explicit UTC provenance confirmation',
    );
  }

  // One server-side statement makes the catalog change atomic and holds the
  // same transaction-scoped lock used by system bootstrap. Any failing column
  // rolls back every preceding ALTER in the block.
  await db.query(`
    DO $smrt_migrate_system_timestamps$
    DECLARE
      target RECORD;
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext('smrt'),
        hashtext('system-tables')
      );
      IF upper(current_setting('TimeZone')) NOT IN ('UTC', 'ETC/UTC', 'GMT') THEN
        RAISE EXCEPTION 'Refusing to reinterpret legacy SMRT timestamps outside a UTC PostgreSQL session; confirm historical writers used UTC and SET TIME ZONE UTC';
      END IF;
      FOR target IN
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name LIKE '\\_smrt\\_%' ESCAPE '\\'
          AND data_type = 'timestamp without time zone'
        ORDER BY table_name, ordinal_position
      LOOP
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
          target.table_name,
          target.column_name,
          target.column_name
        );
      END LOOP;
      IF to_regprocedure('${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') IS NOT NULL THEN
        DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
        EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
      END IF;
    END;
    $smrt_migrate_system_timestamps$;
  `);
}

function isDuplicateColumnError(error: unknown): boolean {
  const message =
    error && typeof error === 'object'
      ? String((error as { message?: unknown }).message || error)
      : String(error);

  return (
    /column .*already exists/i.test(message) ||
    /duplicate column name/i.test(message)
  );
}

function collectErrorDetails(
  error: unknown,
  seen = new Set<unknown>(),
): {
  codes: Set<string>;
  messages: string[];
} {
  const codes = new Set<string>();
  const messages: string[] = [];

  if (!error || seen.has(error)) {
    return { codes, messages };
  }

  seen.add(error);

  if (typeof error === 'object') {
    const errorRecord = error as Record<string, unknown>;

    if (typeof errorRecord.code === 'string') {
      codes.add(errorRecord.code);
    }

    for (const messageKey of ['message', 'detail']) {
      if (typeof errorRecord[messageKey] === 'string') {
        messages.push(errorRecord[messageKey]);
      }
    }

    for (const nestedKey of ['cause', 'context', 'originalError']) {
      const nested = collectErrorDetails(errorRecord[nestedKey], seen);
      for (const code of nested.codes) {
        codes.add(code);
      }
      messages.push(...nested.messages);
    }
  } else {
    messages.push(String(error));
  }

  return { codes, messages };
}

function isDuplicateIndexRaceError(error: unknown, indexName: string): boolean {
  const { codes, messages } = collectErrorDetails(error);
  const message = messages.join('\n').toLowerCase();
  const normalizedIndexName = indexName.toLowerCase();
  const hasDuplicateCode =
    codes.has('23505') || /\bcode\s*=\s*23505\b/.test(message);
  const hasRelationExistsCode =
    codes.has('42P07') || /\bcode\s*=\s*42p07\b/i.test(message);

  if (!message.includes(normalizedIndexName)) {
    return false;
  }

  if (hasDuplicateCode && message.includes('pg_class_relname_nsp_index')) {
    return true;
  }

  if (hasRelationExistsCode && /relation .*already exists/i.test(message)) {
    return true;
  }

  return false;
}

async function addColumnIfMissing(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  definition: string,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);

  if (engine === 'postgres') {
    if (await columnExists(db, tableName, columnName, typeHint)) {
      return;
    }

    await db.query(
      `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`,
    );
    return;
  }

  if (await columnExists(db, tableName, columnName, typeHint)) {
    return;
  }

  try {
    await db.query(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
    );
  } catch (error) {
    if (isDuplicateColumnError(error)) {
      return;
    }

    throw error;
  }
}

async function indexExists(
  db: DatabaseInterface,
  indexName: string,
  typeHint?: string,
): Promise<boolean> {
  try {
    const engine = getDatabaseEngine(db, typeHint);
    if (engine === 'postgres') {
      const result = await db.query(
        'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1 LIMIT 1',
        indexName,
      );
      return getQueryRows(result).length > 0;
    }

    const result = await db.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1`,
      indexName,
    );
    return getQueryRows(result).length > 0;
  } catch {
    return false;
  }
}

async function addIndexIfMissing(
  db: DatabaseInterface,
  indexName: string,
  tableName: string,
  columnName: string,
  typeHint?: string,
): Promise<void> {
  if (await indexExists(db, indexName, typeHint)) {
    return;
  }

  try {
    await db.query(
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnName})`,
    );
  } catch (error) {
    if (isDuplicateIndexRaceError(error, indexName)) {
      if (await indexExists(db, indexName, typeHint)) {
        return;
      }
    }

    throw error;
  }
}

async function addUniqueIndexIfMissing(
  db: DatabaseInterface,
  indexName: string,
  tableName: string,
  columns: string,
  typeHint?: string,
): Promise<void> {
  if (await indexExists(db, indexName, typeHint)) {
    return;
  }

  try {
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columns})`,
    );
  } catch (error) {
    if (isDuplicateIndexRaceError(error, indexName)) {
      if (await indexExists(db, indexName, typeHint)) {
        return;
      }
    }

    throw error;
  }
}

/**
 * Migrate the legacy `UNIQUE(signal_type, subscriber)` subscription identity to
 * the tenant-scoped `UNIQUE(tenant_id, signal_type, subscriber)` (S5 #1398).
 *
 * The old identity let any tenant overwrite/delete/enable another tenant's
 * subscription because the natural key ignored the tenant. This:
 *   1. Creates the tenant-scoped unique index used by upsert conflict handling.
 *   2. Drops the legacy 2-column unique constraint:
 *      - **SQLite**: inline `UNIQUE(...)` constraints can't be dropped in place,
 *        so the table is rebuilt without it (data preserved). The legacy
 *        constraint surfaces as an auto-created `sqlite_autoindex_*` index.
 *      - **Postgres**: the inline constraint is dropped by its conventional
 *        name if present.
 *
 * Additive and idempotent: re-running is a no-op once migrated.
 */
async function migrateDispatchSubscriptionsIdentity(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);

  // 1. Tenant-scoped unique index (used by upsert's ON CONFLICT target).
  await addUniqueIndexIfMissing(
    db,
    'uq_smrt_dispatch_subs_tenant_signal_subscriber',
    '_smrt_dispatch_subscriptions',
    'tenant_id, signal_type, subscriber',
    typeHint,
  );

  // 2. Drop the legacy (signal_type, subscriber) uniqueness.
  if (engine === 'postgres') {
    // Inline table-level UNIQUE constraints get a conventional name. Drop it if
    // present; ignore if it was never created under that name.
    try {
      await db.query(
        'ALTER TABLE _smrt_dispatch_subscriptions DROP CONSTRAINT IF EXISTS _smrt_dispatch_subscriptions_signal_type_subscriber_key',
      );
    } catch {
      // Best-effort: a differently-named legacy constraint is left in place; the
      // tenant-scoped index above still enforces correct per-tenant identity.
    }
    return;
  }

  // SQLite: detect a legacy auto-index over exactly (signal_type, subscriber)
  // and, if found, rebuild the table without the inline UNIQUE.
  if (engine !== 'sqlite') {
    return;
  }

  let legacyAutoIndex: string | null = null;
  try {
    const result = await db.query(
      `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = '_smrt_dispatch_subscriptions'
           AND name LIKE 'sqlite_autoindex_%'`,
    );
    for (const row of getQueryRows(result)) {
      const indexName = String(row.name);
      const info = await db.query(`PRAGMA index_info(${indexName})`);
      const cols = getQueryRows(info)
        .map((r) => String(r.name))
        .sort();
      if (
        cols.length === 2 &&
        cols[0] === 'signal_type' &&
        cols[1] === 'subscriber'
      ) {
        legacyAutoIndex = indexName;
        break;
      }
    }
  } catch {
    // Unable to introspect → assume no legacy constraint (fresh tables created
    // from the new schema have none).
    legacyAutoIndex = null;
  }

  if (!legacyAutoIndex) {
    return;
  }

  // Rebuild the table without the inline UNIQUE(signal_type, subscriber).
  // System table is small; this runs once per legacy database.
  await db.query('PRAGMA foreign_keys=OFF');
  try {
    await db.query(`
      CREATE TABLE _smrt_dispatch_subscriptions_new (
        id TEXT PRIMARY KEY,
        signal_type TEXT NOT NULL,
        subscriber TEXT NOT NULL,
        handler TEXT NOT NULL DEFAULT 'handleDispatch',
        delivery TEXT NOT NULL DEFAULT 'compete',
        enabled INTEGER DEFAULT 1,
        tenant_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`
      INSERT INTO _smrt_dispatch_subscriptions_new
        (id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at)
      SELECT id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at
        FROM _smrt_dispatch_subscriptions
    `);
    await db.query('DROP TABLE _smrt_dispatch_subscriptions');
    await db.query(
      'ALTER TABLE _smrt_dispatch_subscriptions_new RENAME TO _smrt_dispatch_subscriptions',
    );
    // Recreate the secondary indexes (the rebuild dropped them) plus the
    // tenant-scoped unique index.
    await db.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_smrt_dispatch_subs_tenant_signal_subscriber ON _smrt_dispatch_subscriptions(tenant_id, signal_type, subscriber)',
    );
    await db.query(
      'CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_subscriber ON _smrt_dispatch_subscriptions(subscriber)',
    );
    await db.query(
      'CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_tenant_id ON _smrt_dispatch_subscriptions(tenant_id)',
    );
    await db.query(
      'CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_signal_type ON _smrt_dispatch_subscriptions(signal_type)',
    );
    await db.query(
      'CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_enabled ON _smrt_dispatch_subscriptions(enabled)',
    );
  } finally {
    await db.query('PRAGMA foreign_keys=ON');
  }
}

export async function ensureDispatchSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_dispatch', typeHint))) {
    return;
  }

  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'target_subscriber',
    'TEXT',
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'correlation_id',
    'TEXT',
    typeHint,
  );
  // Tenant isolation (S5 #1398): dispatches are scoped to the emitting
  // tenant context so a subscriber in tenant A cannot snoop/claim tenant B's
  // dispatches. Nullable so non-tenant (global) dispatches keep tenant_id NULL.
  await addColumnIfMissing(db, '_smrt_dispatch', 'tenant_id', 'TEXT', typeHint);
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_target',
    '_smrt_dispatch',
    'target_subscriber',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_correlation',
    '_smrt_dispatch',
    'correlation_id',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_tenant_id',
    '_smrt_dispatch',
    'tenant_id',
    typeHint,
  );
}

export async function ensureDispatchSubscriptionsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_dispatch_subscriptions', typeHint))) {
    return;
  }

  await addColumnIfMissing(
    db,
    '_smrt_dispatch_subscriptions',
    'delivery',
    "TEXT NOT NULL DEFAULT 'compete'",
    typeHint,
  );
  // Tenant isolation (S5 #1398): records the tenant context a subscription was
  // registered in. Nullable so global/non-tenant subscriptions keep it NULL.
  await addColumnIfMissing(
    db,
    '_smrt_dispatch_subscriptions',
    'tenant_id',
    'TEXT',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_subs_tenant_id',
    '_smrt_dispatch_subscriptions',
    'tenant_id',
    typeHint,
  );
  // Migrate the subscription natural key to (tenant_id, signal_type, subscriber)
  // so tenants can't clobber each other's subscriptions (S5 #1398).
  await migrateDispatchSubscriptionsIdentity(db, typeHint);
}

export async function ensureJobsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_jobs', typeHint))) {
    return;
  }

  await addColumnIfMissing(db, '_smrt_jobs', 'tenant_id', 'TEXT', typeHint);
  await addIndexIfMissing(
    db,
    'idx_smrt_jobs_tenant_id',
    '_smrt_jobs',
    'tenant_id',
    typeHint,
  );
  // MCP task support was added after `_smrt_jobs` had already shipped. Keep
  // the task projection in the job row so a task can never outlive (or lose
  // track of) the worker job that executes it. JSON is portable here because
  // SMRT's adapters serialize JSON fields to text where necessary.
  await addColumnIfMissing(db, '_smrt_jobs', 'task_id', 'TEXT', typeHint);
  await addColumnIfMissing(db, '_smrt_jobs', 'task_owner_id', 'TEXT', typeHint);
  await addColumnIfMissing(db, '_smrt_jobs', 'task_result', 'TEXT', typeHint);
  await addColumnIfMissing(
    db,
    '_smrt_jobs',
    'task_input_requests',
    'TEXT',
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_jobs',
    'task_input_responses',
    'TEXT',
    typeHint,
  );
  await addUniqueIndexIfMissing(
    db,
    'idx_smrt_jobs_task_id',
    '_smrt_jobs',
    'task_id',
    typeHint,
  );
}

export async function ensureJobEventsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_job_events', typeHint))) {
    return;
  }

  await addColumnIfMissing(
    db,
    '_smrt_job_events',
    'tenant_id',
    'TEXT',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_job_events_tenant_id',
    '_smrt_job_events',
    'tenant_id',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_job_events_job_id',
    '_smrt_job_events',
    'job_id',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_job_events_type',
    '_smrt_job_events',
    'type',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_job_events_created_at',
    '_smrt_job_events',
    'created_at',
    typeHint,
  );
}

export async function ensureLegacySystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  await ensureDispatchSystemTableCompatibility(db, typeHint);
  await ensureDispatchSubscriptionsSystemTableCompatibility(db, typeHint);
  await ensureJobsSystemTableCompatibility(db, typeHint);
  await ensureJobEventsSystemTableCompatibility(db, typeHint);
}
