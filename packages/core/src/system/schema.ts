/**
 * SMRT System Tables Schema
 *
 * System tables use _smrt_ prefix to avoid conflicts with user tables.
 * All system tables are created in the same database as user data.
 */

import type { DatabaseEngine } from '../schema/ddl/types.js';

/**
 * Context memory storage
 * Stores remembered context (learned strategies, patterns, selectors) for reuse
 */
export const CREATE_SMRT_CONTEXTS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_contexts (
  id TEXT PRIMARY KEY,
  owner_class TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  metadata TEXT,
  version INTEGER DEFAULT 1,
  confidence REAL DEFAULT 1.0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  UNIQUE(owner_class, owner_id, scope, key, version)
);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_owner
  ON _smrt_contexts(owner_class, owner_id);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_scope
  ON _smrt_contexts(scope);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_confidence
  ON _smrt_contexts(confidence);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_last_used
  ON _smrt_contexts(last_used_at);
`;

/**
 * Schema version tracking
 * Records which SMRT framework versions have been applied
 */
export const CREATE_SMRT_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_migrations (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  checksum TEXT
);
`;

/**
 * Schema migration tracking
 * Tracks applied schema migrations for idempotency, audit, and rollback
 */
export const CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_checksum TEXT,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  execution_time_ms INTEGER,
  package_name TEXT,
  source_file TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  attempts INTEGER DEFAULT 0,
  is_reversible INTEGER DEFAULT 1,
  rolled_back_at TIMESTAMP,
  applied_by TEXT,
  batch INTEGER
);

CREATE INDEX IF NOT EXISTS idx_smrt_schema_migrations_status
  ON _smrt_schema_migrations(status);

CREATE INDEX IF NOT EXISTS idx_smrt_schema_migrations_applied_at
  ON _smrt_schema_migrations(applied_at);

CREATE INDEX IF NOT EXISTS idx_smrt_schema_migrations_batch
  ON _smrt_schema_migrations(batch);
`;

/**
 * Embedding storage for semantic search
 * Stores embedding vectors for SMRT objects to enable vector similarity search
 */
export const CREATE_SMRT_EMBEDDINGS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_embeddings (
  id TEXT PRIMARY KEY,
  object_class TEXT NOT NULL,
  object_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  provider TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(object_class, object_id, field_name, model)
);

CREATE INDEX IF NOT EXISTS idx_smrt_embeddings_object
  ON _smrt_embeddings(object_class, object_id);

CREATE INDEX IF NOT EXISTS idx_smrt_embeddings_class
  ON _smrt_embeddings(object_class);

CREATE INDEX IF NOT EXISTS idx_smrt_embeddings_hash
  ON _smrt_embeddings(content_hash);

CREATE INDEX IF NOT EXISTS idx_smrt_embeddings_model
  ON _smrt_embeddings(model);
`;

/**
 * Dispatch queue for inter-agent communication
 * Stores dispatch messages for asynchronous agent-to-agent signaling
 */
