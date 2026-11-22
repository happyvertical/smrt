import type { DatabaseInterface } from '@happyvertical/sql';
import { usesPostgresDialect } from '../embedded-write-queue.js';
import { detectEngine } from '../schema/ddl/index.js';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_SMRT_AI_EVALUATIONS_TABLE,
  CREATE_SMRT_AI_RUNS_TABLE,
  getSystemTableDDLForEngine,
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
  if (!typeHint && usesPostgresDialect(db)) return 'postgres';
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

/**
 * A tenant id column added to an existing system table: native uuid on
 * PostgreSQL, like fresh system DDL and every application `tenant_id`
 * (#3297); TEXT elsewhere.
 */
function tenantIdColumnType(db: DatabaseInterface, typeHint?: string): string {
  return getDatabaseEngine(db, typeHint) === 'postgres' ? 'UUID' : 'TEXT';
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

/** @param columns - One column, or a comma-separated list for a composite index. */
async function addIndexIfMissing(
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
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columns})`,
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
 * Read a PostgreSQL `text[]` result as a JS array.
 *
 * `attname` is `name`-typed, and drivers that have no parser registered for
 * the resulting array OID hand back the raw literal (`{a,b}`) instead. Reading
 * that as "no columns" would silently make every index look like it covers
 * nothing — and, for #2376's reconciliation, would recreate an index that
 * already exists. The query casts to `text` and this parses either shape.
 */
function parsePostgresTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value !== 'string') {
    return [];
  }
  const literal = value.trim();
  if (!literal.startsWith('{') || !literal.endsWith('}')) {
    return [];
  }
  const body = literal.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }
  return body
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0);
}

/** One live index as reported by the engine's catalog. */
interface LiveIndex {
  name: string;
  unique: boolean;
  columns: string[];
  /** True when the index carries a WHERE predicate (partial index). */
  partial: boolean;
}

/**
 * Read the live indexes of a table, including the implicit ones a UNIQUE
 * column constraint creates (`sqlite_autoindex_*`, PostgreSQL's `*_key`).
 *
 * PostgreSQL and SQLite only. Returns `null` on DuckDB and the JSON adapter,
 * whose catalogs report constraint-backed uniqueness somewhere other than the
 * index list (`duckdb_constraints()` rather than `duckdb_indexes()`) — reading
 * one without the other would report "no unique index" for a column that has
 * one. Callers must treat `null` as "unknown" and keep their pre-existing
 * behaviour rather than guess: leaving a redundant index in place is a cost,
 * dropping the only one that enforces an upsert conflict target is a bug.
 */
async function listTableIndexes(
  db: DatabaseInterface,
  tableName: string,
  typeHint?: string,
): Promise<LiveIndex[] | null> {
  const engine = getDatabaseEngine(db, typeHint);

  try {
    if (engine === 'postgres') {
      const result = await db.query(
        `SELECT
           i.relname AS name,
           ix.indisunique AS is_unique,
           (ix.indpred IS NOT NULL) AS is_partial,
           ARRAY(
             SELECT a.attname::text
             FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a
               ON a.attrelid = t.oid AND a.attnum = k.attnum
             ORDER BY k.ord
           ) AS columns
         FROM pg_class t
         JOIN pg_index ix ON ix.indrelid = t.oid
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = current_schema() AND t.relname = $1`,
        tableName,
      );
      return getQueryRows(result).map((row) => ({
        name: String(row.name),
        unique: row.is_unique === true || row.is_unique === 't',
        partial: row.is_partial === true || row.is_partial === 't',
        columns: parsePostgresTextArray(row.columns),
      }));
    }

    if (engine !== 'sqlite') {
      return null;
    }

    const listed = getQueryRows(
      await db.query(`PRAGMA index_list(${tableName})`),
    );
    const indexes: LiveIndex[] = [];
    for (const row of listed) {
      const name = String(row.name);
      const info = getQueryRows(await db.query(`PRAGMA index_info(${name})`));
      indexes.push({
        name,
        unique: row.unique === 1 || row.unique === true || row.unique === '1',
        partial:
          row.partial === 1 || row.partial === true || row.partial === '1',
        columns: info.map((column) => String(column.name)),
      });
    }
    return indexes;
  } catch {
    return null;
  }
}

/** Drop an index, tolerating engines/permissions that refuse the statement. */
async function dropIndexIfExists(
  db: DatabaseInterface,
  indexName: string,
  typeHint?: string,
): Promise<void> {
  if (!(await indexExists(db, indexName, typeHint))) {
    return;
  }

  try {
    await db.query(`DROP INDEX IF EXISTS ${indexName}`);
  } catch {
    // Best-effort: a redundant index is a cost, not a correctness problem.
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

  // Copy only the columns the legacy table actually has. The rebuild used to
  // name all nine unconditionally, so a database predating any one of them
  // failed the whole bootstrap with a bare `no such column` (issue #2376).
  // Columns absent from the source take the new table's default.
  const legacyColumns = new Set(
    getQueryRows(
      await db.query('PRAGMA table_info(_smrt_dispatch_subscriptions)'),
    ).map((row) => String(row.name)),
  );
  const copiedColumns = [
    'id',
    'signal_type',
    'subscriber',
    'handler',
    'delivery',
    'enabled',
    'tenant_id',
    'created_at',
    'updated_at',
  ].filter((column) => legacyColumns.has(column));
  const copiedColumnList = copiedColumns.join(', ');

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
        (${copiedColumnList})
      SELECT ${copiedColumnList}
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
  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'tenant_id',
    tenantIdColumnType(db, typeHint),
    typeHint,
  );
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
  // Dispatch lease (schema 1.22.0): nullable, so existing rows need no
  // rewrite. The columns come first so the paging indexes over them can be
  // created here (the bus initialize path) and by the bootstrap DDL replay.
  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'lease_token',
    'TEXT',
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'claimed_until',
    timestampColumnType(db, typeHint),
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_dispatch',
    'max_attempts',
    integerColumnType(db, typeHint),
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_status_created_id',
    '_smrt_dispatch',
    'status, created_at, id',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_status_claimed_id',
    '_smrt_dispatch',
    'status, claimed_until, id',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_status_updated_id',
    '_smrt_dispatch',
    'status, updated_at, id',
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
    tenantIdColumnType(db, typeHint),
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

/** Compat-owned unique index over `_smrt_jobs(task_id)`. */
const JOBS_TASK_ID_COMPAT_INDEX = 'idx_smrt_jobs_task_id';

/**
 * Reconcile the two owners of `_smrt_jobs(task_id)` uniqueness (issue #2376).
 *
 * `SmrtJob.taskId` is declared `unique: true`, so a table created from the
 * jobs manifest already carries a constraint-backed unique index. Legacy
 * databases got the column from `addColumnIfMissing()` instead, and
 * `ALTER TABLE ADD COLUMN ... UNIQUE` is rejected by SQLite and DuckDB — so
 * those databases need this compat index and only this compat index.
 *
 * Creating it unconditionally left every manifest-created table with two
 * unique indexes on one column. Create it only when nothing else already
 * enforces the uniqueness, and drop it when something does.
 *
 * Known limitation: this reconciliation is PostgreSQL/SQLite-only. DuckDB and
 * the JSON adapter give {@link listTableIndexes} no usable answer, so those
 * installs keep the redundant index — deliberately, because the alternative is
 * guessing and possibly leaving the upsert conflict target unenforced.
 */
async function reconcileJobsTaskIdUniqueness(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  const indexes = await listTableIndexes(db, '_smrt_jobs', typeHint);

  if (indexes === null) {
    // Engine catalog not readable here — keep the historical behaviour rather
    // than risk leaving the upsert conflict target unenforced.
    await addUniqueIndexIfMissing(
      db,
      JOBS_TASK_ID_COMPAT_INDEX,
      '_smrt_jobs',
      'task_id',
      typeHint,
    );
    return;
  }

  // A partial unique index does not enforce uniqueness over the whole table,
  // so it can never stand in for the compat index.
  const otherUniqueOnTaskId = indexes.some(
    (index) =>
      index.unique &&
      !index.partial &&
      index.name !== JOBS_TASK_ID_COMPAT_INDEX &&
      index.columns.length === 1 &&
      index.columns[0] === 'task_id',
  );

  if (otherUniqueOnTaskId) {
    await dropIndexIfExists(db, JOBS_TASK_ID_COMPAT_INDEX, typeHint);
    return;
  }

  await addUniqueIndexIfMissing(
    db,
    JOBS_TASK_ID_COMPAT_INDEX,
    '_smrt_jobs',
    'task_id',
    typeHint,
  );
}

export async function ensureJobsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_jobs', typeHint))) {
    return;
  }

  await addColumnIfMissing(
    db,
    '_smrt_jobs',
    'tenant_id',
    tenantIdColumnType(db, typeHint),
    typeHint,
  );
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
  await reconcileJobsTaskIdUniqueness(db, typeHint);
  // Retention predicate of SmrtJobCollection.cleanup() (#2375): terminal jobs
  // aged out by `(status, completed_at)`. `_smrt_jobs` comes from a decorated
  // class rather than the hand-written system DDL, so this compatibility path
  // — which the jobs collection runs on every initialize — is where the index
  // reaches both existing and freshly migrated databases. `completed_at` is
  // guarded the same as every other column this pass touches: a table created
  // before the field existed (or a minimal test fixture) must not fail the
  // whole sweep with "no such column".
  await addColumnIfMissing(
    db,
    '_smrt_jobs',
    'completed_at',
    'TIMESTAMP',
    typeHint,
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_jobs_status_completed_at',
    '_smrt_jobs',
    'status, completed_at',
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
    tenantIdColumnType(db, typeHint),
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

/**
 * Compatibility pass for the tables `db:migrate` creates from the jobs
 * manifest rather than `bootstrapSystemTables()` (issue #2376).
 *
 * These are dual-owned, and on a *fresh* install the manifest wins the race:
 * bootstrap runs first, finds no `_smrt_jobs`, returns early, stamps the
 * system schema version — and every later boot takes the version fast path, so
 * the columns and indexes this pass owns never appeared on that database at
 * all. Splitting the pass out lets the caller re-check it after the tables
 * show up, independently of the system schema version.
 *
 * @returns `settled: true` once every deferred table exists and has been
 * upgraded — the point at which a caller may stop re-checking. `false` means
 * the tables are not there yet, not that anything failed.
 */
export async function ensureDeferredSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<{ settled: boolean }> {
  // Sequential, never `Promise.all`: a caller can hand us one shared
  // single-statement connection (the OIDC provisioning coordinator does), and
  // two probes in flight at once overlap on it.
  const jobsExists = await tableExists(db, '_smrt_jobs', typeHint);
  const jobEventsExists = await tableExists(db, '_smrt_job_events', typeHint);

  if (jobsExists) {
    await ensureJobsSystemTableCompatibility(db, typeHint);
  }
  if (jobEventsExists) {
    await ensureJobEventsSystemTableCompatibility(db, typeHint);
  }

  return { settled: jobsExists && jobEventsExists };
}

/**
 * A TIMESTAMP column added to an existing system table, rendered as the
 * system DDL renders it (`TIMESTAMPTZ` on PostgreSQL).
 */
function timestampColumnType(db: DatabaseInterface, typeHint?: string): string {
  return getDatabaseEngine(db, typeHint) === 'postgres'
    ? 'TIMESTAMPTZ'
    : 'TIMESTAMP';
}

/** An INTEGER column added to an existing system table (BIGINT off SQLite). */
function integerColumnType(db: DatabaseInterface, typeHint?: string): string {
  return getDatabaseEngine(db, typeHint) === 'sqlite' ? 'INTEGER' : 'BIGINT';
}

/**
 * The columns of `_smrt_ai_usage` that older installs lack, with their types:
 * prompt-run observability (#4751), the transcript `call_id` (#4780) and the
 * run model (#5005): the entry call id, the prompt version and the workflow
 * step, step instance and attempt of the call.
 */
function aiUsageAddedColumns(
  db: DatabaseInterface,
  typeHint?: string,
): [string, string][] {
  const integer = integerColumnType(db, typeHint);
  return [
    ['prompt_key', 'TEXT'],
    ['tier_requested', 'TEXT'],
    ['tier_resolved', 'TEXT'],
    ['run_id', 'TEXT'],
    ['call_id', 'TEXT'],
    ['entry_call_id', 'TEXT'],
    ['template_hash', 'TEXT'],
    ['step_index', integer],
    ['step_name', 'TEXT'],
    ['step_instance_id', 'TEXT'],
    ['attempt', integer],
  ];
}

/**
 * Columns on `_smrt_ai_usage`: the prompt-run observability columns (#4751),
 * the transcript `call_id` (#4780) and the run-model columns (#5005).
 *
 * New columns are nullable, so existing rows keep NULL, except the call id
 * split: a usage row's `id` is its call id, and the shared fusion or
 * transcript id that `call_id` used to hold moves to `entry_call_id` (a row
 * that had none is its own entry call). That is one UPDATE,
 * `entry_call_id = call_id` then `call_id = id`, of the rows whose
 * `entry_call_id` is NULL (every writer since sets it, so a second run finds
 * nothing and writes nothing; a row an older process wrote after the upgrade
 * is split on the next bootstrap pass). The old `call_id` index goes first:
 * the replay creates its replacement on `entry_call_id`, and an update of an
 * indexed column is not safe on every engine (DuckDB). Each ALTER is guarded
 * by a column-existence probe on every engine, and must run before the DDL
 * replay because its `CREATE INDEX` clauses reference the new columns.
 */
export async function ensureAiUsageSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_ai_usage', typeHint))) {
    return;
  }

  for (const [column, definition] of aiUsageAddedColumns(db, typeHint)) {
    await addColumnIfMissing(
      db,
      '_smrt_ai_usage',
      column,
      definition,
      typeHint,
    );
  }
  await dropIndexIfExists(db, 'idx_smrt_ai_usage_call', typeHint);
  // Every writer since #5005 sets `entry_call_id`, so a NULL marks exactly
  // the rows still to split; the probe uses idx_smrt_ai_usage_entry_call
  // once it exists, and the update runs only when it finds one. That index
  // goes first (the replay recreates it) because the update writes the
  // column it covers.
  const unsplit = await db.query(
    'SELECT id FROM _smrt_ai_usage WHERE entry_call_id IS NULL LIMIT 1',
  );
  if (getQueryRows(unsplit).length > 0) {
    await dropIndexIfExists(db, 'idx_smrt_ai_usage_entry_call', typeHint);
    await db.query(
      `UPDATE _smrt_ai_usage
          SET entry_call_id = COALESCE(call_id, id), call_id = id
        WHERE entry_call_id IS NULL`,
    );
  }
  // `_smrt_ai_usage_outcomes` (#4751) gains `call_id` with #4780; a 1.13.0 or
  // 1.14.0 install has the table without it. It is carried into
  // `_smrt_ai_evaluations` by ensureAiEvaluationsSystemTableCompatibility().
  if (await tableExists(db, '_smrt_ai_usage_outcomes', typeHint)) {
    await addColumnIfMissing(
      db,
      '_smrt_ai_usage_outcomes',
      'call_id',
      'TEXT',
      typeHint,
    );
  }
}

/** Old `_smrt_ai_runs` column to new column, for the one-time rebuild. */
const AI_RUNS_REBUILD_COPY: [string, string][] = [
  ['id', 'id'],
  ['fusion_key', 'definition_key'],
  ['tenant_id', 'tenant_id'],
  ['class_name', 'class_name'],
  ['prompt_key', 'prompt_key'],
  ['status', 'status'],
  ['duration', 'duration'],
  ['mode', 'mode'],
  ['seats', 'seats'],
  ['degraded_seats', 'degraded_seats'],
  ['details', 'details'],
  ['created_at', 'created_at'],
];

/**
 * `created_at` minus `duration` milliseconds, for an old run row: runs were
 * written when the fusion ended, so the start is derived. Falls back to
 * `created_at` itself when the arithmetic yields NULL.
 */
function aiRunStartedAtSql(engine: ReturnType<typeof detectEngine>): string {
  if (engine === 'postgres') {
    return `COALESCE(created_at - (duration * INTERVAL '1 millisecond'), created_at)`;
  }
  if (engine === 'sqlite') {
    return `COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-' || (duration / 1000.0) || ' seconds'), created_at)`;
  }
  return `COALESCE(created_at - (duration * INTERVAL 1 MILLISECOND), created_at)`;
}

