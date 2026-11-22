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
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prompt_key TEXT,
  tier_requested TEXT,
  tier_resolved TEXT,
  run_id TEXT,
  call_id TEXT,
  entry_call_id TEXT,
  template_hash TEXT,
  step_index INTEGER,
  step_name TEXT,
  step_instance_id TEXT,
  attempt INTEGER
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

-- Prompt-run observability (#4751): prompt_key, tier_requested, tier_resolved
-- and run_id are lifted from the promptKey / tierRequested / tierResolved /
-- runId usage tags (tags keeps the full copy). Existing databases receive the
-- columns from ensureAiUsageSystemTableCompatibility() before this replays.
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_prompt_key
  ON _smrt_ai_usage(prompt_key, created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_run
  ON _smrt_ai_usage(run_id);

-- AI runs (#5005): id is the call id, so a call is found by primary key and
-- call_id carries no index of its own. entry_call_id is the id the entry call
-- shares across its alias-chain and fusion calls, the one a transcript's
-- call_id holds. The index is non-unique on purpose.
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_entry_call
  ON _smrt_ai_usage(entry_call_id);
`;

/**
 * Evaluations of AI calls and runs (#5005; the outcome labels of #4751).
 *
 * A run cannot rate itself: whether an answer was any good is known later, by
 * a person, the app or an automated grader, and is recorded then by
 * `recordAiEvaluation()`. An evaluation attaches to exactly one call
 * (`call_id`, the `_smrt_ai_usage.id` of the call) or exactly one run
 * (`run_id`), never both. `value` holds the measure as text, read through
 * `value_type` (`number`, `boolean` or `text`) and the optional `scale`
 * (for example `0..1`). `evaluator` is `human`, `app` or
 * `grader:<name>@<version>`. Neither target is a foreign key: `pruneAiUsage()`
 * deletes usage rows on its own schedule and must never be blocked by, or
 * cascade into, the evaluations.
 *
 * Replaces `_smrt_ai_usage_outcomes`; existing labels are carried over by
 * `ensureAiRunsSystemTableCompatibility()`.
 */
export const CREATE_SMRT_AI_EVALUATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_evaluations (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  run_id TEXT,
  metric TEXT NOT NULL,
  value TEXT,
  value_type TEXT NOT NULL DEFAULT 'number',
  scale TEXT,
  label TEXT,
  evidence TEXT,
  evaluator TEXT NOT NULL,
  tenant_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_evaluations_call
  ON _smrt_ai_evaluations(call_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_evaluations_run
  ON _smrt_ai_evaluations(run_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_evaluations_tenant_created
  ON _smrt_ai_evaluations(tenant_id, created_at);
`;

/**
 * AI run records (#4753, widened by #5005).
 *
 * One row per run, of any type (`fusion`, `turn`, `workflow` or an app's own
 * namespaced type): what ran (`type`, `definition_key`, `definition_version`,
 * the entry call's `prompt_key` and `template_hash`), who started it
 * (`owner_id`, `parent_run_id`; `retry_of_run_id` for a retry of a failed
 * run), how it stands (`status`: running | waiting-approval | stopped |
 * cancelled | failed | done; `degraded`; the typed `stop_reason`, such as
 * `max_tokens` or `interrupted`; `stopped_by_run_id`; `stop_detail`, JSON
 * describing a budget stop), its `budget` as JSON and its totals.
 * `tokens`, `cost_used`, `calls`, `uncosted_calls`, `steps_used` and
 * `duration` are the run's own; the `inclusive_*` totals add every descendant
 * run; `reserved_*` is room held for calls in flight, descendants included.
 * `checks_*` and `approvals_*` are the counts saved when the trajectory is
 * pruned. `mode`, `seats`, `degraded_seats` and `details` stay fusion-only
 * and are NULL for other types. Flags are INTEGER 0/1 (system tables store
 * flags that way, like `_smrt_ai_transcripts.truncated`). `created_at` is the
 * insert time its indexes and retention read. The accumulating cost columns
 * (`cost_used`, `inclusive_cost`, `reserved_cost`) are DOUBLE PRECISION:
 * REAL is 32-bit on PostgreSQL and DuckDB, and a total added to call by call
 * would drift.
 *
 * Each call's own `_smrt_ai_usage` row carries the run's id in `run_id`; that
 * is not a foreign key, for the same retention reason as the evaluations.
 * `tenant_id` matches `_smrt_ai_usage.tenant_id` (TEXT). `status` has no
 * index: it is always read beside a definition key or a window.
 *
 * The table was rebuilt once from the fusion-only shape (`fusion_key`, NOT
 * NULL `mode`, `seats`, `degraded_seats`) by
 * `ensureAiRunsSystemTableCompatibility()`.
 */
export const CREATE_SMRT_AI_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  definition_key TEXT,
  definition_version TEXT,
  tenant_id TEXT,
  class_name TEXT,
  prompt_key TEXT,
  template_hash TEXT,
  owner_id TEXT,
  parent_run_id TEXT,
  retry_of_run_id TEXT,
  experiment_id TEXT,
  dataset_item TEXT,
  tags TEXT,
  status TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  stopped_by_run_id TEXT,
  stop_detail TEXT,
  budget TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_used DOUBLE PRECISION NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  uncosted_calls INTEGER NOT NULL DEFAULT 0,
  steps_used INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,
  active_since TIMESTAMP,
  inclusive_tokens INTEGER NOT NULL DEFAULT 0,
  inclusive_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  inclusive_calls INTEGER NOT NULL DEFAULT 0,
  inclusive_uncosted_calls INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  reserved_calls INTEGER NOT NULL DEFAULT 0,
  checks_passed INTEGER NOT NULL DEFAULT 0,
  checks_failed INTEGER NOT NULL DEFAULT 0,
  approvals_given INTEGER NOT NULL DEFAULT 0,
  approvals_refused INTEGER NOT NULL DEFAULT 0,
  retain INTEGER NOT NULL DEFAULT 0,
  trajectory_pruned INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  mode TEXT,
  seats INTEGER,
  degraded_seats INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_created
  ON _smrt_ai_runs(created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_definition_created
  ON _smrt_ai_runs(definition_key, created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_tenant_created
  ON _smrt_ai_runs(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_parent
  ON _smrt_ai_runs(parent_run_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_retry_of
  ON _smrt_ai_runs(retry_of_run_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_finished
  ON _smrt_ai_runs(finished_at);
`;

/**
 * Ordered events of one AI run (#5005): the trajectory.
 *
 * `seq` is append order within the run, allocated in the same transaction as
 * the insert; `(run_id, seq)` is unique, declared inline because DuckDB
 * honours `ON CONFLICT` only against an inline constraint. `parent_event_id`
 * carries cause. `type` is `call`, `action`, `observation`, `check`,
 * `approval` or `handoff`. A `call` event points at its usage row through
 * `call_id` and holds the call's budget reservation in typed columns
 * (`reservation` state, `reserved_tokens`, `reserved_cost`), never in the
 * capped `payload`. A `handoff` to a child run names it in `child_run_id`.
 * `payload_ref` points at content the host stores; the framework stores
 * nothing behind it. `truncated` is INTEGER 0/1. `reserved_cost` is DOUBLE
 * PRECISION like the run's `reserved_cost` it is subtracted from, so a
 * release returns exactly what the reservation added. `run_id` and `call_id` are
 * not foreign keys, so usage retention never blocks on events.
 *
 * `idx_smrt_ai_run_events_sweep` serves the reservation reconciliation sweep;
 * `idx_smrt_ai_run_events_payload_ref` finds the events that reference one
 * host record (a chat turn's approval requests and their decisions).
 */
export const CREATE_SMRT_AI_RUN_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_event_id TEXT,
  type TEXT NOT NULL,
  call_id TEXT,
  step_index INTEGER,
  name TEXT,
  status TEXT,
  duration INTEGER,
  payload TEXT,
  payload_ref TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  child_run_id TEXT,
  reservation TEXT,
  reserved_tokens INTEGER,
  reserved_cost DOUBLE PRECISION,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_call
  ON _smrt_ai_run_events(call_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_child
  ON _smrt_ai_run_events(child_run_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_sweep
  ON _smrt_ai_run_events(type, reservation, created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_payload_ref
  ON _smrt_ai_run_events(payload_ref);
`;

/**
 * The saved state of a durable AI run (#5005), one row per run.
 *
 * `revision` is the compare-and-swap counter of saves; `lease` identifies the
 * runner holding the run; `last_seq` is the last event `seq` the saved state
 * covers; `definition_version` is the version that wrote it; `state` is
 * versioned, validated JSON owned by the run type. Deleted with the run's
 * trajectory.
 */
export const CREATE_SMRT_AI_RUN_CHECKPOINTS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_run_checkpoints (
  run_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  definition_version TEXT,
  state TEXT NOT NULL
);
`;

/**
 * The AI run id registry (schema 1.20.0): one row per run id ever opened on
 * this database, so an id names at most one run for the database's lifetime
 * (docs/content/ai-runs.md section 8, "Run identity"). `id_digest` is the hex
 * SHA-256 of the id's UTF-8 bytes, never the id itself, and there is no
 * tenant column: uniqueness is global and nothing about a tenant outlives
 * the run's own retention. Written in the opener's transaction with the run
 * row and by the row prune before it deletes a row; never deleted. The
 * primary key is inline because DuckDB honours `ON CONFLICT` only against an
 * inline constraint.
 */
export const CREATE_SMRT_AI_RUN_IDS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_run_ids (
  id_digest TEXT PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Opt-in AI call transcripts (#4780).
 *
 * Readable content of one AI call: the request messages, the response and
 * the tool events, each TEXT JSON after redaction, with a per-row byte cap
 * (`truncated` is 1 after a head-and-tail cut, 0 otherwise: system tables
 * store flags as INTEGER, like `_smrt_schema_migrations.is_reversible`, so
 * one binding works on every engine; `bytes` is the stored size of the three
 * payloads). Written only when the app enables
 * `inference.transcripts`. `call_id` is the `callId` usage tag the matching
 * `_smrt_ai_usage` rows carry in `call_id`, and `run_id` the fusion run;
 * neither is a foreign key, so retention prunes transcripts (30 days by
 * default) independently of usage rows and labels. `tenant_id` is TEXT like
 * `_smrt_ai_usage.tenant_id`. Reads are tenant-scoped by
 * `(tenant_id, created_at)`; `prompt_key` reads by `(prompt_key, created_at)`.
 */
export const CREATE_SMRT_AI_TRANSCRIPTS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_ai_transcripts (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  run_id TEXT,
  tenant_id TEXT,
  prompt_key TEXT,
  template_hash TEXT,
  provider TEXT,
  model TEXT,
  operation TEXT NOT NULL,
  class_name TEXT,
  request TEXT,
  response TEXT,
  tool_events TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_transcripts_call
  ON _smrt_ai_transcripts(call_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_transcripts_run
  ON _smrt_ai_transcripts(run_id);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_transcripts_created
  ON _smrt_ai_transcripts(created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_transcripts_tenant_created
  ON _smrt_ai_transcripts(tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_smrt_ai_transcripts_prompt_created
  ON _smrt_ai_transcripts(prompt_key, created_at);
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
  tenant_id UUID,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smrt_changes_pending_table
  ON _smrt_changes_pending(table_name);
`;

/** Name of the PostgreSQL staging table for deferred change-feed appends. */
export const POSTGRES_CHANGE_FEED_PENDING_TABLE = '_smrt_changes_pending';

/** PostgreSQL materialization of the portable change-feed table DDL. */
export const CREATE_POSTGRES_SMRT_CHANGES_TABLE =
  CREATE_SMRT_CHANGES_TABLE.replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ').replace(
    /\btenant_id TEXT\b/g,
    'tenant_id UUID',
  );

/** PostgreSQL helper used to isolate best-effort feed appends (#2026). */
export const POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME = '_smrt_append_change';

/** PostgreSQL one-statement batch wrapper around the isolated append helper. */
export const POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_NAME =
  '_smrt_append_changes';

/** Legacy helper identity used before PostgreSQL Date values became instants. */
export const LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(text,text,text,text,timestamp without time zone)`;

/** Exact PostgreSQL identity used for catalog lookup of the append helper. */
export const POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_NAME}(text,text,text,text,timestamp with time zone)`;

/** PostgreSQL identity of the one-statement batch append helper. */
export const POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_NAME}(jsonb)`;

/**
 * Body marker stamped into every PostgreSQL change-feed helper (#2649).
 *
 * Existence is not currency: an install can hold a helper of the right name
 * and signature whose *body* predates a fix. The probe in `change-feed.ts`
 * matches this token against `pg_proc.prosrc`, so a stale body is detected and
 * replaced. Bump it whenever a helper's body changes in a way an existing
 * database must pick up.
 *
 * v6 (#5271) serializes every sequence allocator on the feed's head lock and
 * stages appends made under a fixed-snapshot isolation level.
 */
export const POSTGRES_CHANGE_FEED_HELPER_MARKER = 'smrt-change-feed-helpers:v6';

/**
 * The v5 marker, still stamped into every v6 body (#5271), for the same
 * reason v5 carries v4: a v5 process probes for it, and finding it keeps that
 * process from replacing a v6 body with its own during a rolling upgrade.
 */
export const POSTGRES_CHANGE_FEED_HELPER_PREVIOUS_MARKER =
  'smrt-change-feed-helpers:v5';

/**
 * The v4 marker, still stamped into every v5 and v6 body (#3297).
 *
 * v5 only changes how a tenant id is coerced: it is converted to whatever type
 * the live `tenant_id` column has (TEXT before `db:migrate-uuid`, native uuid
 * after), so a v5 body is a drop-in for v4 callers. Older SMRT processes probe
 * for the v4 marker; carrying it stops them from replacing a v5 body with a
 * v4 one (which inserts text into a converted uuid column) during a
 * mixed-version rollout.
 */
export const POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER =
  'smrt-change-feed-helpers:v4';

/** Marker comment lines for a helper body: current first, then every older one. */
const POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES = [
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
  POSTGRES_CHANGE_FEED_HELPER_PREVIOUS_MARKER,
  POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER,
]
  .map((marker) => `-- ${marker}`)
  .join('\n');

/**
 * Advisory-lock key of the feed's "head lock" (#5271).
 *
 * Every allocator of `_smrt_changes.seq` (direct single and batch appends,
 * and the drain) takes this transaction-scoped lock before reading
 * `MAX(seq)`, so two allocators never compute the same value. The second key
 * is the resolved feed table's oid: the sequence belongs to that table, so
 * separate schemas in one database never serialize on each other (a hash
 * collision only adds serialization).
 *
 * Why the lock is sufficient: the helpers are VOLATILE (PL/pgSQL's default,
 * stated explicitly in each body and required to stay that way), so under
 * READ COMMITTED every statement after the lock takes a fresh snapshot, and
 * PostgreSQL makes a commit visible before it releases that transaction's
 * locks. The next holder therefore always sees its predecessor's row.
 *
 * The feed table's own insert lock is always taken before this one, so the
 * head lock is never held while waiting for that relation lock (a session
 * holding `SHARE` on the feed table could otherwise close a cycle). See
 * {@link POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} for the one exception.
 */
const POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY = `hashtext('smrt-change-feed-head'), hashtext(to_regclass('_smrt_changes')::oid::text)`;

/**
 * True when the invoking role may take the feed table's explicit insert lock
 * (#5271).
 *
 * `LOCK TABLE ... IN ROW EXCLUSIVE MODE` checks TABLE-level privileges
 * (INSERT, UPDATE, DELETE or TRUNCATE), while the feed's own INSERT is also
 * satisfied by column-level INSERT grants. A role granted only column-level
 * INSERT on `_smrt_changes` could append before v6, so the helpers skip the
 * explicit lock for it rather than fail every append with `42501`. Its INSERT
 * then takes the same relation lock after the head lock, so a session holding
 * `SHARE` on the feed table that also appends can form a cycle with it, which
 * PostgreSQL breaks with `40P01` (returned as data, the entry warned and
 * dropped).
 */
const POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION = `has_table_privilege('_smrt_changes', 'INSERT, UPDATE, DELETE, TRUNCATE')`;

/**
 * True when the current transaction reads through a fixed snapshot (#5271).
 *
 * REPEATABLE READ and SERIALIZABLE keep the snapshot of the transaction's
 * first statement, so a `MAX(seq)` read after waiting for the head lock can
 * be stale and could even succeed behind a cursor a consumer has already
 * observed once retention freed that slot. Such appends are staged and such
 * drains allocate nothing. PostgreSQL runs READ UNCOMMITTED as READ
 * COMMITTED, so it allocates normally.
 */
const POSTGRES_FIXED_SNAPSHOT_ISOLATION = `current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted')`;

/**
 * Coerce a text tenant id to the live type of `<table>.tenant_id` (#3297).
 *
 * `jsonb_populate_record` builds the table's row type at execution time, so
 * the same body works before and after the column converts to uuid, and a
 * cached plan is invalidated by the ALTER like any other. Empty strings are
 * NULL, matching the TypeScript writers.
 */
function postgresTenantIdAs(table: string, textExpression: string): string {
  return `(jsonb_populate_record(NULL::${table}, jsonb_build_object('tenant_id', NULLIF(${textExpression}, '')))).tenant_id`;
}

/** PostgreSQL helper that sequences staged change-feed appends (#2649). */
export const POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME = '_smrt_drain_changes';

/**
 * Exact PostgreSQL identity of the drain helper (#2982): the batch limit plus
 * the live set of sensitive tables, which the drain purges from staging and
 * never sequences.
 */
export const POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(integer,text[])`;

/**
 * Identity of the pre-#2982 single-argument drain, kept as a compatibility
 * entry point so replicas of an older SMRT that still call
 * `_smrt_drain_changes()` keep working during a mixed-version rollout. It
 * delegates to the two-argument drain with no exclusions — exactly the old
 * behavior — because it has no way to know the live sensitive set.
 */
export const POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(integer)`;

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
 *   cycle either;
 * - direct appenders are excluded by the head lock (#5271), which the drain
 *   also only *tries*, and only once a non-sensitive row is staged: a busy
 *   head makes it return, never wait. Its feed-table lock before that is
 *   `NOWAIT` for the same reason;
 * - under REPEATABLE READ / SERIALIZABLE it allocates nothing (#5271).
 *
 * Because exactly one drain runs at a time and it numbers rows
 * `COALESCE(MAX(seq), 0) + row_number()` in staged order, committed sequences
 * stay contiguous and no reader can observe seq N before seq N-1 — the change
 * feed's cursor guarantee is preserved verbatim (see `change-feed.ts`).
 *
 * Failures are returned as data, like the append helper, so a drain problem
 * never aborts the caller's transaction. A failed drain leaves the staged rows
 * in place for the next attempt.
 *
 * Sensitive tables (#2982): `p_excluded_tables` is the caller's live
 * sensitive set. Under the drain lock, staged rows for those tables are
 * deleted before any sequence is allocated, and the sequencing batch skips
 * them too, so an entry staged by an older replica (or left over from before
 * an upgrade) never reaches `_smrt_changes`. Neither parameter has a default:
 * a call with no arguments resolves only to the compatibility overload.
 */
export const CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(
  p_limit INTEGER,
  p_excluded_tables TEXT[]
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
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed_drain$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
DECLARE
  v_base BIGINT;
  v_has_candidate BOOLEAN;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  -- EVERY statement below sits inside this exception boundary, preflight
  -- included. The caller may own the surrounding transaction, and an error
  -- escaping this function would abort it — the #2026 contract. A probe that
  -- blocks on a table lock until statement_timeout is exactly that: it is not
  -- the insert, but it aborts the caller just the same.
  BEGIN
    IF to_regclass('_smrt_changes_pending') IS NULL THEN
      RETURN;
    END IF;

    -- Never sequence from inside a transaction that has already written. Doing
    -- so would hold freshly allocated sequences uncommitted for the rest of
    -- that transaction, which is precisely the wait edge #2649 removes — a
    -- reader calling getChangesSince() inside a long write transaction must
    -- not put it back. The staged rows keep for the next drain.
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
      RETURN;
    END IF;

    -- A fixed snapshot (REPEATABLE READ / SERIALIZABLE) could read a stale
    -- MAX(seq), so it never allocates (#5271). The staged rows keep for a
    -- READ COMMITTED drain.
    IF ${POSTGRES_FIXED_SNAPSHOT_ISOLATION} THEN
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

    -- The head lock (#5271) serializes this drain with direct appenders. It is
    -- only TRIED: a reader must never wait behind an appender's transaction,
    -- so when it is busy the drain returns and a later one sequences the
    -- staged rows. It is taken only when something will be sequenced, so a
    -- purge of sensitive rows alone never holds the head. The feed table's
    -- insert lock comes first, as in the append helpers, and is NOWAIT for
    -- the same reason the head lock is only tried: a session holding SHARE
    -- on the feed table would otherwise make this drain wait for it. A
    -- refusal is a skipped pass, not an error. A role without a table-level
    -- privilege for that lock skips it, as the append helpers do.
    v_has_candidate := EXISTS (
      SELECT 1
      FROM _smrt_changes_pending AS candidate
      WHERE NOT (
        candidate.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[]))
      )
    );
    IF v_has_candidate THEN
      IF ${POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} THEN
        BEGIN
          LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE NOWAIT;
        EXCEPTION WHEN lock_not_available THEN
          RETURN;
        END;
      END IF;
      IF NOT pg_try_advisory_xact_lock(${POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY}) THEN
        RETURN;
      END IF;
    END IF;

    -- The feed never records a sensitive table (#2982). Staged entries for
    -- one — from an older replica, or staged before the table was declared
    -- sensitive — are dropped here, before a sequence is allocated.
    -- Bounded like the sequencing batch, so a large legacy backlog cannot make
    -- one pass outlive statement_timeout and stall the feed; the remainder is
    -- purged by later passes, and the batch below skips it meanwhile.
    IF COALESCE(cardinality(p_excluded_tables), 0) > 0 THEN
      DELETE FROM _smrt_changes_pending AS sensitive
      WHERE sensitive.pending_id IN (
        SELECT staged.pending_id
        FROM _smrt_changes_pending AS staged
        WHERE staged.table_name = ANY(p_excluded_tables)
        ORDER BY staged.pending_id
        LIMIT GREATEST(COALESCE(p_limit, ${POSTGRES_CHANGE_FEED_DRAIN_BATCH}), 1)
      );
    END IF;

    IF NOT v_has_candidate THEN
      RETURN;
    END IF;

    SELECT COALESCE(MAX(changes.seq), 0) INTO v_base FROM _smrt_changes AS changes;

    RETURN QUERY
    WITH removed AS (
      DELETE FROM _smrt_changes_pending AS pending
      WHERE pending.pending_id IN (
        SELECT candidate.pending_id
        FROM _smrt_changes_pending AS candidate
        -- A sensitive row committed after the purge above is skipped, not
        -- sequenced; the next drain purges it.
        WHERE NOT (
          candidate.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[]))
        )
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
        ${postgresTenantIdAs('_smrt_changes', 'numbered.tenant_id::TEXT')},
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
      inserted.tenant_id::TEXT,
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
 * Compatibility single-argument drain (#2982): see
 * {@link POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION_IDENTITY}. Current SMRT
 * never calls it.
 */
export const CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION = `
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
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed_drain_compat$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
DECLARE
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  -- Its own boundary, like the drain it delegates to: a resolution or
  -- privilege error on the inner call must come back as data, never abort an
  -- older replica's caller transaction (#2026).
  BEGIN
    RETURN QUERY
    SELECT * FROM ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(p_limit, ARRAY[]::TEXT[]);
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
$smrt_change_feed_drain_compat$;
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
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
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
  -- Preflight inside its own exception boundary for the same reason the drain
  -- wraps its own: an error here would abort a caller-owned transaction
  -- (#2026), and a catalog probe is still a statement that can fail.
  --
  -- A fixed-snapshot transaction (#5271) is staged too, written or not: its
  -- MAX(seq) can be stale even after waiting for the head lock.
  --
  -- The decision does not depend on the staging table existing (#5271). If
  -- it is missing, the staged insert below fails and its error comes back as
  -- data: such a caller must neither allocate from a stale snapshot nor wait
  -- on the head while it holds a transaction id.
  BEGIN
    v_deferred := pg_current_xact_id_if_assigned() IS NOT NULL
      OR ${POSTGRES_FIXED_SNAPSHOT_ISOLATION};
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::BIGINT, v_error_code, v_error_message;
    RETURN;
  END;

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
        ${postgresTenantIdAs('_smrt_changes_pending', 'p_tenant_id')},
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
  --
  -- The head lock (#5271) serializes this allocation with every other one, so
  -- MAX(seq) below already sees the previous holder's committed row and the
  -- primary key never has to arbitrate. The feed table's insert lock is taken
  -- first (skipped for a role whose INSERT is granted only per column). Both
  -- sit inside the exception boundary: a lock timeout, cancel or deadlock
  -- comes back as data (#2026).
  BEGIN
    IF ${POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} THEN
      LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE;
    END IF;
    PERFORM pg_advisory_xact_lock(${POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY});

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
      ${postgresTenantIdAs('_smrt_changes', 'p_tenant_id')},
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
 * PostgreSQL batch append helper. It makes the staged/direct decision before
 * its own writes, then appends every element through that one path. This is
 * necessary because a direct first insert assigns the transaction id that
 * later entries must not mistake for a caller-owned write transaction.
 */
export const CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_NAME}(
  p_entries JSONB
)
RETURNS TABLE(
  entry_index INTEGER,
  allocated_seq BIGINT,
  error_code TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed_batch$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
DECLARE
  v_deferred BOOLEAN;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    -- As in the single append, a missing staging table fails the staged
    -- insert (returned as data) rather than falling through to allocate.
    v_deferred := pg_current_xact_id_if_assigned() IS NOT NULL
      OR ${POSTGRES_FIXED_SNAPSHOT_ISOLATION};

    IF v_deferred THEN
      RETURN QUERY
      WITH input AS (
        SELECT entries.ordinality::INTEGER - 1 AS entry_index, entries.value
        FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
          WITH ORDINALITY AS entries(value, ordinality)
      ), staged AS (
        INSERT INTO _smrt_changes_pending (
          table_name, row_id, operation, tenant_id, created_at
        )
        SELECT
          input.value->>'table',
          input.value->>'rowId',
          input.value->>'operation',
          ${postgresTenantIdAs('_smrt_changes_pending', "input.value->>'tenantId'")},
          (input.value->>'timestamp')::TIMESTAMPTZ
        FROM input
        ORDER BY input.entry_index
        RETURNING 1
      )
      SELECT input.entry_index, NULL::BIGINT, NULL::TEXT, NULL::TEXT
      FROM input
      ORDER BY input.entry_index;
      RETURN;
    END IF;

    -- Same order as the single append (#5271): feed-table insert lock, then
    -- the head lock, then the statement that reads MAX(seq).
    IF ${POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} THEN
      LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE;
    END IF;
    PERFORM pg_advisory_xact_lock(${POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY});

    RETURN QUERY
    WITH input AS (
      SELECT entries.ordinality::INTEGER - 1 AS entry_index, entries.value
      FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
        WITH ORDINALITY AS entries(value, ordinality)
    ), numbered AS (
      SELECT
        input.*,
        COALESCE((SELECT MAX(seq) FROM _smrt_changes), 0)
          + row_number() OVER (ORDER BY input.entry_index) AS new_seq
      FROM input
    ), inserted AS (
      INSERT INTO _smrt_changes (
        seq, table_name, row_id, operation, tenant_id, created_at
      )
      SELECT
        numbered.new_seq,
        numbered.value->>'table',
        numbered.value->>'rowId',
        numbered.value->>'operation',
        ${postgresTenantIdAs('_smrt_changes', "numbered.value->>'tenantId'")},
        (numbered.value->>'timestamp')::TIMESTAMPTZ
      FROM numbered
      ORDER BY numbered.entry_index
      RETURNING seq
    )
    SELECT
      numbered.entry_index,
      numbered.new_seq,
      NULL::TEXT,
      NULL::TEXT
    FROM numbered
    ORDER BY numbered.entry_index;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::INTEGER, NULL::BIGINT, v_error_code, v_error_message;
  END;
END;
$smrt_change_feed_batch$;
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
 * Install both drain overloads inside a helper DO block (#2982).
 *
 * The two-argument drain is the first framework routine identity added to
 * databases that already exist, and a new function gets PostgreSQL's default
 * ACL — which a hardened deployment (PUBLIC EXECUTE revoked, the runtime role
 * granted explicitly by the permissions planner) would leave the runtime
 * unable to call. When this block creates it, it therefore inherits the
 * compatibility drain's reconciled EXECUTE grants. A role that may not grant
 * keeps the default ACL; the permissions planner reports and repairs it.
 */
const POSTGRES_CHANGE_FEED_DRAIN_INSTALL = `  DECLARE
    v_drain_created BOOLEAN :=
      to_regprocedure('${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY}') IS NULL;
    v_grant RECORD;
  BEGIN
    EXECUTE $smrt_change_feed_drain_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_ddl$;
    EXECUTE $smrt_change_feed_drain_compat_ddl$
${CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_compat_ddl$;
    IF v_drain_created AND (
      SELECT p.proacl FROM pg_proc AS p
      WHERE p.oid = to_regprocedure('${POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION_IDENTITY}')
    ) IS NOT NULL THEN
      BEGIN
        EXECUTE 'REVOKE ALL ON FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY} FROM PUBLIC';
        FOR v_grant IN
          SELECT acl.grantee
          FROM pg_proc AS p, aclexplode(p.proacl) AS acl
          WHERE p.oid = to_regprocedure('${POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION_IDENTITY}')
            AND acl.privilege_type = 'EXECUTE'
        LOOP
          IF v_grant.grantee = 0 THEN
            EXECUTE 'GRANT EXECUTE ON FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY} TO PUBLIC';
          ELSE
            EXECUTE format(
              'GRANT EXECUTE ON FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY} TO %I',
              pg_get_userbyid(v_grant.grantee)
            );
          END IF;
        END LOOP;
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      END;
    END IF;
  END;`;

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
${POSTGRES_CHANGE_FEED_DRAIN_INSTALL}
  EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
  EXECUTE $smrt_change_feed_batch_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION.trim()}
$smrt_change_feed_batch_ddl$;
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
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_IDENTITY}')
        AND prosrc LIKE '%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%'
    );
${POSTGRES_CHANGE_FEED_PENDING_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
${POSTGRES_CHANGE_FEED_DRAIN_INSTALL}
  IF v_append_stale THEN
    EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
    EXECUTE $smrt_change_feed_batch_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION.trim()}
$smrt_change_feed_batch_ddl$;
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
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_proc
      WHERE oid = to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_IDENTITY}')
        AND prosrc LIKE '%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%'
    );
${POSTGRES_CHANGE_FEED_SCHEMA_DDL}
${POSTGRES_CHANGE_FEED_PENDING_DDL}
  DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY};
${POSTGRES_CHANGE_FEED_DRAIN_INSTALL}
  IF v_append_stale THEN
    EXECUTE $smrt_change_feed_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION.trim()}
$smrt_change_feed_ddl$;
    EXECUTE $smrt_change_feed_batch_ddl$
${CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION.trim()}
$smrt_change_feed_batch_ddl$;
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

/** The insert-only claim table backing `runOnce()` (`../run-once.ts`). Browser-safe: retention imports it. */
export const RUN_ONCE_CLAIMS_TABLE = '_smrt_run_once_claims';

/**
 * Idempotency claims for `runOnce()` (#3080).
 *
 * `claim_key` is the sha256 hex digest of the sorted-key-JSON encoding of
 * `(tenantId, actor, token, contentDigest)` — see `../run-once.ts` for the
 * derivation and why the token alone is not enough (it collapses distinct
 * submissions that reuse a form's token). It is the table's PRIMARY KEY, so
 * a second `INSERT` for the same key always raises a unique-constraint
 * violation instead of silently adopting the first caller's row: exactly the
 * "insert-only against a UNIQUE column" claim the issue asks for.
 *
 * Neither the raw token nor the raw submitted content is stored — only
 * digests — so this table cannot leak submitted business data. `status`
 * moves from `'in_progress'` to `'completed'` inside the SAME transaction
 * that runs the caller's work, so `result` (the caller's JSON-serialized,
 * ready-to-replay return value) and `completed_at` are only ever set once,
 * atomically with whatever else that transaction wrote. If the work throws,
 * `runOnce()` never marks the claim completed, and the transaction that
 * inserted it rolls back the insert along with it — a claim is never left
 * permanently `'in_progress'` by a failed attempt; a retry with the same key
 * can always run again.
 */
export const CREATE_SMRT_RUN_ONCE_CLAIMS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_run_once_claims (
  claim_key TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  result TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_run_once_claims_tenant
  ON _smrt_run_once_claims(tenant_id, created_at);

-- Retention predicate for pruneRunOnceClaims() (#3080): completed claims are
-- aged out on completed_at, scoped to status = 'completed' so an in_progress
-- claim (completed_at IS NULL) is never matched by the sweep.
CREATE INDEX IF NOT EXISTS idx_smrt_run_once_claims_status_completed
  ON _smrt_run_once_claims(status, completed_at);
`;

/** Durable sync deletion revisions, separate from live natural keys. */
export const CREATE_SMRT_SYNC_TOMBSTONES_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_sync_tombstones (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tenant_id TEXT,
  origin_device_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at TIMESTAMP NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
`;

/** Permanent, append-only successful whole-schema migrate ledger (#4926). */
export const CREATE_SMRT_MIGRATE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_migrate_runs (
  id TEXT PRIMARY KEY,
  release TEXT NOT NULL,
  packages TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  recomputes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_retirements TEXT
);
CREATE INDEX IF NOT EXISTS idx_smrt_migrate_runs_latest
  ON _smrt_migrate_runs(created_at, id);
`;

/**
 * All system table creation statements
 */
export const ALL_SYSTEM_TABLES = [
  CREATE_SMRT_CONTEXTS_TABLE,
  CREATE_SMRT_MIGRATIONS_TABLE,
  CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
  CREATE_SMRT_MIGRATE_RUNS_TABLE,
  CREATE_SMRT_BACKFILLS_TABLE,
  CREATE_SMRT_RUN_ONCE_CLAIMS_TABLE,
  CREATE_SMRT_EMBEDDINGS_TABLE,
  CREATE_SMRT_DISPATCH_TABLE,
  CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE,
  CREATE_SMRT_AI_USAGE_TABLE,
  CREATE_SMRT_AI_EVALUATIONS_TABLE,
  CREATE_SMRT_AI_RUNS_TABLE,
  CREATE_SMRT_AI_RUN_EVENTS_TABLE,
  CREATE_SMRT_AI_RUN_CHECKPOINTS_TABLE,
  CREATE_SMRT_AI_RUN_IDS_TABLE,
  CREATE_SMRT_AI_TRANSCRIPTS_TABLE,
  CREATE_SMRT_CHANGES_TABLE,
  CREATE_SMRT_SYNC_TOMBSTONES_TABLE,
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
 * System-table columns that hold a real tenant id (#3297): a tenant UUID from
 * the tenant context, or NULL for global rows. On PostgreSQL they materialize
 * as native `uuid`, like every application `tenant_id`; other engines keep
 * TEXT, where `UUID` renders as TEXT anyway. Existing PostgreSQL TEXT columns
 * convert through `smrt db:migrate-uuid` in a maintenance window.
 *
 * Deliberately NOT here (they stay TEXT):
 * - text identity encodings that are not tenant ids: `_smrt_contexts.owner_id`
 *   (`__collection__` / `__collection__:<tenantId>` scope keys, object/agent
 *   row ids), `_smrt_run_once_claims.actor` (an arbitration namespace),
 *   `_smrt_dispatch.processed_by` (a subscriber name) and
 *   `_smrt_schema_migrations.applied_by` (a hostname);
 * - `_smrt_run_once_claims.tenant_id`: a NOT NULL claim scope folded into the
 *   claim key; a caller without a tenant must pass a scope string, so it is a
 *   scope key, not a tenant FK;
 * - `_smrt_ai_usage.tenant_id`: model usage writes tenant UUIDs, but the
 *   published external-agent usage API accepts any non-empty text tenant id,
 *   so converting it is a contract change tracked separately;
 * - `_smrt_ai_evaluations.tenant_id`, `_smrt_ai_runs.tenant_id` and
 *   `_smrt_ai_transcripts.tenant_id`: match `_smrt_ai_usage.tenant_id`, the
 *   column they are read beside, and convert with it.
 */
export const SYSTEM_TABLE_TENANT_UUID_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
}> = Object.freeze([
  { table: '_smrt_dispatch', column: 'tenant_id' },
  { table: '_smrt_dispatch_subscriptions', column: 'tenant_id' },
  { table: '_smrt_changes', column: 'tenant_id' },
  { table: '_smrt_changes_pending', column: 'tenant_id' },
]);

/**
 * Materialize the portable system-table schema for a target engine.
 *
 * PostgreSQL must use TIMESTAMPTZ because every system Date is an instant,
 * and native UUID for the tenant columns in
 * {@link SYSTEM_TABLE_TENANT_UUID_COLUMNS} (#3297).
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
    ? toPostgresTenantUuid(integerDdl.replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ'))
    : integerDdl;
}

const POSTGRES_UUID_TENANT_TABLES = new Set(
  SYSTEM_TABLE_TENANT_UUID_COLUMNS.map(({ table }) => table),
);

/**
 * Render `tenant_id TEXT` as native uuid on PostgreSQL in the DDL of a table
 * listed in {@link SYSTEM_TABLE_TENANT_UUID_COLUMNS} (each system DDL
 * constant creates one table).
 */
function toPostgresTenantUuid(ddl: string): string {
  const table = ddl.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w$]*)/i,
  )?.[1];
  return table && POSTGRES_UUID_TENANT_TABLES.has(table)
    ? ddl.replace(/\btenant_id TEXT\b/g, 'tenant_id UUID')
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
 * 1.10.1 retires the never-written `_smrt_registry` / `_smrt_signals` tables
 * (see {@link RETIRED_SYSTEM_TABLES}) and adds the retention-predicate indexes
 * from #2375 (`_smrt_contexts.expires_at`, `_smrt_ai_usage(tenant_id,
 * created_at)`, `_smrt_dispatch(status, processed_at)` and
 * `(status, updated_at)`) in the same replay. (`1.10.0` briefly existed only
 * on two unreleased, unmerged branches with two different, incompatible DDL
 * sets — never published, never stamped in any real `_smrt_migrations` table
 * — so merging them reuses no version an existing install could have already
 * recorded; see the note on {@link SMRT_SCHEMA_DDL_CHECKSUMS}.)
 *
 * 1.11.0 adds `_smrt_run_once_claims` (#3080), the insert-only claim table
 * behind `runOnce()` (`../run-once.ts`).
 *
 * 1.11.1 adds `idx_smrt_run_once_claims_status_completed` (#3080), the
 * `(status, completed_at)` index backing `pruneRunOnceClaims()`'s retention
 * predicate (`system/retention.ts`).
 *
 * 1.12.0 adds the durable tracked-deletion ledger.
 *
 * 1.13.0 adds the prompt-run observability columns `prompt_key`,
 * `tier_requested`, `tier_resolved`, `run_id` and their indexes to
 * `_smrt_ai_usage`, and the `_smrt_ai_usage_outcomes` label table (#4751).
 *
 * 1.14.0 adds the `_smrt_ai_runs` fusion run table (#4753).
 *
 * 1.15.0 adds the `_smrt_ai_transcripts` table and the `call_id` columns
 * (with indexes) on `_smrt_ai_usage` and `_smrt_ai_usage_outcomes` (#4780).
 */
// 1.16.0 adds the successful whole-schema migrate ledger (#4926). 1.16.1 adds
// its `recomputes` column (the ordinary columns a run made calculated on
// request, #5018); 1.16.0 databases get it from `addColumnIfMissing()`.
// 1.17.0 widens the AI run model (#5005): step, attempt, template and entry-call
// columns on `_smrt_ai_usage` (its `call_id` index becomes an `entry_call_id`
// one), the widened and rebuilt `_smrt_ai_runs`, the new `_smrt_ai_run_events`
// and `_smrt_ai_run_checkpoints`, and `_smrt_ai_evaluations` in place of
// `_smrt_ai_usage_outcomes`. Run rows carry `stop_detail` and an indexed
// `retry_of_run_id`, and the run's accumulating cost columns are DOUBLE
// PRECISION.
// 1.18.0 adds `_smrt_migrate_runs.confirmed_retirements`, the JSON list of
// retirements a run dropped over a confirmed definition mismatch (#5005).
// 1.19.0 adds `idx_smrt_ai_runs_finished`, the `finished_at` index behind
// AI run trajectory and row retention (#5005, `system/ai-run-retention.ts`).
// 1.20.0 adds `_smrt_ai_run_ids`, the run id registry (digests of every run
// id ever opened); the bootstrap fills it from the ids still present or
// referenced after its DDL replay and before this stamp
// (`system/ai-run-ids.ts`).
export const SMRT_SCHEMA_VERSION = '1.20.0';

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
    '1.11.0':
      'c51351a76c96beb64fa7e5922f78d776367af882ed1ff37229f9e9ffacee8372',
    '1.11.1':
      '98112937a3bbb3883c3db1fd5e836751f91a479c1c5da64d4410263a6581ef1f',
    '1.12.0':
      '6aa42e368e7d57191de9b0c040c289edf38a1ffa7ae0097f57188ecd5a5b8f9c',
    '1.13.0':
      '321c33d4616dd98575c80aa6bc766f65c4282c2341fc9566e50914a873e1065f',
    '1.14.0':
      '4dc0c5f170ebe54ce1322bd42e42e042d8893f2b4588809c19c77f17479c15b3',
    '1.15.0':
      '6a1a58c1b2f137d8a1e3378f667587074dd6d1049c8d2f119427ff1232c0323b',
    '1.16.0':
      '8f7f6a9f5a7f3d28ac4858841a665328698a06467bcab4a8d2055cc651db263a',
    '1.16.1':
      '30014e192ed56e2645b70a2e08a2c704a8c16b033544cdb53560a64d6e8c7c15',
    '1.17.0':
      'a20c17a542e6c1733b1fedf93e590c672e07c3406f0f6657ff0996edd8aa263f',
    '1.18.0':
      'e510d65450decb8f539675719600f57cae46764a1e3a5fa45d27ca5dea345df6',
    '1.19.0':
      'b9ea16aaf8c5d3232245395dbd6374c0878594f3e2e443f1ae58e64c726acca1',
    '1.20.0':
      'c507de3133c44e3350196c1a30ad821c3faf96b79392d885d3465a6d57dfc4f8',
  });