export const CREATE_SMRT_DISPATCH_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_dispatch (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMP,
  processed_by TEXT,
  target_subscriber TEXT,
  correlation_id TEXT,
  tenant_id TEXT,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_status
  ON _smrt_dispatch(status);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_tenant_id
  ON _smrt_dispatch(tenant_id);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_type
  ON _smrt_dispatch(type);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_source
  ON _smrt_dispatch(source);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_created
  ON _smrt_dispatch(created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_target
  ON _smrt_dispatch(target_subscriber);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_correlation
  ON _smrt_dispatch(correlation_id);
`;

/**
 * Dispatch subscriptions for persistent handlers
 * Stores subscriptions to dispatch types for agent processing
 */
export const CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_dispatch_subscriptions (
  id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  subscriber TEXT NOT NULL,
  handler TEXT NOT NULL DEFAULT 'handleDispatch',
  delivery TEXT NOT NULL DEFAULT 'compete',
  enabled INTEGER DEFAULT 1,
  tenant_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Subscription identity is tenant-scoped (S5 #1398): the same
-- (signal_type, subscriber) pair may exist independently in different tenants,
-- so tenant B can no longer overwrite/delete/enable tenant A's subscription.
-- A named UNIQUE index (rather than an inline UNIQUE constraint) is used so the
-- compatibility migration can additively reshape existing tables. NULL tenant_id
-- (global subscriptions) is deduped at the application layer by the NULL-aware
-- upsert in @happyvertical/sql.
CREATE UNIQUE INDEX IF NOT EXISTS uq_smrt_dispatch_subs_tenant_signal_subscriber
  ON _smrt_dispatch_subscriptions(tenant_id, signal_type, subscriber);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_subscriber
  ON _smrt_dispatch_subscriptions(subscriber);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_tenant_id
  ON _smrt_dispatch_subscriptions(tenant_id);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_signal_type
  ON _smrt_dispatch_subscriptions(signal_type);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_enabled
  ON _smrt_dispatch_subscriptions(enabled);
`;

/**
 * AI usage telemetry storage
 * Stores normalized AI usage records for reporting and billing hooks
 */
export const CREATE_SMRT_AI_USAGE_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost REAL,
  duration INTEGER NOT NULL,
  class_name TEXT,
  tenant_id TEXT,
  tags TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_created
  ON _smrt_ai_usage(created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_class
  ON _smrt_ai_usage(class_name);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_tenant
  ON _smrt_ai_usage(tenant_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_provider_model
  ON _smrt_ai_usage(provider, model);
`;

/**
 * Append-only change feed (issue #1758)
 *
 * One row per framework save/delete: monotonic per-database sequence,
 * table, row id, operation (create/update/delete — deletes are tombstones),
 * tenant, timestamp. Written by the change-feed interceptor and read
 * through `getChangesSince()`.
 *
 * `seq` is deliberately a plain BIGINT PRIMARY KEY rather than a native
 * AUTOINCREMENT/identity/serial column: the appender allocates
 * `COALESCE(MAX(seq), 0) + 1` inside the INSERT (with a conflict retry),
 * which keeps committed sequences contiguous so commit order equals
 * sequence order on every engine. Native identity columns allocate before
 * commit, so under concurrent writers on MVCC engines a reader could
 * observe seq N+1 while seq N is still uncommitted and advance its cursor
 * past it — breaking the feed's no-missed-changes cursor guarantee. The
 * plain column also keeps this DDL portable across SQLite, Postgres and
 * DuckDB with no per-engine branching. See `change-feed.ts`.
 *
 * `row_id` is nullable: manual bumps (`bumpChangeFeed`) may record a
 * table-level change without a specific row.
 */
export const CREATE_SMRT_CHANGES_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_changes (
  seq BIGINT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT,
  operation TEXT NOT NULL,
  tenant_id TEXT,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smrt_changes_table_seq
  ON _smrt_changes(table_name, seq);

CREATE INDEX IF NOT EXISTS idx_smrt_changes_tenant_seq
  ON _smrt_changes(tenant_id, seq);

CREATE INDEX IF NOT EXISTS idx_smrt_changes_created_at
  ON _smrt_changes(created_at);
`;

/** PostgreSQL materialization of the portable change-feed table DDL. */
export const CREATE_POSTGRES_SMRT_CHANGES_TABLE =
  CREATE_SMRT_CHANGES_TABLE.replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ');

/** PostgreSQL helper used to isolate best-effort feed appends (#2026). */
export const POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME = '_smrt_append_change';

/** Legacy helper identity used before PostgreSQL Date values became instants. */
export const LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(text,text,text,text,timestamp without time zone)`;

/** Exact PostgreSQL identity used for catalog lookup of the append helper. */
export const POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(text,text,text,text,timestamp with time zone)`;

/**
 * PostgreSQL-only change-feed append function.
 *
 * A PL/pgSQL block with an EXCEPTION handler runs its body in an internal
 * subtransaction. Returning SQLSTATE as data lets the caller log or retry a
 * failed best-effort append without leaving its surrounding transaction in
 * PostgreSQL's aborted (25P02) state. This statement contains dollar-quoted
 * semicolons, so callers must execute it whole rather than adding it to
 * {@link ALL_SYSTEM_TABLES}, whose portable DDL entries are semicolon-split.
 */
export const CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(
  p_table_name TEXT,
  p_row_id TEXT,
  p_operation TEXT,
  p_tenant_id TEXT,
  p_created_at TIMESTAMPTZ
)
RETURNS TABLE(
  allocated_seq BIGINT,
  error_code TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $smrt_change_feed$
DECLARE
  v_seq BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    INSERT INTO _smrt_changes (
      seq,
      table_name,
      row_id,
      operation,
      tenant_id,
      created_at
    )
    SELECT
      COALESCE(MAX(changes.seq), 0) + 1,
      p_table_name,
      p_row_id,
      p_operation,
      p_tenant_id,
      p_created_at
    FROM _smrt_changes AS changes
    RETURNING _smrt_changes.seq INTO v_seq;

    RETURN QUERY SELECT v_seq, NULL::TEXT, NULL::TEXT;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::BIGINT, v_error_code, v_error_message;
  END;
END;
$smrt_change_feed$;
`;

/**
 * Serialize PostgreSQL helper replacement inside one server-side statement.
 *
 * The transaction-scoped advisory lock prevents concurrent bootstraps from
 * racing on PostgreSQL's `pg_proc` uniqueness constraint. The nested dollar
 * quote keeps the complete function DDL atomic from the client's perspective.
 */
export const REPLACE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION = `
DO $smrt_replace_change_feed$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('system-tables')
  );
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
END;
$smrt_replace_change_feed$;
`;

/**
 * Install the PostgreSQL helper only when missing, serialized server-side.
 *
 * A client-side catalog probe remains the fast path for already-initialized
 * read handles. This guarded statement is the cold-path race boundary: both
 * the advisory lock and the post-lock catalog check run before function DDL.
 */
export const ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION = `
DO $smrt_ensure_change_feed$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('system-tables')
  );
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  IF to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') IS NULL THEN
    EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
  END IF;
END;
$smrt_ensure_change_feed$;
`;

const POSTGRES_CHANGE_FEED_SCHEMA_DDL =
  CREATE_POSTGRES_SMRT_CHANGES_TABLE.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(
      (statement) => `EXECUTE $smrt_change_feed_schema_ddl$
${statement}
$smrt_change_feed_schema_ddl$;`,
    )
    .join('\n');

/**
 * Install the complete PostgreSQL change-feed schema under the bootstrap lock.
 *
 * The lock is deliberately acquired before table or index DDL. Framework
 * bootstrap uses the same ordering, so a raw-handle cold start cannot retain
 * catalog locks while waiting behind a framework bootstrap transaction.
 */
export const ENSURE_POSTGRES_CHANGE_FEED_SCHEMA = `
DO $smrt_ensure_change_feed_schema$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('system-tables')
  );
${POSTGRES_CHANGE_FEED_SCHEMA_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  IF to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') IS NULL THEN
    EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
  END IF;
END;
$smrt_ensure_change_feed_schema$;
`;

/**
 * Data backfill tracking
 *
 * Distinct from `_smrt_schema_migrations` — backfills are app-specific
 * data corrections (slug rewrites, model splits, lookup-table seeds) that
 * don't have schema diffs or rollback semantics. Apps register backfills
 * by name and the tracker handles idempotency.
 */
export const CREATE_SMRT_BACKFILLS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_backfills (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  package_name TEXT
);
`;

/**
 * All system table creation statements
 */
export const ALL_SYSTEM_TABLES = [
  CREATE_SMRT_CONTEXTS_TABLE,
  CREATE_SMRT_MIGRATIONS_TABLE,
  CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
  CREATE_SMRT_BACKFILLS_TABLE,
  CREATE_SMRT_EMBEDDINGS_TABLE,
  CREATE_SMRT_DISPATCH_TABLE,
  CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE,
  CREATE_SMRT_AI_USAGE_TABLE,
  CREATE_SMRT_CHANGES_TABLE,
];

/**
 * Framework-owned tables that are backed by `@smrt()` models rather than by
 * {@link ALL_SYSTEM_TABLES}, and whose write volume disqualifies them from the
 * change feed.
 *
 * This is the jobs runner's own state: the claim loop and the forge projection
 * poll every second and rewrite these rows several times per job, so feeding
 * them into an append-only log whose pruning is not scheduled (issue #2375)
 * would dominate it with data no client syncs.
 *
 * The list is deliberately short and biased toward *observing*. A table wrongly
 * excluded is an invisible bug — exactly the one issue #2376 fixes — while a
 * table wrongly included costs a few extra feed rows. Everything else keeping
 * the `_smrt_` prefix (feature flags, prompt overrides, subscription plans,
 * field policies, agent and report schedules, report state) is observed.
 */
export const FRAMEWORK_OPERATIONAL_TABLES: readonly string[] = [
  '_smrt_jobs',
  '_smrt_job_events',
  '_smrt_workers',
  '_smrt_forge_deliveries',
  '_smrt_forge_projection_checkpoints',
];

/**
 * Framework tables that are backed by `@smrt()` models *and* reshaped by
 * `system/compatibility.ts`.
 *
 * They are dual-owned: `db:migrate` creates them from the jobs manifest, and
 * the compatibility pass adds columns/indexes that predate the manifest. On a
 * fresh install the manifest wins the race — bootstrap runs before the tables
 * exist — so their compatibility pass is deferred and re-checked until the
 * tables show up (issue #2376).
 */
export const DEFERRED_COMPATIBILITY_TABLES: readonly string[] = [
  '_smrt_jobs',
  '_smrt_job_events',
];

/**
 * System tables SMRT used to create on every database and no longer does.
 *
 * `_smrt_signals` never had a writer and `_smrt_registry` was only written by
 * an `ObjectRegistry.persistToDatabase()` helper that nothing ever called, so
 * both were empty on every deployment. New databases no longer get them.
 * Existing databases keep the empty tables until an operator drops them:
 *
 * ```sql
 * DROP TABLE IF EXISTS _smrt_signals;
 * DROP TABLE IF EXISTS _smrt_registry;
 * ```
 *
 * The framework deliberately does not issue those drops itself — dropping a
 * table is not reversible and a deployment may have repurposed the name.
 */
export const RETIRED_SYSTEM_TABLES: readonly string[] = [
  '_smrt_registry',
  '_smrt_signals',
];

/**
 * Materialize the portable system-table schema for a target engine.
 *
 * PostgreSQL must use TIMESTAMPTZ because every system Date is an instant.
 * Other engines keep the established portable TIMESTAMP declarations.
 */
export function getSystemTableDDL(engine: DatabaseEngine): string[] {
  return ALL_SYSTEM_TABLES.map((ddl) =>
    getSystemTableDDLForEngine(ddl, engine),
  );
}

/** Materialize one portable system-table statement for a target engine. */
export function getSystemTableDDLForEngine(
  ddl: string,
  engine: DatabaseEngine,
): string {
  return engine === 'postgres'
    ? ddl.replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ')
    : ddl;
}

/**
 * Current SMRT system schema version.
 *
 * `bootstrapSystemTables()` skips replaying system DDL once this exact version
 * is recorded in `_smrt_migrations`, so every change to {@link ALL_SYSTEM_TABLES}
 * must bump it — otherwise existing databases never see the change. New
 * *columns* additionally need an `addColumnIfMissing()` entry in
 * `system/compatibility.ts`, because `CREATE TABLE IF NOT EXISTS` is a no-op on
 * a table that already exists.
 *
 * 1.10.0 retires the never-written `_smrt_registry` / `_smrt_signals` tables
 * (see {@link RETIRED_SYSTEM_TABLES}).
 */
export const SMRT_SCHEMA_VERSION = '1.10.0';

/**
 * Canonical form of the system DDL that {@link SMRT_SCHEMA_DDL_CHECKSUMS} covers.
 *
 * Whitespace is normalized so reformatting alone does not trip the guard while
 * any token change does.
 */
export function getSystemSchemaChecksumInput(): string {
  return ALL_SYSTEM_TABLES.join('\n').replace(/\s+/g, ' ').trim();
}

/**
 * SHA-256 of {@link getSystemSchemaChecksumInput} for each system schema
 * version, oldest first.
 *
 * The discipline that keeps fresh installs and upgraded installs identical was
 * documented but unenforced (issue #2376): a contributor could edit the DDL and
 * ship it without bumping the version, and no existing database would ever
 * apply the change. `system-schema-evolution.test.ts` recomputes the current
 * hash and requires it to equal this map's entry for
 * {@link SMRT_SCHEMA_VERSION}.
 *
 * It is a *history*, not a single constant, so the guard cannot be silenced by
 * overwriting one value: every recorded hash must stay distinct, which means a
 * changed DDL has nowhere to be recorded except under a new version key. Adding
 * that key is the bump.
 *
 * Entries before 1.10.0 are not recorded — the guard starts here.
 */
export const SMRT_SCHEMA_DDL_CHECKSUMS: Readonly<Record<string, string>> =
  Object.freeze({
    '1.10.0':
      '1b6eeae73bc9ce2278e62525ce5f75c754d99b679c40a725ccf8461a96cfab4c',
  });
