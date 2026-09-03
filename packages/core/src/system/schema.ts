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

-- Retention predicate for pruneExpiredContexts() (#2375). Rows that never
-- expire carry NULL here, so the index only has to cover the ones that do.
CREATE INDEX IF NOT EXISTS idx_smrt_contexts_expires_at
  ON _smrt_contexts(expires_at);
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

-- Retention predicates of DispatchCollection.cleanup() (#2375): completed rows
-- are aged out on processed_at, failed rows on updated_at. The status-only
-- index above cannot serve either range.
CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_status_processed
  ON _smrt_dispatch(status, processed_at);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_status_updated
  ON _smrt_dispatch(status, updated_at);
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

-- Serves both the tenant-scoped retention predicate of pruneAiUsage() and the
-- subscriptions billing meter's tenant_id + created_at range scan, neither of
-- which the single-column indexes above can satisfy (#2375).
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_tenant_created
  ON _smrt_ai_usage(tenant_id, created_at);
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

/**
 * PostgreSQL-only staging table for change-feed appends made inside a
 * caller-managed transaction (issue #2649).
 *
 * `_smrt_changes.seq` is allocated `COALESCE(MAX(seq), 0) + 1`, so two
 * concurrent appends contend on the same primary-key value and the loser
 * *waits for the winner's transaction to end*. When the winner is a long write
 * transaction that goes on to take row locks the loser already holds, that
 * wait closes a genuine lock cycle and PostgreSQL aborts one side with
 * `40P01` — an ordinary concurrent request killing a legitimate long write.
 *
 * The staging table breaks the cycle by removing the wait: an append issued
 * inside a caller transaction inserts here instead, where its identity value
 * conflicts with nothing and it never waits on another transaction. The row is
 * still fate-shared with the caller (a rollback removes it, exactly as
 * before). A later *drain* — {@link CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION}
 * — moves committed staged rows into `_smrt_changes` with contiguous
 * sequences, so the feed's cursor guarantee is unchanged.
 *
 * PostgreSQL-only on purpose: SQLite and DuckDB do not reach the defect
 * (SQLite serializes writers outright), and keeping the portable DDL untouched
 * keeps the embedded path byte-identical.
 */
export const CREATE_POSTGRES_SMRT_CHANGES_PENDING_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_changes_pending (
  pending_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT,
  operation TEXT NOT NULL,
  tenant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smrt_changes_pending_table
  ON _smrt_changes_pending(table_name);
`;

/** Name of the PostgreSQL staging table for deferred change-feed appends. */
export const POSTGRES_CHANGE_FEED_PENDING_TABLE = '_smrt_changes_pending';

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
 * Body marker stamped into both PostgreSQL change-feed helpers (#2649).
 *
 * Existence is not currency: an install can hold a helper of the right name
 * and signature whose *body* predates a fix. The probe in `change-feed.ts`
 * matches this token against `pg_proc.prosrc`, so a stale body is detected and
 * replaced. Bump it whenever either helper's body changes in a way an existing
 * database must pick up.
 */
export const POSTGRES_CHANGE_FEED_HELPER_MARKER = 'smrt-change-feed-helpers:v2';

/** PostgreSQL helper that sequences staged change-feed appends (#2649). */
export const POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME = '_smrt_drain_changes';

/** Exact PostgreSQL identity used for catalog lookup of the drain helper. */
export const POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(integer)`;

/** How many staged entries one drain call sequences. */
export const POSTGRES_CHANGE_FEED_DRAIN_BATCH = 1000;

/**
 * PostgreSQL-only drain: move committed staged appends into `_smrt_changes`.
 *
 * This is where the feed's sequence is actually allocated for entries written
 * inside a caller transaction. It runs in its own short transaction (an
 * autocommit append's, or a reader's `drainChangeFeed()` call), holds no user
 * row locks, and never waits on another transaction:
 *
 * - it only ever sees *committed* staged rows — an in-flight transaction's
 *   staged row is invisible under MVCC, so the drain neither reads nor locks
 *   it, and it is picked up by a later drain once that transaction commits;
 * - concurrent drains are excluded by a `pg_try_advisory_xact_lock`, which
 *   *skips* rather than waits, so a drain can never become an edge in a lock
 *   cycle either.
 *
 * Because exactly one drain runs at a time and it numbers rows
 * `COALESCE(MAX(seq), 0) + row_number()` in staged order, committed sequences
 * stay contiguous and no reader can observe seq N before seq N-1 — the change
 * feed's cursor guarantee is preserved verbatim (see `change-feed.ts`).
 *
 * Failures are returned as data, like the append helper, so a drain problem
 * never aborts the caller's transaction. A failed drain leaves the staged rows
 * in place for the next attempt.
 */
export const CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(
  p_limit INTEGER DEFAULT ${POSTGRES_CHANGE_FEED_DRAIN_BATCH}
)
RETURNS TABLE(
  drained_seq BIGINT,
  drained_table TEXT,
  drained_row_id TEXT,
  drained_operation TEXT,
  drained_tenant_id TEXT,
  error_code TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $smrt_change_feed_drain$
-- ${POSTGRES_CHANGE_FEED_HELPER_MARKER}
DECLARE
  v_base BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  IF to_regclass('_smrt_changes_pending') IS NULL THEN
    RETURN;
  END IF;

  -- Never sequence from inside a transaction that has already written. Doing
  -- so would hold freshly allocated sequences uncommitted for the rest of that
  -- transaction, which is precisely the wait edge #2649 removes — a reader
  -- calling getChangesSince() inside a long write transaction must not put it
  -- back. The staged rows keep for the next drain.
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RETURN;
  END IF;

  -- Cheap common case: nothing staged, so an autocommit append pays one
  -- index probe rather than a drain.
  IF NOT EXISTS (SELECT 1 FROM _smrt_changes_pending LIMIT 1) THEN
    RETURN;
  END IF;

  -- Try, never wait: a drain that waited could become an edge in a cycle.
  IF NOT pg_try_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('change-feed-drain')
  ) THEN
    RETURN;
  END IF;

  BEGIN
    SELECT COALESCE(MAX(changes.seq), 0) INTO v_base FROM _smrt_changes AS changes;

    RETURN QUERY
    WITH removed AS (
      DELETE FROM _smrt_changes_pending AS pending
      WHERE pending.pending_id IN (
        SELECT candidate.pending_id
        FROM _smrt_changes_pending AS candidate
        ORDER BY candidate.pending_id
        LIMIT GREATEST(COALESCE(p_limit, ${POSTGRES_CHANGE_FEED_DRAIN_BATCH}), 1)
      )
      RETURNING
        pending.pending_id,
        pending.table_name,
        pending.row_id,
        pending.operation,
        pending.tenant_id,
        pending.created_at
    ),
    numbered AS (
      SELECT
        removed.*,
        v_base + row_number() OVER (ORDER BY removed.pending_id) AS new_seq
      FROM removed
    ),
    inserted AS (
      INSERT INTO _smrt_changes (
        seq,
        table_name,
        row_id,
        operation,
        tenant_id,
        created_at
      )
      SELECT
        numbered.new_seq,
        numbered.table_name,
        numbered.row_id,
        numbered.operation,
        numbered.tenant_id,
        numbered.created_at
      FROM numbered
      RETURNING
        _smrt_changes.seq,
        _smrt_changes.table_name,
        _smrt_changes.row_id,
        _smrt_changes.operation,
        _smrt_changes.tenant_id
    )
    SELECT
      inserted.seq,
      inserted.table_name,
      inserted.row_id,
      inserted.operation,
      inserted.tenant_id,
      NULL::TEXT,
      NULL::TEXT
    FROM inserted
    ORDER BY inserted.seq;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT
      NULL::BIGINT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      v_error_code,
      v_error_message;
  END;
END;
$smrt_change_feed_drain$;
`;

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
-- ${POSTGRES_CHANGE_FEED_HELPER_MARKER}
DECLARE
  v_seq BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
  v_deferred BOOLEAN;
BEGIN
  -- Has the caller already written in this transaction?
  --
  -- PostgreSQL assigns a transaction id at the first write, so a non-NULL
  -- pg_current_xact_id_if_assigned() means the caller may be holding row
  -- locks. Allocating the feed head here would then make a concurrent appender
  -- wait for this whole transaction to end — the wait edge that closes the
  -- #2649 cycle. An autocommit append reports NULL: its caller's row write
  -- committed as its own statement, so it holds no row locks and its inline
  -- allocation cannot be part of a cycle. (Requires PostgreSQL 13+.)
  --
  -- This is exactly the condition that makes a cycle possible, not an
  -- approximation of "inside BEGIN": a transaction that appends *before* its
  -- first write still allocates inline, but it holds no row locks at that
  -- moment, so nothing that waits on its feed row can also be waited on by it.
  v_deferred := pg_current_xact_id_if_assigned() IS NOT NULL
    AND to_regclass('_smrt_changes_pending') IS NOT NULL;

  IF v_deferred THEN
    BEGIN
      -- Staged, not sequenced: an identity value conflicts with nothing, so
      -- this insert never waits on another transaction. It stays fate-shared
      -- with the caller (rollback removes it) and is moved into
      -- _smrt_changes, in order and with a contiguous sequence, by the next
      -- drain after the caller commits.
      INSERT INTO _smrt_changes_pending (
        table_name,
        row_id,
        operation,
        tenant_id,
        created_at
      )
      VALUES (
        p_table_name,
        p_row_id,
        p_operation,
        p_tenant_id,
        p_created_at
      );

      -- NULL sequence with NULL error code is the staged marker.
      RETURN QUERY SELECT NULL::BIGINT, NULL::TEXT, NULL::TEXT;
      RETURN;
    EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
      GET STACKED DIAGNOSTICS
        v_error_code = RETURNED_SQLSTATE,
        v_error_message = MESSAGE_TEXT;
      RETURN QUERY SELECT NULL::BIGINT, v_error_code, v_error_message;
      RETURN;
    END;
  END IF;

  -- Autocommit append. The caller's own row write already committed as its own
  -- statement, so this transaction holds no user row locks and allocating the
  -- head here cannot join a lock cycle.
  --
  -- This deliberately does NOT drain: a drain performed here would sequence
  -- staged entries that the JavaScript caller never sees, so no live SSE
  -- signal would be published for them while this append's own signal carries
  -- a HIGHER sequence -- and an EventSource that stores that id as its
  -- Last-Event-ID resumes above them and never receives them. Draining is
  -- driven from JavaScript (drainChangeFeed) so every sequenced entry gets
  -- its signal.
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

const POSTGRES_CHANGE_FEED_PENDING_DDL =
  CREATE_POSTGRES_SMRT_CHANGES_PENDING_TABLE.split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map(
      (statement) => `EXECUTE $smrt_change_feed_pending_ddl$
${statement}
$smrt_change_feed_pending_ddl$;`,
    )
    .join('\n');

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
${POSTGRES_CHANGE_FEED_PENDING_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  EXECUTE $smrt_change_feed_drain_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_ddl$;
  EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
END;
$smrt_replace_change_feed$;
`;

/**
 * Install the PostgreSQL helpers only when missing, serialized server-side.
 *
 * A client-side catalog probe remains the fast path for already-initialized
 * read handles. This guarded statement is the cold-path race boundary: both
 * the advisory lock and the post-lock catalog check run before function DDL.
 *
 * The staging table and the drain helper (#2649) are created unconditionally
 * (`IF NOT EXISTS` / `CREATE OR REPLACE`) because an install that already has
 * the append helper from an older SMRT may still be missing them; the append
 * helper itself is replaced when the staging table was absent, which is how an
 * upgraded database picks up the deferring version.
 */
export const ENSURE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION = `
DO $smrt_ensure_change_feed$
DECLARE
  v_append_stale BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('system-tables')
  );
  v_append_stale := to_regclass('${POSTGRES_CHANGE_FEED_PENDING_TABLE}') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_proc
      WHERE oid = to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}')
        AND prosrc LIKE '%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%'
    );
${POSTGRES_CHANGE_FEED_PENDING_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  EXECUTE $smrt_change_feed_drain_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_ddl$;
  IF v_append_stale THEN
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
DECLARE
  v_append_stale BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('smrt'),
    hashtext('system-tables')
  );
  v_append_stale := to_regclass('${POSTGRES_CHANGE_FEED_PENDING_TABLE}') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_proc
      WHERE oid = to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}')
        AND prosrc LIKE '%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%'
    );
${POSTGRES_CHANGE_FEED_SCHEMA_DDL}
${POSTGRES_CHANGE_FEED_PENDING_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
  EXECUTE $smrt_change_feed_drain_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_ddl$;
  IF v_append_stale THEN
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
 * PostgreSQL and DuckDB also materialize integer storage as BIGINT, matching
 * application-table DDL; SQLite keeps its variable-width INTEGER.
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
  const integerDdl =
    engine === 'postgres' || engine === 'duckdb' || engine === 'json'
      ? ddl.replace(/\bINTEGER\b/g, 'BIGINT')
      : ddl;
  return engine === 'postgres'
    ? integerDdl.replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ')
    : integerDdl;
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
 * 1.10.1 retires the never-written `_smrt_registry` / `_smrt_signals` tables
 * (see {@link RETIRED_SYSTEM_TABLES}) and adds the retention-predicate indexes
 * from #2375 (`_smrt_contexts.expires_at`, `_smrt_ai_usage(tenant_id,
 * created_at)`, `_smrt_dispatch(status, processed_at)` and
 * `(status, updated_at)`) in the same replay. (`1.10.0` briefly existed only
 * on two unreleased, unmerged branches with two different, incompatible DDL
 * sets — never published, never stamped in any real `_smrt_migrations` table
 * — so merging them reuses no version an existing install could have already
 * recorded; see the note on {@link SMRT_SCHEMA_DDL_CHECKSUMS}.)
 */
export const SMRT_SCHEMA_VERSION = '1.10.1';

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
 * that key is the bump. This is also why merging two branches that each
 * independently bumped to the same version string (both `1.10.0`, covering two
 * different DDL sets — #2376's table retirement and #2375's retention indexes)
 * must land under a *new* key rather than picking a "final" checksum for the
 * shared number: nothing published or otherwise reachable ever stamped
 * `1.10.0`, so recording the merged DDL as `1.10.1` costs nothing and removes
 * any doubt about a version string meaning two different things to two
 * installs.
 *
 * Entries before 1.10.1 are not recorded — the guard starts here.
 */
export const SMRT_SCHEMA_DDL_CHECKSUMS: Readonly<Record<string, string>> =
  Object.freeze({
    '1.10.1':
      'f796ee3b3f7ab8b9dc659ecaa68884ec01277408c3dd6edea540853fce369c16',
  });
