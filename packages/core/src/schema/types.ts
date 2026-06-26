/**
 * Schema definition types for SMRT objects
 * Used for build-time schema generation and runtime table management
 */

export type SQLDataType =
  | 'TEXT'
  | 'INTEGER'
  | 'REAL'
  | 'BLOB'
  | 'BOOLEAN'
  | 'JSON'
  | 'TIMESTAMP'
  // UUID is an abstract id type (R11). Per-dialect mapping: native `uuid`
  // on PostgreSQL, native `UUID` on DuckDB, and `TEXT` on SQLite (which has
  // no uuid type). The differ tolerates UUID/TEXT drift only for structural
  // ID/reference columns — see `isUuidTextEquivalentColumn` in differ.ts.
  | 'UUID';

export interface ColumnDefinition {
  type: SQLDataType;
  primaryKey?: boolean;
  /**
   * Non-DDL marker for SMRT-owned identifier/reference columns. The migration
   * differ uses this to distinguish intentionally UUID-compatible references
   * from plain text provenance fields whose names may also end in `_id`.
   */
  referenceKind?: 'id' | 'foreignKey' | 'crossPackageRef' | 'tenantId';
  unique?: boolean;
  notNull?: boolean;
  defaultValue?: unknown;
  foreignKey?: {
    table: string;
    column: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
  };
  check?: string; // CHECK constraint
  description?: string;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string; // Partial index condition
  description?: string;
  /**
   * Expression-based index target.
   *
   * When set, the DDL strategy renders the index over a JSON path inside
   * `column` rather than the `columns` list. Used today by `@meta({ indexed: true })`
   * which targets a key inside the `_meta_data` JSONB column.
   */
  jsonPath?: {
    column: string;
    path: string;
  };
}

export interface TriggerDefinition {
  name: string;
  when: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  condition?: string;
  body: string;
  description?: string;
}

export interface ForeignKeyDefinition {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

export interface SchemaDefinition {
  tableName: string;
  /** SQL DDL statement for table creation (optional - may be generated lazily) */
  ddl?: string;
  columns: Record<string, ColumnDefinition>;
  indexes: IndexDefinition[];
  triggers: TriggerDefinition[];
  foreignKeys: ForeignKeyDefinition[];
  version: string; // Hash-based version for change detection
  dependencies: string[]; // Other tables this depends on
  packageName?: string; // Package that defines this schema
  baseClass?: string; // SmrtObject, SmrtCollection, etc.
}

export interface SchemaManifest {
  version: string;
  timestamp: number;
  packageName: string;
  schemas: Record<string, SchemaDefinition>;
  dependencies: string[]; // Other packages this depends on
}

export interface SchemaOverride {
  tableName: string;
  addColumns?: Record<string, ColumnDefinition>;
  removeColumns?: string[];
  addIndexes?: IndexDefinition[];
  removeIndexes?: string[];
  addTriggers?: TriggerDefinition[];
  removeTriggers?: string[];
  packageName: string;
}

export interface SchemaMigration {
  id: string;
  version: string;
  description: string;
  up: string[]; // SQL statements to apply
  down: string[]; // SQL statements to rollback
  dependencies: string[]; // Other migration IDs this depends on
  packageName: string;
}

/**
 * Status of a schema migration in the tracking table
 */
export type MigrationStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rolled_back';

/**
 * Record stored in _smrt_schema_migrations table
 * Tracks applied migrations for idempotency and audit
 */
export interface SchemaMigrationRecord {
  /** UUID primary key */
  id: string;
  /** Migration name, e.g., '0001_initial_schema' */
  name: string;
  /** SMRT version when migration was created */
  version: string;
  /** SHA-256 checksum of migration SQL for idempotency */
  checksum: string;
  /** SHA-256 of what was actually applied (for drift detection) */
  applied_checksum: string | null;
  /** When the migration was applied */
  applied_at: Date;
  /** Execution duration in milliseconds */
  execution_time_ms: number | null;
  /** Source SMRT package that defined this migration */
  package_name: string | null;
  /** Original migration file path */
  source_file: string | null;
  /** Current migration status */
  status: MigrationStatus;
  /** Error message if status is 'failed' */
  error_message: string | null;
  /** Number of application attempts */
  attempts: number;
  /** Whether this migration can be rolled back */
  is_reversible: boolean;
  /** When the migration was rolled back (if applicable) */
  rolled_back_at: Date | null;
  /** Hostname or identifier of who/what applied the migration */
  applied_by: string | null;
  /** Batch number for migrations applied together */
  batch: number | null;
}

/**
 * Definition for a migration to be applied
 * Used by db:diff generation and file parsing
 */
export interface MigrationDefinition {
  /** Unique migration identifier, e.g., '0001_add_users_table' */
  id: string;
  /** Human-readable description */
  description: string;
  /** SMRT version this migration was created for */
  version: string;
  /** SQL statements to apply the migration */
  up: string[];
  /** SQL statements to rollback the migration */
  down: string[];
  /** Other migration IDs this depends on */
  dependencies?: string[];
  /** Package that defines this migration */
  package_name?: string;
  /** Source file path */
  source_file?: string;
  /** Whether this migration can be rolled back */
  is_reversible?: boolean;
}

/**
 * Result of applying a single migration
 */
export interface MigrationResult {
  /** Whether the migration was successful (no errors) */
  success: boolean;
  /** Migration name */
  name: string;
  /** SHA-256 checksum of the migration */
  checksum: string;
  /** Execution duration in milliseconds */
  execution_time_ms: number;
  /** Whether the migration was actually applied (false if already applied) */
  applied?: boolean;
  /** Whether the migration was skipped (already applied with same checksum) */
  skipped?: boolean;
  /** Error if migration failed */
  error?: Error | string;
  /** Whether this was a rollback operation */
  rolled_back?: boolean;
}

/**
 * Drift detection result for a single migration
 */
export interface DriftReport {
  /** Migration name */
  migration_name: string;
  /** Expected checksum from migration definition */
  expected_checksum: string;
  /** Actual checksum found in database */
  actual_checksum: string;
  /** Type of drift detected */
  drift_type:
    | 'file_modified'
    | 'db_modified'
    | 'missing_in_db'
    | 'unknown_in_db';
  /** Suggested action to resolve the drift */
  recommendation: string;
}

/**
 * Schema difference for a single change
 */
export interface SchemaChange {
  /** Type of change */
  type:
    | 'add_table'
    | 'drop_table'
    | 'add_column'
    | 'drop_column'
    | 'add_index'
    | 'drop_index'
    | 'type_mismatch'
    | 'type_upgrade';
  /** Affected table name */
  table: string;
  /** Column or index name (if applicable) */
  name?: string;
  /** Column definition (for add_column) */
  column?: ColumnDefinition;
  /** Index definition (for add_index) */
  index?: IndexDefinition;
  /** For type mismatches and upgrades: expected vs actual */
  mismatch?: {
    expected: string;
    actual: string;
  };
  /** Generated SQL statement */
  sql?: string;
  /**
   * Generated SQL statements for changes that require multiple ordered steps.
   * When omitted, callers should use the single `sql` statement.
   */
  sqlStatements?: string[];
}

/**
 * Result of comparing manifest schema to database
 */
export interface SchemaDiff {
  /** New tables to create */
  added_tables: SchemaDefinition[];
  /** Tables to drop (only if explicitly requested) */
  dropped_tables: string[];
  /** Changes to existing tables */
  changes: SchemaChange[];
  /** Whether any differences were found */
  has_changes: boolean;
}