/**
 * Run table shape and status vocabulary (#5005).
 *
 * `_smrt_ai_runs` was written for fusions only: `fusion_key`, and `mode`,
 * `seats` and `degraded_seats` NOT NULL. The run model needs the key renamed
 * and those three nullable for runs that are not fusions, so the table is
 * rebuilt once, as `_smrt_dispatch_subscriptions` was: create the new shape,
 * copy the rows, drop the old table, rename. The step runs only while the
 * table still has `fusion_key`, and a rebuild interrupted after the old table
 * was dropped is finished from the leftover `_smrt_ai_runs_new`. Indexes are
 * left to the DDL replay that follows, which creates them on the new table.
 * On PostgreSQL a table that still has legacy timezone-naive timestamps is not
 * touched: the audited timestamp migration has to convert it first, and the
 * bootstrap fails closed until it has.
 *
 * Then one idempotent UPDATE moves the stored fusion statuses to the run
 * vocabulary: `ok` becomes `done`; `degraded` becomes `done` with `degraded`
 * set; a `failed` row without a `stop_reason` gets `error`. Old rows are
 * typed `fusion` with `finished_at = created_at` and `started_at` derived.
 *
 * A table created in an early 1.17.0 shape gains `stop_detail` and
 * `retry_of_run_id`, and its REAL cost columns (and the events'
 * `reserved_cost`) become DOUBLE PRECISION on PostgreSQL and DuckDB.
 */
