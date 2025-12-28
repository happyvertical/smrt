/**
 * SMRT System Tables Schema
 *
 * System tables use _smrt_ prefix to avoid conflicts with user tables.
 * All system tables are created in the same database as user data.
 */

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  expires_at DATETIME,
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
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  checksum TEXT
);
`;

/**
 * Runtime object registry persistence
 * Stores metadata about registered SMRT objects for introspection
 */
export const CREATE_SMRT_REGISTRY_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_registry (
  class_name TEXT PRIMARY KEY,
  schema_version TEXT,
  fields TEXT,
  relationships TEXT,
  config TEXT,
  manifest TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Signal history/audit log
 * Optional persistence of signals for debugging and auditing
 */
export const CREATE_SMRT_SIGNALS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_signals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_class TEXT,
  source_id TEXT,
  target_class TEXT,
  target_id TEXT,
  payload TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_source
  ON _smrt_signals(source_class, source_id);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_type
  ON _smrt_signals(type);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_timestamp
  ON _smrt_signals(timestamp);
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
  processed_at DATETIME,
  processed_by TEXT,
  metadata TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_status
  ON _smrt_dispatch(status);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_type
  ON _smrt_dispatch(type);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_source
  ON _smrt_dispatch(source);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_created
  ON _smrt_dispatch(created_at);
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
  enabled INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(signal_type, subscriber)
);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_subscriber
  ON _smrt_dispatch_subscriptions(subscriber);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_signal_type
  ON _smrt_dispatch_subscriptions(signal_type);

CREATE INDEX IF NOT EXISTS idx_smrt_dispatch_subs_enabled
  ON _smrt_dispatch_subscriptions(enabled);
`;

/**
 * All system table creation statements
 */
export const ALL_SYSTEM_TABLES = [
  CREATE_SMRT_CONTEXTS_TABLE,
  CREATE_SMRT_MIGRATIONS_TABLE,
  CREATE_SMRT_REGISTRY_TABLE,
  CREATE_SMRT_SIGNALS_TABLE,
  CREATE_SMRT_EMBEDDINGS_TABLE,
  CREATE_SMRT_DISPATCH_TABLE,
  CREATE_SMRT_DISPATCH_SUBSCRIPTIONS_TABLE,
];

/**
 * Current SMRT system schema version
 */
export const SMRT_SCHEMA_VERSION = '1.1.0';
