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
export declare const CREATE_SMRT_CONTEXTS_TABLE = "\nCREATE TABLE IF NOT EXISTS _smrt_contexts (\n  id TEXT PRIMARY KEY,\n  owner_class TEXT NOT NULL,\n  owner_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  key TEXT NOT NULL,\n  value TEXT,\n  metadata TEXT,\n  version INTEGER DEFAULT 1,\n  confidence REAL DEFAULT 1.0,\n  success_count INTEGER DEFAULT 0,\n  failure_count INTEGER DEFAULT 0,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  last_used_at DATETIME,\n  expires_at DATETIME,\n  UNIQUE(owner_class, owner_id, scope, key, version)\n);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_contexts_owner\n  ON _smrt_contexts(owner_class, owner_id);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_contexts_scope\n  ON _smrt_contexts(scope);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_contexts_confidence\n  ON _smrt_contexts(confidence);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_contexts_last_used\n  ON _smrt_contexts(last_used_at);\n";
/**
 * Schema version tracking
 * Records which SMRT framework versions have been applied
 */
export declare const CREATE_SMRT_MIGRATIONS_TABLE = "\nCREATE TABLE IF NOT EXISTS _smrt_migrations (\n  id TEXT PRIMARY KEY,\n  version TEXT NOT NULL UNIQUE,\n  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n  description TEXT,\n  checksum TEXT\n);\n";
/**
 * Runtime object registry persistence
 * Stores metadata about registered SMRT objects for introspection
 */
export declare const CREATE_SMRT_REGISTRY_TABLE = "\nCREATE TABLE IF NOT EXISTS _smrt_registry (\n  class_name TEXT PRIMARY KEY,\n  schema_version TEXT,\n  fields TEXT,\n  relationships TEXT,\n  config TEXT,\n  manifest TEXT,\n  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n";
/**
 * Signal history/audit log
 * Optional persistence of signals for debugging and auditing
 */
export declare const CREATE_SMRT_SIGNALS_TABLE = "\nCREATE TABLE IF NOT EXISTS _smrt_signals (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  source_class TEXT,\n  source_id TEXT,\n  target_class TEXT,\n  target_id TEXT,\n  payload TEXT,\n  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP\n);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_signals_source\n  ON _smrt_signals(source_class, source_id);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_signals_type\n  ON _smrt_signals(type);\n\nCREATE INDEX IF NOT EXISTS idx_smrt_signals_timestamp\n  ON _smrt_signals(timestamp);\n";
/**
 * All system table creation statements
 */
export declare const ALL_SYSTEM_TABLES: string[];
/**
 * Current SMRT system schema version
 */
export declare const SMRT_SCHEMA_VERSION = "1.0.0";
//# sourceMappingURL=schema.d.ts.map