export async function ensureAiRunsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);
  const hasRuns = await tableExists(db, '_smrt_ai_runs', typeHint);
  const hasRebuilt = await tableExists(db, '_smrt_ai_runs_new', typeHint);

  if (!hasRuns && hasRebuilt) {
    await finishAiRunsRebuild(db, engine);
  } else if (
    hasRuns &&
    (await columnExists(db, '_smrt_ai_runs', 'fusion_key', typeHint))
  ) {
    if (
      engine === 'postgres' &&
      (await postgresColumnIsTimezoneNaive(db, '_smrt_ai_runs', 'created_at'))
    ) {
      return;
    }
    await db.query('DROP TABLE IF EXISTS _smrt_ai_runs_new');
    const createNew = getSystemTableDDLForEngine(
      CREATE_SMRT_AI_RUNS_TABLE.split(';')[0] ?? '',
      engine,
    ).replace('_smrt_ai_runs', '_smrt_ai_runs_new');
    await db.query(createNew);
    const legacy = AI_RUNS_REBUILD_COPY.filter(
      ([from]) => from !== 'created_at',
    );
    await db.query(
      `INSERT INTO _smrt_ai_runs_new
         (type, ${legacy.map(([, to]) => to).join(', ')}, created_at,
          started_at, finished_at)
       SELECT 'fusion', ${legacy.map(([from]) => from).join(', ')}, created_at,
              ${aiRunStartedAtSql(engine)}, created_at
         FROM _smrt_ai_runs`,
    );
    await db.query('DROP TABLE _smrt_ai_runs');
    await finishAiRunsRebuild(db, engine);
  }

  if (!(await tableExists(db, '_smrt_ai_runs', typeHint))) return;
  // A table first created in the 1.17.0 shape before `stop_detail`,
  // `retry_of_run_id` and the double-precision cost columns.
  await addColumnIfMissing(
    db,
    '_smrt_ai_runs',
    'stop_detail',
    'TEXT',
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_ai_runs',
    'retry_of_run_id',
    'TEXT',
    typeHint,
  );
  for (const column of AI_RUN_DOUBLE_COLUMNS) {
    await widenRealColumn(db, '_smrt_ai_runs', column, typeHint);
  }
  if (await tableExists(db, '_smrt_ai_run_events', typeHint)) {
    await widenRealColumn(db, '_smrt_ai_run_events', 'reserved_cost', typeHint);
  }
  await db.query(
    `UPDATE _smrt_ai_runs
        SET degraded = CASE WHEN status = 'degraded' THEN 1 ELSE degraded END,
            stop_reason = CASE
              WHEN status = 'failed' AND stop_reason IS NULL THEN 'error'
              ELSE stop_reason END,
            status = CASE WHEN status IN ('ok', 'degraded') THEN 'done' ELSE status END
      WHERE status IN ('ok', 'degraded')
         OR (status = 'failed' AND stop_reason IS NULL)`,
  );
}

