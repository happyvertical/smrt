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
 * Gap markers: change-feed entries that were lost before they could be
 * sequenced (#5438).
 *
 * One row per lost entry. A marker is written when the PostgreSQL drain
 * cannot move a staged entry into `_smrt_changes` (the entry itself is
 * refused: a data or constraint error, or a trigger that drops it), so the
 * loss is recorded instead of blocking every later drain or vanishing.
 *
 * - `table_name` and `tenant_key` say whose readers the loss concerns.
 *   `tenant_key` is text on every engine (a lost entry's owner may be a value
 *   the uuid column would refuse); NULL only for a global entry.
 * - `row_id` and `operation` are the lost entry's identity. They are private
 *   evidence with the sensitivity of `_smrt_changes` rows, never shown by a
 *   public read. A NULL `row_id` is valid evidence (a lost row-less entry).
 * - Lifecycle: *unconverted* (`converted_seq` and `reconciled_at` NULL),
 *   counted in the table's version; *blocked* (`blocked_at` set), an
 *   unconverted marker whose conversion failed and that ordinary drain passes
 *   skip; *converted* (`converted_seq` set, `tenant_key` rewritten to the
 *   feed row's canonical tenant text), kept as evidence until retention
 *   deletes it after its feed row; *reconciled* (`reconciled_at` set), retired
 *   by an operator, never converted, and counted in the table version for good
 *   so that version never decreases.
 *
 * Conversion (giving a marker a feed position) happens only while the
 * delivery setting is present in `_smrt_backfills`
 * ({@link CHANGE_FEED_GAP_DELIVERY_SETTING}); nothing in this release creates
 * it. `gap_id` is a native uuid on PostgreSQL and DuckDB and TEXT on SQLite
 * (see {@link getSystemTableDDLForEngine}).
 */
export const CREATE_SMRT_CHANGE_GAPS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_change_gaps (
  gap_id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT,
  operation TEXT,
  tenant_key TEXT,
  created_at TIMESTAMP NOT NULL,
  blocked_at TIMESTAMP,
  converted_seq BIGINT,
  reconciled_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_change_gaps_table
  ON _smrt_change_gaps(table_name);

CREATE INDEX IF NOT EXISTS idx_smrt_change_gaps_converted_seq
  ON _smrt_change_gaps(converted_seq);
`;

/** Name of the change-feed gap-marker table (#5438). */
export const CHANGE_FEED_GAPS_TABLE = '_smrt_change_gaps';

/**
 * `_smrt_backfills` row whose presence lets the drain give gap markers a
 * feed position (#5438). No code in this release creates it, so delivery is
 * off everywhere; markers are kept and counted in table versions meanwhile.
 */
export const CHANGE_FEED_GAP_DELIVERY_SETTING =
  '@happyvertical/smrt-core:change-feed-gap-delivery:v1';

/**
 * Render the gap table's `gap_id` for an engine (#5438): a native uuid with a
 * per-row default on PostgreSQL, where the drain writes markers; a native
 * uuid without a default on DuckDB (nothing writes markers there yet, and the
 * DDL must stay valid where a SQLite file is detected as DuckDB by its name);
 * TEXT on SQLite and the JSON adapter (UUID as text). Plain string work with
 * no module-level state, so the helper install DDL above the engine
 * materializer can use it at module load.
 */
function renderChangeGapsId(ddl: string, engine: DatabaseEngine): string {
  if (engine === 'postgres') {
    return ddl.replace(
      /\bgap_id TEXT PRIMARY KEY\b/,
      'gap_id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
    );
  }
  return engine === 'duckdb'
    ? ddl.replace(/\bgap_id TEXT PRIMARY KEY\b/, 'gap_id UUID PRIMARY KEY')
    : ddl;
}

/** PostgreSQL materialization of {@link CREATE_SMRT_CHANGE_GAPS_TABLE}. */
const CREATE_POSTGRES_SMRT_CHANGE_GAPS_TABLE = renderChangeGapsId(
  CREATE_SMRT_CHANGE_GAPS_TABLE,
  'postgres',
).replace(/\bTIMESTAMP\b/g, 'TIMESTAMPTZ');

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
 *
 * v7 (#5402) moves the drain body into the status overload
 * {@link POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY}, which releases
 * every lock a pass took when it finds no work; the older drain identities
 * delegate to it. The append bodies are only re-stamped.
 *
 * v8 (#5438) adds gap markers to the status drain: a staged batch whose
 * removed and inserted counts differ is rolled back, a staged entry the feed
 * refuses becomes a gap marker, and markers are converted while delivery is
 * enabled. It also adds the version routine
 * {@link POSTGRES_CHANGE_FEED_VERSION_FUNCTION_IDENTITY}. The other bodies are
 * only re-stamped.
 */
export const POSTGRES_CHANGE_FEED_HELPER_MARKER = 'smrt-change-feed-helpers:v8';

/**
 * The v7 marker, still stamped into every v8 body (#5438): a v7 process
 * probes for it, and finding it keeps that process from replacing a v8 body
 * with its own during a rolling upgrade. The v7 status drain is also what
 * this build still calls directly when a v8 install is refused.
 */
export const POSTGRES_CHANGE_FEED_HELPER_STATUS_MARKER =
  'smrt-change-feed-helpers:v7';

/**
 * The v6 marker, still stamped into every v7 and v8 body (#5402).
 *
 * It is also the compatibility floor: v6 is the first body set that gives
 * the cursor guarantee under contention and fixed-snapshot isolation, so a
 * database whose every existing helper carries it is usable while a v7
 * install is refused, and one whose helpers predate it is not (see
 * `change-feed.ts`, helper probe states).
 */
export const POSTGRES_CHANGE_FEED_HELPER_FLOOR_MARKER =
  'smrt-change-feed-helpers:v6';

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
  POSTGRES_CHANGE_FEED_HELPER_STATUS_MARKER,
  POSTGRES_CHANGE_FEED_HELPER_FLOOR_MARKER,
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

/**
 * Identity of the status drain (#5402): the batch limit, the live sensitive
 * set, and a JSON options object. It holds the drain body; the two older
 * identities delegate to it and return only its entry and error rows.
 */
export const POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(integer,text[],jsonb)`;

/** PostgreSQL helper that reads one table's change version (#5438). */
export const POSTGRES_CHANGE_FEED_VERSION_FUNCTION_NAME =
  '_smrt_change_feed_version';

/** Exact PostgreSQL identity of the version routine (#5438). */
export const POSTGRES_CHANGE_FEED_VERSION_FUNCTION_IDENTITY = `${POSTGRES_CHANGE_FEED_VERSION_FUNCTION_NAME}(text)`;

/** How many staged entries one drain call sequences. */
export const POSTGRES_CHANGE_FEED_DRAIN_BATCH = 1000;

/**
 * SQLSTATE the status drain raises to leave its locking block when a pass
 * finds no work (#5402). Private to the helper body: the block's own handler
 * catches it, and that rollback is what releases every lock the pass took.
 */
const POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE = 'SMR01';

/** Upper bound on one waiting drain's `waitMs`, whatever a caller passes. */
const POSTGRES_CHANGE_FEED_DRAIN_MAX_WAIT_MS = 600_000;

/**
 * One budget step of a waiting drain (#5403), placed before each blocking
 * statement: the time left until the deadline becomes the local
 * `lock_timeout`, and a spent budget ends the pass as `timeout` before it
 * waits at all. The computed value is never below 1 ms, because PostgreSQL
 * reads `lock_timeout = 0` as no limit. A no-op without `waitMs`.
 */
function drainBudgetStep(indent: string, statusVar = 'v_status'): string {
  return [
    'IF v_wait THEN',
    '  v_remaining_ms := EXTRACT(EPOCH FROM v_deadline - clock_timestamp()) * 1000;',
    '  IF v_remaining_ms < 1 THEN',
    `    ${statusVar} := 'timeout';`,
    `    RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';`,
    '  END IF;',
    "  PERFORM set_config('lock_timeout', GREATEST(1, floor(v_remaining_ms))::BIGINT::TEXT || 'ms', true);",
    'END IF;',
  ]
    .map((line) => `${indent}${line}`)
    .join('\n');
}

/** Indent every line of a generated SQL fragment. */
function indentSql(indent: string, lines: string[]): string {
  return lines
    .flatMap((line) => line.split('\n'))
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

/**
 * The drain advisory lock step of a pass (#5402): waited for in wait mode,
 * only tried otherwise. Shared by the staged-entry and gap-marker phases
 * (#5438), which take the same lock.
 */
function drainAdvisoryLockStep(indent: string, statusVar: string): string {
  return [
    `${indent}IF v_wait THEN`,
    drainBudgetStep(`${indent}  `, statusVar),
    indentSql(indent, [
      '  PERFORM pg_advisory_xact_lock(',
      "    hashtext('smrt'),",
      "    hashtext('change-feed-drain')",
      '  );',
      'ELSIF NOT pg_try_advisory_xact_lock(',
      "  hashtext('smrt'),",
      "  hashtext('change-feed-drain')",
      ') THEN',
      `  ${statusVar} := 'drain_busy';`,
      `  RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';`,
      'END IF;',
    ]),
  ].join('\n');
}

/**
 * The feed table's insert lock and the head lock of a pass that will
 * allocate (#5271, #5402); see the comment above their first use in the
 * status drain for the order. `ownTable` is the table the phase writes
 * besides the feed (the staging table, or the gap table, #5438): in wait mode
 * its insert lock is taken first, so no later statement of the phase waits
 * for it while holding the head.
 */
function drainHeadLockSteps(
  indent: string,
  statusVar: string,
  ownTable: string,
): string {
  const busy = (status: string) => [
    `  ${statusVar} := '${status}';`,
    `  RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';`,
  ];
  return [
    `${indent}IF v_wait THEN`,
    drainBudgetStep(`${indent}  `, statusVar),
    indentSql(indent, [
      `  LOCK TABLE ${ownTable} IN ROW EXCLUSIVE MODE;`,
      'END IF;',
      `IF NOT ${POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} THEN`,
      "  PERFORM set_config('lock_timeout', '1ms', true);",
      '  BEGIN',
      '    INSERT INTO _smrt_changes (seq) SELECT NULL::BIGINT WHERE false;',
      '  EXCEPTION WHEN lock_not_available THEN',
      ...busy('relation_busy').map((line) => `  ${line}`),
      '  END;',
      "  PERFORM set_config('lock_timeout', v_lock_timeout, true);",
      'ELSIF NOT v_wait THEN',
      '  BEGIN',
      '    LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE NOWAIT;',
      '  EXCEPTION WHEN lock_not_available THEN',
      ...busy('relation_busy').map((line) => `  ${line}`),
      '  END;',
      'END IF;',
      'IF v_wait THEN',
    ]),
    drainBudgetStep(`${indent}  `, statusVar),
    indentSql(indent, [
      `  PERFORM pg_advisory_xact_lock(${POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY});`,
      `  IF ${POSTGRES_CHANGE_FEED_CAN_LOCK_RELATION} THEN`,
      '    BEGIN',
      '      LOCK TABLE _smrt_changes IN ROW EXCLUSIVE MODE NOWAIT;',
      '    EXCEPTION WHEN lock_not_available THEN',
      ...busy('relation_busy').map((line) => `    ${line}`),
      '    END;',
      '  END IF;',
      `ELSIF NOT pg_try_advisory_xact_lock(${POSTGRES_CHANGE_FEED_HEAD_LOCK_KEY}) THEN`,
      ...busy('head_busy'),
      'END IF;',
    ]),
  ].join('\n');
}

/**
 * SQLSTATE the status drain raises to undo a move whose receipt did not
 * match (#5438): a batch that removed more staged rows than it inserted feed
 * rows, or a single move or conversion that did not affect exactly one row.
 * Private to the helper body, caught by the block that raised it.
 */
const POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE = 'SMR02';

/**
 * At most this many staged rows are moved one at a time by a pass after its
 * batch failed on a row (#5438). The rest wait for the next pass.
 */
export const POSTGRES_CHANGE_FEED_ISOLATION_BATCH = 64;

/** At most this many gap markers are converted by one pass (#5438). */
export const POSTGRES_CHANGE_FEED_GAP_BATCH = 200;

/**
 * Whether the error in `v_code` / `v_constraint` is attributable to the row
 * being moved (#5438), so the row may be replaced by a gap marker: a data
 * exception (class 22), an integrity violation (class 23) other than a
 * duplicate of the feed's own sequence key (the head race an older appender
 * can cause, retried as before), or a raise from a trigger (`P0001`). Lock
 * timeouts, cancels, privilege and resource errors are not: they leave the
 * staged row for a later pass.
 */
const POSTGRES_CHANGE_FEED_ROW_ATTRIBUTABLE = `(
  v_code LIKE '22%'
  OR v_code = 'P0001'
  OR (
    v_code LIKE '23%'
    AND NOT (
      v_code = '23505'
      AND v_constraint IS NOT DISTINCT FROM (
        SELECT feed_key.conname::TEXT
        FROM pg_constraint AS feed_key
        WHERE feed_key.conrelid = to_regclass('_smrt_changes')
          AND feed_key.contype = 'p'
      )
    )
  )
)`;

/** The staged rows a pass may sequence: every table outside the sensitive set. */
const POSTGRES_CHANGE_FEED_NOT_EXCLUDED = (alias: string) =>
  `NOT (${alias}.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[])))`;

/**
 * PostgreSQL-only drain: move committed staged appends into `_smrt_changes`.
 *
 * The body lives in the status overload
 * ({@link POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY}); the
 * two-argument identity this text describes delegates to it (see
 * {@link CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION}).
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
export const CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(
  p_limit INTEGER,
  p_excluded_tables TEXT[],
  p_options JSONB
)
RETURNS TABLE(
  drained_seq BIGINT,
  drained_table TEXT,
  drained_row_id TEXT,
  drained_operation TEXT,
  drained_tenant_id TEXT,
  error_code TEXT,
  error_message TEXT,
  status TEXT,
  backlog_remaining BOOLEAN,
  helpers_current BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed_drain_status$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
DECLARE
  v_base BIGINT;
  v_has_candidate BOOLEAN := false;
  v_purged BIGINT := 0;
  v_status TEXT;
  v_backlog BOOLEAN;
  v_helpers BOOLEAN;
  v_wait BOOLEAN := false;
  v_budget_ms DOUBLE PRECISION;
  v_remaining_ms DOUBLE PRECISION;
  v_statement_timeout_ms DOUBLE PRECISION;
  v_deadline TIMESTAMPTZ;
  v_lock_timeout TEXT := current_setting('lock_timeout');
  v_sequencing BOOLEAN := false;
  v_error_code TEXT;
  v_error_message TEXT;
  -- Gap markers (#5438).
  v_entries JSONB := '[]'::JSONB;
  v_removed BIGINT;
  v_inserted BIGINT;
  v_isolate BOOLEAN := false;
  v_isolated INTEGER := 0;
  v_mark BOOLEAN;
  v_next BIGINT;
  v_seq BIGINT;
  v_canonical TEXT;
  v_gap_id TEXT;
  v_staged RECORD;
  v_marker RECORD;
  v_code TEXT;
  v_constraint TEXT;
  v_detail TEXT;
  v_staged_error_code TEXT;
  v_staged_error_message TEXT;
  v_staged_status TEXT;
  v_gap_status TEXT;
  v_gap_enabled BOOLEAN := false;
  v_gap_backlog BOOLEAN;
  v_gap_purged BIGINT := 0;
  v_gap_first BIGINT;
  v_gap_last BIGINT;
  v_converted INTEGER := 0;
  v_blocked INTEGER := 0;
  v_retry_blocked BOOLEAN := COALESCE(p_options->'retryBlocked' = 'true'::JSONB, false);
  v_notes TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- EVERY statement below sits inside this exception boundary, preflight
  -- included. The caller may own the surrounding transaction, and an error
  -- escaping this function would abort it — the #2026 contract. A probe that
  -- blocks on a table lock until statement_timeout is exactly that: it is not
  -- the insert, but it aborts the caller just the same.
  BEGIN
    -- Never sequence from inside a transaction that has already written. Doing
    -- so would hold freshly allocated sequences uncommitted for the rest of
    -- that transaction, which is precisely the wait edge #2649 removes — a
    -- reader calling getChangesSince() inside a long write transaction must
    -- not put it back. The staged rows keep for the next drain.
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
      v_status := 'in_transaction';

    -- firstStatement (#5403): a background drain must never run inside
    -- somebody's transaction block, written or not. The first statement of a
    -- transaction is the only one whose start time is the transaction's.
    ELSIF p_options->'firstStatement' = 'true'::JSONB
      AND statement_timestamp() <> transaction_timestamp() THEN
      v_status := 'in_transaction';

    -- A fixed snapshot (REPEATABLE READ / SERIALIZABLE) could read a stale
    -- MAX(seq), so it never allocates (#5271). The staged rows keep for a
    -- READ COMMITTED drain.
    ELSIF ${POSTGRES_FIXED_SNAPSHOT_ISOLATION} THEN
      v_status := 'fixed_snapshot';
    END IF;

    IF v_status IS NULL THEN
      -- Wait mode (#5403): with a positive waitMs the drain waits for the
      -- drain lock, the staging table's insert lock and the head, all inside
      -- ONE deadline. The budget is capped below the session's
      -- statement_timeout (so a slow pass ends as 'timeout', never as a
      -- cancelled statement) and applied before every blocking step.
      IF jsonb_typeof(p_options->'waitMs') = 'number'
        AND (p_options->>'waitMs')::DOUBLE PRECISION > 0 THEN
        v_wait := true;
        v_budget_ms := LEAST((p_options->>'waitMs')::DOUBLE PRECISION, ${POSTGRES_CHANGE_FEED_DRAIN_MAX_WAIT_MS});
        SELECT setting::DOUBLE PRECISION INTO v_statement_timeout_ms
        FROM pg_settings
        WHERE name = 'statement_timeout';
        IF v_statement_timeout_ms > 0 THEN
          v_budget_ms := LEAST(
            v_budget_ms,
            v_statement_timeout_ms
              - EXTRACT(EPOCH FROM clock_timestamp() - statement_timestamp()) * 1000
              - GREATEST(v_statement_timeout_ms / 10, 50)
          );
        END IF;
        v_deadline := clock_timestamp()
          + make_interval(secs => GREATEST(v_budget_ms, 0) / 1000);
      END IF;

      -- Every statement that can take a lock runs in this block (#5402). A
      -- pass that finds no work sets its status and raises
      -- ${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}; the handler below catches it, and that rollback
      -- releases everything the block took: the staging probe's lock, the
      -- drain lock, the feed table's insert lock and the head lock. Without
      -- it a skipped pass issued as the first statement of a caller
      -- transaction kept those locks until that transaction ended, and every
      -- other drain was refused meanwhile. Only a pass that sequenced or
      -- purged something commits the block and keeps its locks. (Leaving it
      -- with EXIT instead of the raise would commit it: that keeps the locks.)
      --
      -- Two phases follow, each in its own blocks (#5438): staged entries,
      -- then gap markers. Neither depends on the other's tables or outcome:
      -- a missing staging table or a failed staged phase still lets markers
      -- convert. A staged-phase error is reported (as the call's error row)
      -- only after the marker phase ran.
      IF to_regclass('_smrt_changes_pending') IS NULL THEN
        v_status := 'empty';
      ELSE
      BEGIN
      <<smrt_drain_pass>>
      BEGIN
${drainBudgetStep('        ')}
        -- Cheap common case: nothing staged, so an autocommit append pays one
        -- index probe rather than a drain.
        IF NOT EXISTS (SELECT 1 FROM _smrt_changes_pending LIMIT 1) THEN
          v_status := 'empty';
          RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';
        END IF;

        -- Without waitMs: try, never wait — a reader's drain must not become
        -- an edge in a cycle. Waiting for the drain lock is safe: nothing but
        -- another drain ever requests it.
${drainAdvisoryLockStep('        ', 'v_status')}

        -- The head lock (#5271) serializes this drain with direct appenders.
        -- Without waitMs it is only TRIED: a reader must never wait behind an
        -- appender's transaction, so when it is busy the drain returns and a
        -- later one sequences the staged rows. It is taken only when
        -- something will be sequenced, so a purge of sensitive rows alone
        -- never holds the head. The feed table's insert lock is NOWAIT for the
        -- same reason: a session holding SHARE on the feed table would
        -- otherwise make this drain wait for it. A refusal is a skipped pass,
        -- not an error.
        --
        -- In wait mode (#5403) the drain first takes the staging table's
        -- insert lock (so the sequencing statement below never waits for it),
        -- then waits for the head holding only the drain lock and that lock,
        -- neither of which a head holder requests, so the wait cannot close a
        -- cycle; the feed table's insert lock is then taken NOWAIT. It never
        -- waits for a relation lock while holding the head.
        --
        -- A role with only column-level INSERT on the feed table cannot LOCK
        -- it, so it takes the same lock BEFORE the head with a zero-row
        -- insert under a NOWAIT-equivalent 1 ms lock_timeout; a refusal is a
        -- skipped pass holding nothing. Its sequencing insert then re-uses a
        -- lock it already holds.
        v_has_candidate := EXISTS (
          SELECT 1
          FROM _smrt_changes_pending AS candidate
          WHERE NOT (
            candidate.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[]))
          )
        );
        IF v_has_candidate THEN
${drainHeadLockSteps('          ', 'v_status', POSTGRES_CHANGE_FEED_PENDING_TABLE)}
        END IF;

        -- The feed never records a sensitive table (#2982). Staged entries for
        -- one — from an older replica, or staged before the table was
        -- declared sensitive — are dropped here, before a sequence is
        -- allocated. Bounded like the sequencing batch, so a large legacy
        -- backlog cannot make one pass outlive statement_timeout and stall the
        -- feed; the remainder is purged by later passes, and the batch below
        -- skips it meanwhile.
        IF COALESCE(cardinality(p_excluded_tables), 0) > 0 THEN
${drainBudgetStep('          ')}
          DELETE FROM _smrt_changes_pending AS sensitive
          WHERE sensitive.pending_id IN (
            SELECT staged.pending_id
            FROM _smrt_changes_pending AS staged
            WHERE staged.table_name = ANY(p_excluded_tables)
            ORDER BY staged.pending_id
            LIMIT GREATEST(COALESCE(p_limit, ${POSTGRES_CHANGE_FEED_DRAIN_BATCH}), 1)
          );
          GET DIAGNOSTICS v_purged = ROW_COUNT;
        END IF;

        IF NOT v_has_candidate THEN
          IF v_purged = 0 THEN
            v_status := 'empty';
            RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';
          END IF;
          -- A purge is work: the block commits and keeps the deletion.
          v_status := 'drained';
          PERFORM set_config('lock_timeout', v_lock_timeout, true);
        ELSE
          -- Every lock the sequencing needs is held. Put lock_timeout back as
          -- the caller had it: a committed block keeps a local setting until
          -- the caller's transaction ends.
          PERFORM set_config('lock_timeout', v_lock_timeout, true);
          v_status := 'drained';
          v_sequencing := true;

          -- The batch runs in its own block and hands its rows back through
          -- v_entries, never through RETURN QUERY: rows a RETURN QUERY has
          -- appended stay in the result even when a later error rolls the
          -- block back (#5402). Its receipt is checked (#5438): every staged
          -- row it removed must have become exactly one feed row. A trigger
          -- that silently drops a feed insert would otherwise delete a staged
          -- entry with nothing to show for it. On a mismatch, or on an error
          -- attributable to a row, the batch is rolled back and the rows are
          -- moved one at a time below. Any other error ends the pass as
          -- before: it reaches the staged-phase boundary and becomes the
          -- call's error row, and the staged rows wait for a later pass.
          BEGIN
          SELECT COALESCE(MAX(changes.seq), 0) INTO v_base FROM _smrt_changes AS changes;
          WITH removed AS (
            DELETE FROM _smrt_changes_pending AS pending
            WHERE pending.pending_id IN (
              SELECT candidate.pending_id
              FROM _smrt_changes_pending AS candidate
              -- A sensitive row committed after the purge above is skipped,
              -- not sequenced; the next drain purges it.
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
            (SELECT count(*) FROM removed),
            count(*),
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'seq', inserted.seq,
                  'table_name', inserted.table_name,
                  'row_id', inserted.row_id,
                  'operation', inserted.operation,
                  'tenant_id', inserted.tenant_id::TEXT
                )
                ORDER BY inserted.seq
              ),
              '[]'::JSONB
            )
          INTO v_removed, v_inserted, v_entries
          FROM inserted;
          IF v_removed <> v_inserted THEN
            RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
          END IF;
          EXCEPTION
            WHEN query_canceled THEN
              RAISE;
            WHEN SQLSTATE '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}' THEN
              -- Variables survive a block's rollback; its rows do not.
              v_entries := '[]'::JSONB;
              v_isolate := true;
            WHEN OTHERS THEN
              v_entries := '[]'::JSONB;
              GET STACKED DIAGNOSTICS
                v_code = RETURNED_SQLSTATE,
                v_constraint = CONSTRAINT_NAME;
              IF NOT ${POSTGRES_CHANGE_FEED_ROW_ATTRIBUTABLE.replaceAll('\n', '\n              ')} THEN
                RAISE;
              END IF;
              v_isolate := true;
          END;

          -- Isolation (#5438): at most ${POSTGRES_CHANGE_FEED_ISOLATION_BATCH} rows, in staged order, each
          -- moved in its own block with the same receipt check and the same
          -- classification. A row refused for a reason of its own is replaced
          -- by a gap marker carrying its table, row id, operation and tenant;
          -- the staged row is deleted only after the marker's insert returned
          -- its row. A move that fails for any other reason (a lock timeout,
          -- a privilege or resource error) leaves that row staged and ends
          -- isolation for this pass, so a retryable failure never turns a
          -- deliverable entry into a marker. Still under every lock above.
          IF v_isolate THEN
            SELECT COALESCE(MAX(changes.seq), 0) INTO v_next FROM _smrt_changes AS changes;
            <<smrt_drain_isolation>>
            FOR v_staged IN
              SELECT
                candidate.pending_id,
                candidate.table_name,
                candidate.row_id,
                candidate.operation,
                NULLIF(candidate.tenant_id::TEXT, '') AS tenant_text,
                candidate.created_at
              FROM _smrt_changes_pending AS candidate
              WHERE ${POSTGRES_CHANGE_FEED_NOT_EXCLUDED('candidate')}
              ORDER BY candidate.pending_id
              LIMIT ${POSTGRES_CHANGE_FEED_ISOLATION_BATCH}
            LOOP
              v_mark := false;
              BEGIN
                DELETE FROM _smrt_changes_pending AS pending
                WHERE pending.pending_id = v_staged.pending_id;
                GET DIAGNOSTICS v_removed = ROW_COUNT;
                INSERT INTO _smrt_changes (
                  seq,
                  table_name,
                  row_id,
                  operation,
                  tenant_id,
                  created_at
                )
                VALUES (
                  v_next + 1,
                  v_staged.table_name,
                  v_staged.row_id,
                  v_staged.operation,
                  ${postgresTenantIdAs('_smrt_changes', 'v_staged.tenant_text')},
                  v_staged.created_at
                )
                RETURNING _smrt_changes.seq, _smrt_changes.tenant_id::TEXT
                INTO v_seq, v_canonical;
                GET DIAGNOSTICS v_inserted = ROW_COUNT;
                IF v_removed <> 1 OR v_inserted <> 1 THEN
                  RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
                END IF;
                v_next := GREATEST(v_next + 1, v_seq);
                v_entries := v_entries || jsonb_build_array(
                  jsonb_build_object(
                    'seq', v_seq,
                    'table_name', v_staged.table_name,
                    'row_id', v_staged.row_id,
                    'operation', v_staged.operation,
                    'tenant_id', v_canonical
                  )
                );
              EXCEPTION
                WHEN query_canceled THEN
                  RAISE;
                WHEN SQLSTATE '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}' THEN
                  v_mark := true;
                WHEN OTHERS THEN
                  GET STACKED DIAGNOSTICS
                    v_code = RETURNED_SQLSTATE,
                    v_constraint = CONSTRAINT_NAME,
                    v_detail = MESSAGE_TEXT;
                  IF ${POSTGRES_CHANGE_FEED_ROW_ATTRIBUTABLE.replaceAll('\n', '\n                  ')} THEN
                    v_mark := true;
                  ELSE
                    v_staged_error_code := v_code;
                    v_staged_error_message := v_detail;
                    EXIT smrt_drain_isolation;
                  END IF;
              END;
              IF v_mark THEN
                BEGIN
                  INSERT INTO ${CHANGE_FEED_GAPS_TABLE} (
                    table_name,
                    row_id,
                    operation,
                    tenant_key,
                    created_at
                  )
                  VALUES (
                    v_staged.table_name,
                    v_staged.row_id,
                    v_staged.operation,
                    v_staged.tenant_text,
                    clock_timestamp()
                  )
                  RETURNING ${CHANGE_FEED_GAPS_TABLE}.gap_id::TEXT INTO v_gap_id;
                  IF v_gap_id IS NULL THEN
                    RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
                  END IF;
                  DELETE FROM _smrt_changes_pending AS pending
                  WHERE pending.pending_id = v_staged.pending_id;
                  GET DIAGNOSTICS v_removed = ROW_COUNT;
                  IF v_removed <> 1 THEN
                    RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
                  END IF;
                  v_isolated := v_isolated + 1;
                EXCEPTION
                  WHEN query_canceled THEN
                    RAISE;
                  WHEN OTHERS THEN
                    -- No marker, so the staged row stays exactly as it was.
                    GET STACKED DIAGNOSTICS
                      v_staged_error_code = RETURNED_SQLSTATE,
                      v_staged_error_message = MESSAGE_TEXT;
                    EXIT smrt_drain_isolation;
                END;
              END IF;
            END LOOP;
            IF v_isolated > 0 THEN
              v_notes := v_notes || ('isolated=' || v_isolated);
            END IF;
            IF v_isolated = 0 AND jsonb_array_length(v_entries) = 0 THEN
              -- Nothing moved: release this pass's locks. The error that
              -- stopped isolation (if any) is the call's error row below.
              IF v_staged_error_code IS NULL THEN
                v_status := 'empty';
              END IF;
              IF v_purged = 0 THEN
                RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';
              END IF;
            ELSIF v_staged_error_code IS NOT NULL THEN
              -- Some rows moved: they stand, and the rest wait for a later
              -- pass. The stop is noted on the status row, not raised.
              v_notes := v_notes || ('isolation stopped: ' || v_staged_error_code);
              v_staged_error_code := NULL;
              v_staged_error_message := NULL;
            END IF;
          END IF;
        END IF;
      EXCEPTION
        WHEN SQLSTATE '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}' THEN
          NULL;
        -- A lock wait that ran out of budget (or out of the caller's own
        -- lock_timeout) is a timed-out pass holding nothing. Not once the
        -- sequencing statement has started: its error must reach the
        -- boundary below as an error row, which voids any entry rows.
        WHEN lock_not_available THEN
          IF v_sequencing THEN
            RAISE;
          END IF;
          v_status := 'timeout';
      END;
      EXCEPTION
        WHEN query_canceled THEN
          RAISE;
        WHEN OTHERS THEN
          -- The staged phase failed and rolled back (#5438). The marker
          -- phase still runs; this error becomes the call's error row.
          GET STACKED DIAGNOSTICS
            v_staged_error_code = RETURNED_SQLSTATE,
            v_staged_error_message = MESSAGE_TEXT;
          v_entries := '[]'::JSONB;
          v_isolated := 0;
          v_notes := ARRAY[]::TEXT[];
      END;
      END IF;

      -- Gap markers (#5438), in blocks of their own. A marker is given a
      -- feed position (a row with row_id NULL and the stored operation
      -- 'gap') only while the delivery setting is present in _smrt_backfills,
      -- read under the drain lock and locked FOR SHARE, so the setting
      -- cannot be removed while a pass that saw it is converting; under a
      -- fixed snapshot nothing gets here at all (preflight above). Each
      -- marker converts in its own block: the feed insert must return exactly
      -- one row, then the marker records converted_seq and the feed row's
      -- canonical tenant text and stays as evidence. A marker whose
      -- conversion fails is flagged blocked_at and skipped by ordinary
      -- passes; later markers proceed. Nothing here ever deletes a marker,
      -- except those of a table in the live sensitive set (#2937).
      IF to_regclass('${CHANGE_FEED_GAPS_TABLE}') IS NULL THEN
        v_gap_status := 'empty';
      ELSE
      BEGIN
      <<smrt_drain_gaps>>
      BEGIN
${drainBudgetStep('        ', 'v_gap_status')}
        -- Cheap common case: no marker waiting and none of a sensitive
        -- table, so a pass pays one index probe and takes no lock it keeps.
        IF NOT EXISTS (
          SELECT 1
          FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
          WHERE marker.converted_seq IS NULL
            AND marker.reconciled_at IS NULL
          LIMIT 1
        ) AND (
          COALESCE(cardinality(p_excluded_tables), 0) = 0
          OR NOT EXISTS (
            SELECT 1
            FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
            WHERE marker.table_name = ANY(p_excluded_tables)
            LIMIT 1
          )
        ) THEN
          v_gap_status := 'empty';
          RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';
        END IF;

${drainAdvisoryLockStep('        ', 'v_gap_status')}

        IF COALESCE(cardinality(p_excluded_tables), 0) > 0 THEN
${drainBudgetStep('          ', 'v_gap_status')}
          DELETE FROM ${CHANGE_FEED_GAPS_TABLE} AS sensitive
          WHERE sensitive.gap_id IN (
            SELECT marker.gap_id
            FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
            WHERE marker.table_name = ANY(p_excluded_tables)
            LIMIT GREATEST(COALESCE(p_limit, ${POSTGRES_CHANGE_FEED_DRAIN_BATCH}), 1)
          );
          GET DIAGNOSTICS v_gap_purged = ROW_COUNT;
        END IF;

        -- The plain read first: the row lock needs more than SELECT, and a
        -- database where delivery was never enabled should never ask for it.
        IF to_regclass('_smrt_backfills') IS NOT NULL AND EXISTS (
          SELECT 1
          FROM _smrt_backfills AS setting
          WHERE setting.name = '${CHANGE_FEED_GAP_DELIVERY_SETTING}'
        ) THEN
${drainBudgetStep('          ', 'v_gap_status')}
          IF v_wait THEN
            PERFORM 1
            FROM _smrt_backfills AS setting
            WHERE setting.name = '${CHANGE_FEED_GAP_DELIVERY_SETTING}'
            FOR SHARE OF setting;
          ELSE
            PERFORM 1
            FROM _smrt_backfills AS setting
            WHERE setting.name = '${CHANGE_FEED_GAP_DELIVERY_SETTING}'
            FOR SHARE OF setting NOWAIT;
          END IF;
          v_gap_enabled := FOUND;
        END IF;

        IF NOT v_gap_enabled OR NOT EXISTS (
          SELECT 1
          FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
          WHERE marker.converted_seq IS NULL
            AND marker.reconciled_at IS NULL
            AND (marker.blocked_at IS NULL OR v_retry_blocked)
            AND ${POSTGRES_CHANGE_FEED_NOT_EXCLUDED('marker')}
        ) THEN
          IF v_gap_purged = 0 THEN
            v_gap_status := 'empty';
            RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}';
          END IF;
          v_gap_status := 'drained';
          PERFORM set_config('lock_timeout', v_lock_timeout, true);
        ELSE
${drainHeadLockSteps('          ', 'v_gap_status', CHANGE_FEED_GAPS_TABLE)}
          PERFORM set_config('lock_timeout', v_lock_timeout, true);
          v_gap_status := 'drained';
          SELECT COALESCE(MAX(changes.seq), 0) INTO v_next FROM _smrt_changes AS changes;
          FOR v_marker IN
            SELECT marker.gap_id, marker.table_name, marker.tenant_key
            FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
            WHERE marker.converted_seq IS NULL
              AND marker.reconciled_at IS NULL
              AND (marker.blocked_at IS NULL OR v_retry_blocked)
              AND ${POSTGRES_CHANGE_FEED_NOT_EXCLUDED('marker')}
            ORDER BY marker.created_at, marker.gap_id
            LIMIT ${POSTGRES_CHANGE_FEED_GAP_BATCH}
          LOOP
            BEGIN
              INSERT INTO _smrt_changes (
                seq,
                table_name,
                row_id,
                operation,
                tenant_id,
                created_at
              )
              VALUES (
                v_next + 1,
                v_marker.table_name,
                NULL,
                'gap',
                ${postgresTenantIdAs('_smrt_changes', 'v_marker.tenant_key')},
                clock_timestamp()
              )
              RETURNING _smrt_changes.seq, _smrt_changes.tenant_id::TEXT
              INTO v_seq, v_canonical;
              GET DIAGNOSTICS v_inserted = ROW_COUNT;
              IF v_inserted <> 1 THEN
                RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
              END IF;
              UPDATE ${CHANGE_FEED_GAPS_TABLE} AS marker
              SET converted_seq = v_seq,
                tenant_key = v_canonical,
                blocked_at = NULL
              WHERE marker.gap_id = v_marker.gap_id
                AND marker.converted_seq IS NULL
                AND marker.reconciled_at IS NULL;
              GET DIAGNOSTICS v_removed = ROW_COUNT;
              IF v_removed <> 1 THEN
                RAISE EXCEPTION USING ERRCODE = '${POSTGRES_CHANGE_FEED_RECEIPT_SQLSTATE}';
              END IF;
              v_next := GREATEST(v_next + 1, v_seq);
              v_gap_first := LEAST(COALESCE(v_gap_first, v_seq), v_seq);
              v_gap_last := GREATEST(COALESCE(v_gap_last, v_seq), v_seq);
              v_converted := v_converted + 1;
            EXCEPTION
              WHEN query_canceled THEN
                RAISE;
              WHEN OTHERS THEN
                BEGIN
                  UPDATE ${CHANGE_FEED_GAPS_TABLE} AS marker
                  SET blocked_at = clock_timestamp()
                  WHERE marker.gap_id = v_marker.gap_id
                    AND marker.converted_seq IS NULL;
                  v_blocked := v_blocked + 1;
                EXCEPTION
                  WHEN query_canceled THEN
                    RAISE;
                  WHEN OTHERS THEN
                    NULL;
                END;
            END;
          END LOOP;
        END IF;
      EXCEPTION
        WHEN SQLSTATE '${POSTGRES_CHANGE_FEED_NO_WORK_SQLSTATE}' THEN
          NULL;
        WHEN lock_not_available THEN
          v_gap_status := 'timeout';
      END;
      EXCEPTION
        WHEN query_canceled THEN
          RAISE;
        WHEN OTHERS THEN
          -- The marker phase rolled back as a whole; the staged phase stands.
          GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
          v_gap_status := 'error';
          v_gap_first := NULL;
          v_gap_last := NULL;
          v_converted := 0;
          v_blocked := 0;
          v_gap_enabled := false;
          v_notes := v_notes || ('gaps: ' || v_code);
      END;
      END IF;
      IF v_converted > 0 THEN
        v_notes := v_notes || ('gaps converted=' || v_converted);
      END IF;
      IF v_blocked > 0 THEN
        v_notes := v_notes || ('gaps blocked=' || v_blocked);
      END IF;
      -- One status for the call: work in either phase is 'drained';
      -- otherwise the staged phase's status, unless it found nothing staged,
      -- in which case the marker phase's.
      v_staged_status := v_status;
      IF v_status = 'drained' OR v_gap_status = 'drained' THEN
        v_status := 'drained';
      ELSIF v_status = 'empty'
        AND v_gap_status NOT IN ('empty', 'error') THEN
        v_status := v_gap_status;
      END IF;
    END IF;

    -- The status is computed in its own block, so nothing here can roll back
    -- the sequencing above; a failure only leaves the extras unknown.
    -- backlog_remaining: whether a committed, non-sensitive staged row is
    -- still visible after this pass, or (#5438) an unconverted, unblocked,
    -- unreconciled marker while delivery is enabled (NULL when it cannot be
    -- told). helpers_current: whether the other five helper identities carry
    -- this body's marker; skipped on the common empty pass.
    v_staged_status := COALESCE(v_staged_status, v_status);
    BEGIN
      IF v_staged_status = 'drained' THEN
        -- This pass still holds its staging-table lock, so this read never
        -- waits.
        v_backlog := EXISTS (
          SELECT 1
          FROM _smrt_changes_pending AS remaining
          WHERE NOT (
            remaining.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[]))
          )
        );
      ELSIF v_staged_status = 'empty' THEN
        v_backlog := false;
      ELSIF v_staged_status IN ('relation_busy', 'head_busy', 'timeout')
        AND v_has_candidate THEN
        v_backlog := true;
      END IF;
      IF v_gap_enabled
        AND v_gap_status IN ('drained', 'drain_busy', 'relation_busy', 'head_busy', 'timeout') THEN
        v_gap_backlog := EXISTS (
          SELECT 1
          FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
          WHERE marker.converted_seq IS NULL
            AND marker.reconciled_at IS NULL
            AND marker.blocked_at IS NULL
            AND ${POSTGRES_CHANGE_FEED_NOT_EXCLUDED('marker')}
        );
      ELSE
        v_gap_backlog := false;
      END IF;
      v_backlog := v_backlog OR v_gap_backlog;
      IF v_status <> 'empty' THEN
        v_helpers := (
          SELECT count(*) = 5
          FROM pg_proc AS helper
          WHERE helper.oid IN (
            to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}'),
            to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION_IDENTITY}'),
            to_regprocedure('${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY}'),
            to_regprocedure('${POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION_IDENTITY}'),
            to_regprocedure('${POSTGRES_CHANGE_FEED_VERSION_FUNCTION_IDENTITY}')
          )
            AND helper.prosrc LIKE '%${POSTGRES_CHANGE_FEED_HELPER_MARKER}%'
        );
      END IF;
    EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
      v_backlog := NULL;
      v_helpers := NULL;
    END;

    -- Rows only now, after every phase has committed its block (#5438):
    -- the sequenced entries, then (when markers were converted) one
    -- allocation row, then the status row, or the staged phase's error row
    -- in its place. The allocation row carries the first and last sequence
    -- the marker phase allocated, as text in drained_row_id and
    -- drained_tenant_id, with drained_seq NULL and drained_operation
    -- 'allocated': every parser that keys entries on drained_seq ignores it,
    -- so no gap row is ever returned, counted or signalled as an entry,
    -- while a current parser holds back reads at or above the range.
    RETURN QUERY SELECT
      entry.seq,
      entry.table_name,
      entry.row_id,
      entry.operation,
      entry.tenant_id,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::BOOLEAN,
      NULL::BOOLEAN
    FROM jsonb_to_recordset(v_entries) AS entry(
      seq BIGINT,
      table_name TEXT,
      row_id TEXT,
      operation TEXT,
      tenant_id TEXT
    )
    ORDER BY entry.seq;
    IF v_gap_first IS NOT NULL THEN
      RETURN QUERY SELECT
        NULL::BIGINT,
        NULL::TEXT,
        v_gap_first::TEXT,
        'allocated'::TEXT,
        v_gap_last::TEXT,
        NULL::TEXT,
        NULL::TEXT,
        NULL::TEXT,
        NULL::BOOLEAN,
        NULL::BOOLEAN;
    END IF;
    IF v_staged_error_code IS NOT NULL THEN
      RETURN QUERY SELECT
        NULL::BIGINT,
        NULL::TEXT,
        NULL::TEXT,
        NULL::TEXT,
        NULL::TEXT,
        v_staged_error_code,
        v_staged_error_message,
        NULL::TEXT,
        NULL::BOOLEAN,
        NULL::BOOLEAN;
      RETURN;
    END IF;

    RETURN QUERY SELECT
      NULL::BIGINT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULL::TEXT,
      NULLIF(array_to_string(v_notes, '; '), ''),
      v_status,
      v_backlog,
      v_helpers;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    -- No status row follows an error row. Entry rows appended before the
    -- error may still be in the result; callers must discard every entry of
    -- a call that returned an error row.
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
      v_error_message,
      NULL::TEXT,
      NULL::BOOLEAN,
      NULL::BOOLEAN;
  END;
END;
$smrt_change_feed_drain_status$;
`;

/**
 * Two-argument drain (#2982), a delegator since #5402: it calls the status
 * drain with no options and returns only its entry and error rows, so its
 * columns are unchanged for every caller (current SMRT on a handle that may
 * be inside a caller transaction, and older replicas during a rollout).
 *
 * It keeps its own exception boundary: a role that may execute this identity
 * but not the status drain gets `42501` back as an error row, and the
 * caller's transaction is never aborted (#2026).
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
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    RETURN QUERY
    SELECT
      drained.drained_seq,
      drained.drained_table,
      drained.drained_row_id,
      drained.drained_operation,
      drained.drained_tenant_id,
      drained.error_code,
      drained.error_message
    FROM ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_NAME}(
      p_limit,
      p_excluded_tables,
      '{}'::JSONB
    ) AS drained
    WHERE drained.status IS NULL;
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
 * The per-table version read behind `getTableVersion()` on PostgreSQL
 * (#5438).
 *
 * One statement, so every term comes from one snapshot: the table's
 * `MAX(seq)`, the feed's horizon, the table's staged count and the table's
 * markers that are not converted (unconverted, blocked and reconciled ones:
 * each stands for a change the table's `MAX(seq)` does not show). Converting a
 * marker adds a sequence and removes it from the count in one transaction, so
 * the sum never decreases.
 *
 * Inside its own exception boundary, `query_canceled` included: any failure
 * (a missing staging or gap table, a role that may not read the gap table)
 * returns `known = false` instead of raising, so a version read issued inside
 * a caller's transaction never aborts it. The caller then serves an
 * unrepeatable value, which no cached validator can match.
 */
export const CREATE_POSTGRES_CHANGE_FEED_VERSION_FUNCTION = `
CREATE OR REPLACE FUNCTION ${POSTGRES_CHANGE_FEED_VERSION_FUNCTION_NAME}(
  p_table TEXT
)
RETURNS TABLE(
  table_version BIGINT,
  horizon BIGINT,
  staged BIGINT,
  markers BIGINT,
  known BOOLEAN
)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $smrt_change_feed_version$
${POSTGRES_CHANGE_FEED_HELPER_MARKER_LINES}
BEGIN
  BEGIN
    RETURN QUERY
    SELECT
      (SELECT MAX(changes.seq) FROM _smrt_changes AS changes
        WHERE changes.table_name = p_table),
      (SELECT MAX(changes.seq) FROM _smrt_changes AS changes),
      (SELECT count(*) FROM _smrt_changes_pending AS pending
        WHERE pending.table_name = p_table),
      (SELECT count(*) FROM ${CHANGE_FEED_GAPS_TABLE} AS marker
        WHERE marker.table_name = p_table
          AND marker.converted_seq IS NULL),
      true;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    RETURN QUERY SELECT NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, false;
  END;
END;
$smrt_change_feed_version$;
`;

/**
 * The append helpers' fallback (#5438), placed in the direct block's
 * exception handler: a direct allocation that failed on contention is staged
 * in the same statement instead of being dropped.
 *
 * - Eligible: a lock timeout (`55P03`), a deadlock (`40P01`), or a duplicate
 *   on the feed's own sequence key (`23505` whose `CONSTRAINT_NAME` is the
 *   live primary-key constraint of `_smrt_changes`). A cancelled statement
 *   (`57014`) stays an error: staging after a cancel would change what a
 *   cancel means. Every other SQLSTATE (data, privilege) is returned as
 *   before, so nothing is staged the drain could never sequence.
 * - The tenant id is first converted to the FEED table's live column type.
 *   The direct block may have failed on a lock before it reached that
 *   conversion, and a value only the staging column accepts (TEXT staging,
 *   uuid feed, mid `db:migrate-uuid`) would make every drain batch fail
 *   behind it.
 * - The staging table's insert lock is taken without waiting (`NOWAIT`; a
 *   role without a table-level privilege for it gets a 1 ms local
 *   `lock_timeout` instead, restored after the insert): after a lock timeout
 *   nothing else bounds a second wait.
 * - Any failure while staging returns the original error and stages nothing.
 * - Staged: `error_code` NULL, the original SQLSTATE and message noted in
 *   `error_message` (the single helper's one row; the batch helper's one row
 *   per entry, the same shape as its staged branch).
 */
function postgresAppendFallback(parts: {
  /** Extra condition; the batch requires a direct path that emitted nothing. */
  eligible: string;
  /** Convert every tenant id to the feed table's live type. */
  validate: string;
  /** The staged insert (and, for the batch, its RETURN QUERY). */
  stage: string;
  /** What follows a successful stage, before RETURN. */
  staged: string;
}): string {
  return `    IF v_error_code IN ('55P03', '40P01')
      OR (
        v_error_code = '23505'
        AND v_constraint = (
          SELECT c.conname
          FROM pg_constraint AS c
          WHERE c.conrelid = to_regclass('_smrt_changes')
            AND c.contype = 'p'
        )
      ) THEN
      IF ${parts.eligible} THEN
        BEGIN
          v_note := 'staged after ' || v_error_code || ': ' || v_error_message;
          ${parts.validate}
          IF has_table_privilege('_smrt_changes_pending', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
            LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE NOWAIT;
          ELSE
            v_lock_timeout := current_setting('lock_timeout');
            PERFORM set_config('lock_timeout', '1ms', true);
          END IF;
          ${parts.stage}
          IF v_lock_timeout IS NOT NULL THEN
            PERFORM set_config('lock_timeout', v_lock_timeout, true);
          END IF;
          ${parts.staged}
          RETURN;
        EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
          NULL;
        END;
      END IF;
    END IF;`;
}

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
  v_constraint TEXT;
  v_note TEXT;
  v_lock_timeout TEXT;
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
      v_error_message = MESSAGE_TEXT,
      v_constraint = CONSTRAINT_NAME;
${postgresAppendFallback({
  eligible: 'TRUE',
  validate: `PERFORM ${postgresTenantIdAs('_smrt_changes', 'p_tenant_id')};`,
  stage: `INSERT INTO _smrt_changes_pending (
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
        );`,
  staged: 'RETURN QUERY SELECT NULL::BIGINT, NULL::TEXT, v_note;',
})}
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
  v_base BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
  v_constraint TEXT;
  v_note TEXT;
  v_lock_timeout TEXT;
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

    -- The insert runs as its own statement and the rows are returned only
    -- after it succeeded (#5438): a failure can then never leave allocated
    -- rows in the result ahead of the fallback's staged ones.
    SELECT COALESCE((SELECT MAX(seq) FROM _smrt_changes), 0) INTO v_base;
    INSERT INTO _smrt_changes (
      seq, table_name, row_id, operation, tenant_id, created_at
    )
    SELECT
      v_base + entries.ordinality,
      entries.value->>'table',
      entries.value->>'rowId',
      entries.value->>'operation',
      ${postgresTenantIdAs('_smrt_changes', "entries.value->>'tenantId'")},
      (entries.value->>'timestamp')::TIMESTAMPTZ
    FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
      WITH ORDINALITY AS entries(value, ordinality)
    ORDER BY entries.ordinality;

    RETURN QUERY
    SELECT
      entries.ordinality::INTEGER - 1,
      v_base + entries.ordinality,
      NULL::TEXT,
      NULL::TEXT
    FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb))
      WITH ORDINALITY AS entries(value, ordinality)
    ORDER BY entries.ordinality;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT,
      v_constraint = CONSTRAINT_NAME;
${postgresAppendFallback({
  eligible: 'v_deferred IS FALSE',
  validate: `PERFORM count(${postgresTenantIdAs('_smrt_changes', "entries.value->>'tenantId'")})
        FROM jsonb_array_elements(COALESCE(p_entries, '[]'::jsonb)) AS entries(value);`,
  stage: `RETURN QUERY
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
        SELECT input.entry_index, NULL::BIGINT, NULL::TEXT, v_note
        FROM input
        ORDER BY input.entry_index;`,
  staged: 'RETURN;',
})}
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
    .concat(
      // The gap table (#5438) travels with the helpers that write and read
      // it, like the staging table: a database whose helpers are installed
      // outside the system-table bootstrap still gets it, so the version
      // routine never runs without its table.
      CREATE_POSTGRES_SMRT_CHANGE_GAPS_TABLE.split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
        .map(
          (statement) => `EXECUTE $smrt_change_feed_gaps_ddl$
${statement}
$smrt_change_feed_gaps_ddl$;`,
        ),
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
 *
 * The status drain (#5402) is created first, since both older identities
 * delegate to it. Its owner and EXECUTE grantees are then made equal to the
 * two-argument drain's, so it never has more callers than the entry point it
 * backs: a new function would otherwise take PostgreSQL's default ACL plus any
 * default privileges, and one created by a member of the owning role would be
 * owned by that member. The grantee sets are compared normalised
 * (`acldefault` stands in for a NULL ACL, grantor and grant option ignored).
 * If they cannot be made equal the block raises, and the whole installation
 * rolls back: the database keeps the helpers it had.
 */
const POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES = (identity: string) => `
          SELECT acl.grantee
          FROM pg_proc AS p,
            aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE p.oid = to_regprocedure('${identity}')
            AND acl.privilege_type = 'EXECUTE'`;

const POSTGRES_CHANGE_FEED_DRAIN_STATUS_ACL_DIFFERS = (
  identity: string,
) => `EXISTS (
        (${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(identity)}
         EXCEPT
         ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY)})
        UNION ALL
        (${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY)}
         EXCEPT
         ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(identity)})
      )`;

/**
 * Make a routine's owner and normalised EXECUTE grantees equal to the
 * two-argument drain's (#5402), or raise and roll back the whole helper
 * installation. Used for the status drain and, since #5438, the version
 * routine: neither may ever have more callers than the entry point the
 * permissions planner reconciles.
 */
function reconcileRoutineWithDrain(identity: string): string {
  return `    SELECT p.proowner INTO v_source_owner FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY}');
    SELECT p.proowner INTO v_status_owner FROM pg_proc AS p
    WHERE p.oid = to_regprocedure('${identity}');
    IF v_status_owner IS DISTINCT FROM v_source_owner THEN
      EXECUTE format(
        'ALTER FUNCTION ${identity} OWNER TO %I',
        pg_get_userbyid(v_source_owner)
      );
    END IF;
    IF ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_ACL_DIFFERS(identity)} THEN
      FOR v_grant IN
        ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(identity)}
        EXCEPT
        ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY)}
      LOOP
        IF v_grant.grantee = 0 THEN
          EXECUTE 'REVOKE EXECUTE ON FUNCTION ${identity} FROM PUBLIC';
        ELSE
          EXECUTE format(
            'REVOKE EXECUTE ON FUNCTION ${identity} FROM %I',
            pg_get_userbyid(v_grant.grantee)
          );
        END IF;
      END LOOP;
      FOR v_grant IN
        ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY)}
        EXCEPT
        ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_GRANTEES(identity)}
      LOOP
        IF v_grant.grantee = 0 THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION ${identity} TO PUBLIC';
        ELSE
          EXECUTE format(
            'GRANT EXECUTE ON FUNCTION ${identity} TO %I',
            pg_get_userbyid(v_grant.grantee)
          );
        END IF;
      END LOOP;
      IF ${POSTGRES_CHANGE_FEED_DRAIN_STATUS_ACL_DIFFERS(identity)} THEN
        RAISE EXCEPTION
          'EXECUTE on ${identity} could not be made equal to ${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY}; the change-feed helpers were not installed'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;`;
}

const POSTGRES_CHANGE_FEED_DRAIN_INSTALL = `  DECLARE
    v_drain_created BOOLEAN :=
      to_regprocedure('${POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY}') IS NULL;
    v_grant RECORD;
    v_source_owner OID;
    v_status_owner OID;
  BEGIN
    EXECUTE $smrt_change_feed_drain_status_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION.trim()}
$smrt_change_feed_drain_status_ddl$;
    EXECUTE $smrt_change_feed_drain_ddl$
${CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_ddl$;
    EXECUTE $smrt_change_feed_drain_compat_ddl$
${CREATE_POSTGRES_CHANGE_FEED_COMPAT_DRAIN_FUNCTION.trim()}
$smrt_change_feed_drain_compat_ddl$;
    EXECUTE $smrt_change_feed_version_ddl$
${CREATE_POSTGRES_CHANGE_FEED_VERSION_FUNCTION.trim()}
$smrt_change_feed_version_ddl$;
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

${reconcileRoutineWithDrain(POSTGRES_CHANGE_FEED_DRAIN_STATUS_FUNCTION_IDENTITY)}
${reconcileRoutineWithDrain(POSTGRES_CHANGE_FEED_VERSION_FUNCTION_IDENTITY)}
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
  CREATE_SMRT_CHANGE_GAPS_TABLE,
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
  const integerDdl = renderChangeGapsId(
    engine === 'postgres' || engine === 'duckdb' || engine === 'json'
      ? ddl.replace(/\bINTEGER\b/g, 'BIGINT')
      : ddl,
    engine,
  );
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
// 1.21.0 adds `_smrt_change_gaps`, the change-feed gap markers, with its
// `table_name` and `converted_seq` indexes (#5438).
export const SMRT_SCHEMA_VERSION = '1.21.0';

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
    '1.21.0':
      '7e72edb2ce0e54e5bf956644c320431a1ed3854d8be6a697fd15bbf8f7770b14',
  });