/** The accumulating cost columns of `_smrt_ai_runs`, DOUBLE PRECISION. */
const AI_RUN_DOUBLE_COLUMNS = ['cost_used', 'inclusive_cost', 'reserved_cost'];

/**
 * Change a 32-bit REAL column to DOUBLE PRECISION on PostgreSQL and DuckDB.
 * SQLite stores REAL as an 8-byte float already, so it is left alone. A
 * column that is already double (or missing) is not touched, so the step is
 * idempotent.
 */
async function widenRealColumn(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);
  if (engine === 'postgres') {
    const rows = getQueryRows(
      await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1 AND column_name = $2`,
        tableName,
        columnName,
      ),
    );
    if (rows[0]?.data_type !== 'real') return;
    await db.query(
      `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE DOUBLE PRECISION`,
    );
    return;
  }
  if (engine !== 'duckdb') return;
  const rows = getQueryRows(await db.query(`PRAGMA table_info(${tableName})`));
  const type = String(
    rows.find((row) => row.name === columnName)?.type ?? '',
  ).toUpperCase();
  if (type !== 'FLOAT' && type !== 'REAL' && type !== 'FLOAT4') return;
  // DuckDB refuses to alter a table its indexes depend on; the DDL replay
  // that follows the compatibility pass recreates them.
  const indexes = getQueryRows(
    await db.query(
      `SELECT index_name FROM duckdb_indexes() WHERE table_name = $1`,
      tableName,
    ),
  );
  for (const row of indexes) {
    await db.query(`DROP INDEX IF EXISTS ${String(row.index_name)}`);
  }
  await db.query(
    `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE DOUBLE`,
  );
}

async function finishAiRunsRebuild(
  db: DatabaseInterface,
  engine: ReturnType<typeof detectEngine>,
): Promise<void> {
  await db.query('ALTER TABLE _smrt_ai_runs_new RENAME TO _smrt_ai_runs');
  if (engine === 'postgres') {
    // The primary key keeps the name it was created under.
    await db.query(
      'ALTER INDEX IF EXISTS _smrt_ai_runs_new_pkey RENAME TO _smrt_ai_runs_pkey',
    );
  }
}

async function postgresColumnIsTimezoneNaive(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = getQueryRows(
    await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1 AND column_name = $2`,
      tableName,
      columnName,
    ),
  );
  return rows[0]?.data_type === 'timestamp without time zone';
}

/**
 * `_smrt_ai_usage_outcomes` becomes `_smrt_ai_evaluations` (#5005).
 *
 * Creates the evaluations table, copies each label across and drops the old
 * table, so the step runs only while the old table exists, and a copy that
 * was interrupted is finished by the `NOT EXISTS` guard. Targets follow the
 * label's old columns: a `usage_id` is the call (`call_id = usage_id`); a
 * label with only a `call_id` goes to the call whose `entry_call_id` matches,
 * or to the run those calls share when several match (a fusion), or, when
 * several match without a shared run, to the latest of them; a label with only
 * a `run_id` goes to the run. A label that named both a usage row and a run
 * keeps the usage row. `score` becomes `value` (`value_type` `number`, no
 * scale), `actor` becomes `evaluator` unchanged and `metric` is `outcome`.
 * It must follow ensureAiUsageSystemTableCompatibility(), which fills
 * `entry_call_id`.
 */
export async function ensureAiEvaluationsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_ai_usage_outcomes', typeHint))) {
    return;
  }
  const engine = getDatabaseEngine(db, typeHint);
  for (const statement of getSystemTableDDLForEngine(
    CREATE_SMRT_AI_EVALUATIONS_TABLE,
    engine,
  )
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean)) {
    await db.query(statement);
  }
  await addColumnIfMissing(
    db,
    '_smrt_ai_usage_outcomes',
    'call_id',
    'TEXT',
    typeHint,
  );
  const hasUsage = await tableExists(db, '_smrt_ai_usage', typeHint);
  const matches = (select: string) =>
    `(SELECT ${select} FROM _smrt_ai_usage u WHERE u.entry_call_id = o.call_id)`;
  const matchCount = matches('COUNT(*)');
  const callTarget = hasUsage
    ? `CASE
         WHEN o.usage_id IS NOT NULL THEN o.usage_id
         WHEN o.run_id IS NOT NULL THEN NULL
         WHEN o.call_id IS NULL THEN NULL
         WHEN ${matchCount} = 0 THEN o.call_id
         WHEN ${matchCount} = 1 OR ${matches('COUNT(u.run_id)')} < ${matchCount}
           OR ${matches('COUNT(DISTINCT u.run_id)')} <> 1
           THEN (SELECT u.id FROM _smrt_ai_usage u
                  WHERE u.entry_call_id = o.call_id
                  ORDER BY u.created_at DESC, u.id DESC LIMIT 1)
         ELSE NULL END`
    : `CASE WHEN o.usage_id IS NOT NULL THEN o.usage_id
            WHEN o.run_id IS NULL THEN o.call_id ELSE NULL END`;
  const runTarget = hasUsage
    ? `CASE
         WHEN o.usage_id IS NOT NULL THEN NULL
         WHEN o.run_id IS NOT NULL THEN o.run_id
         WHEN o.call_id IS NULL THEN NULL
         WHEN ${matchCount} > 1 AND ${matches('COUNT(u.run_id)')} = ${matchCount}
           AND ${matches('COUNT(DISTINCT u.run_id)')} = 1
           THEN ${matches('MIN(u.run_id)')}
         ELSE NULL END`
    : `CASE WHEN o.usage_id IS NULL THEN o.run_id ELSE NULL END`;
  await db.query(
    `INSERT INTO _smrt_ai_evaluations
       (id, call_id, run_id, metric, value, value_type, label, evidence,
        evaluator, tenant_id, created_at)
     SELECT o.id, ${callTarget}, ${runTarget}, 'outcome',
            CASE WHEN o.score IS NULL THEN NULL ELSE CAST(o.score AS TEXT) END,
            'number', o.label, o.evidence, o.actor, o.tenant_id, o.created_at
       FROM _smrt_ai_usage_outcomes o
      WHERE NOT EXISTS (SELECT 1 FROM _smrt_ai_evaluations e WHERE e.id = o.id)`,
  );
  await db.query('DROP TABLE _smrt_ai_usage_outcomes');
}

/**
 * `_smrt_migrate_runs` (1.16.0, #4926) gains `recomputes` with 1.16.1 (#5018)
 * and `confirmed_retirements` (the retirements a run dropped over a confirmed
 * definition mismatch, #5005) with 1.18.0. An older install has the table
 * without them, and `CREATE TABLE IF NOT EXISTS` never adds them. Both are
 * nullable, so older rows and older writers stay valid.
 */
export async function ensureMigrateRunsSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_migrate_runs', typeHint))) return;
  await addColumnIfMissing(
    db,
    '_smrt_migrate_runs',
    'recomputes',
    'TEXT',
    typeHint,
  );
  await addColumnIfMissing(
    db,
    '_smrt_migrate_runs',
    'confirmed_retirements',
    'TEXT',
    typeHint,
  );
}

/**
 * The compatibility pass that must precede replaying system DDL.
 *
 * Only the tables `bootstrapSystemTables()` itself creates belong here: an
 * older install can be missing a column that the DDL's `CREATE INDEX` clauses
 * reference, so those tables have to be reshaped first, inside the same
 * transaction as the replay.
 *
 * The deferred tables are deliberately NOT part of this pass. They are owned by
 * the jobs manifest, not by the system DDL, so nothing in the replay depends on
 * them — and reshaping a table the framework does not own must not be able to
 * abort the bootstrap transaction and roll back system-table creation with it
 * (issue #2376). {@link ensureDeferredSystemTableCompatibility} runs outside
 * the lock instead.
 */
export async function ensureBootstrapSystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  await ensureMigrateRunsSystemTableCompatibility(db, typeHint);
  await ensureDispatchSystemTableCompatibility(db, typeHint);
  await ensureDispatchSubscriptionsSystemTableCompatibility(db, typeHint);
  await ensureAiUsageSystemTableCompatibility(db, typeHint);
  await ensureAiRunsSystemTableCompatibility(db, typeHint);
  await ensureAiEvaluationsSystemTableCompatibility(db, typeHint);
}

/**
 * Run every compatibility pass — the bootstrap tables and the deferred,
 * manifest-created ones.
 *
 * This is the convenience entry point for callers that own the whole database
 * lifecycle in one step (test-database setup). Framework bootstrap deliberately
 * does not use it: see {@link ensureBootstrapSystemTableCompatibility}.
 */
export async function ensureLegacySystemTableCompatibility(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  await ensureBootstrapSystemTableCompatibility(db, typeHint);
  await ensureDeferredSystemTableCompatibility(db, typeHint);
}
