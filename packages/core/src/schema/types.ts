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
    onDelete?: ForeignKeyAction;
    onUpdate?: ForeignKeyAction;
    /** Engines on which the physical constraint is emitted. */
    engines?: Array<'postgres' | 'sqlite' | 'duckdb' | 'json'>;
  };
  check?: string; // CHECK constraint
  description?: string;
}

export type ForeignKeyAction =
  | 'CASCADE'
  | 'SET NULL'
  | 'RESTRICT'
  | 'NO ACTION';

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

/**
 * A multi-column index declared on an object through `@smrt({ indexes: [...] })`
 * (issue #2357).
 *
 * Generated schemas otherwise only index foreign keys, unique/conflict columns,
 * `updated_at`, the STI discriminator, `tenant_id`, and columns opted in one at
 * a time with `@field({ indexed: true })`. None of those can express a list
 * workload's real access path, which is composite: filter column(s) first, sort
 * column last. `WHERE tenant_id = ? ... ORDER BY publish_date DESC LIMIT 10`
 * wants `(tenant_id, publish_date)`, and there was no way to ask for it.
 *
 * Declare the columns, not a direction: PostgreSQL scans a btree in either
 * direction, so a plain ascending index also serves the matching
 * `ORDER BY ... DESC` as an ordered scan with no sort step.
 */
export interface DeclaredIndexDefinition {
  /**
   * Index name. Must be unique within the database, and must not collide with
   * a generated index of the same name unless it describes the same target —
   * schema generation fails rather than silently dropping either one.
   */
  name: string;
  /**
   * SMRT field names or column names, in index order. Field names are mapped to
   * their column names; a name that resolves to no column on the table is a
   * hard error.
   */
  columns: string[];
  /** Emit as a UNIQUE index. */
  unique?: boolean;
  /**
   * Partial-index predicate, rendered verbatim into `CREATE INDEX ... WHERE`.
   *
   * This is authored SQL from the object's own source, exactly like the
   * predicates the STI path emits; never build it from request input.
   */
  where?: string;
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
  onDelete?: ForeignKeyAction;
  onUpdate?: ForeignKeyAction;
  /** Engines on which the physical constraint is emitted. */
  engines?: Array<'postgres' | 'sqlite' | 'duckdb' | 'json'>;
}

export interface SchemaDefinition {
  tableName: string;
  /**
   * Engine-neutral CREATE TABLE preview (optional; may be generated lazily).
   *
   * Non-authoritative (#2358): it carries no indexes, no triggers and no
   * per-engine type mapping (`REAL`/`JSON`/`UUID`/`TIMESTAMP` stay abstract).
   * Kept for backward compatibility with published manifests and third-party
   * tooling; framework consumers render `columns` and `indexes` through
   * `getDDLStrategy(engine)` and only merge `ddl` in for a table whose
   * contributors expose no `columns` (hand-authored manifests).
   */
  ddl?: string;
  columns: Record<string, ColumnDefinition>;
  indexes: IndexDefinition[];
  /**
   * Always `[]` on every schema a `@smrt()` class can currently produce (#2380).
   *
   * `DDLStrategy.generateTriggers()` (`schema/ddl/*.ts`) renders this array into
   * real `CREATE TRIGGER` DDL and runs on every table creation, but there is no
   * `@smrt()`/`@field()` option that populates it — unlike `indexes`, which
   * `@smrt({ indexes: [...] })` (#2357) authors directly. The one producer that
   * ever set it (the AST `generateSchema()` entry point, which emitted a single
   * `updated_at`-bump trigger) fed only the `smrt:schema` virtual module, which
   * had no consumer, and was deleted rather than wired up: `updated_at` is
   * maintained at the application layer (`SmrtObject.save()`), the migration
   * differ (`migrations/differ.ts`) never diffs triggers, so a hand-populated
   * one would only ever apply to newly `CREATE TABLE`d tables and never
   * retrofit existing ones. Populate this only via a caller who constructs a
   * `SchemaDefinition` directly (tests, or third-party tooling) — never assume
   * a generated schema carries one.
   */
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
 * Which column property an `alter_column` change repairs (#2369).
 *
 * - `set_not_null` / `set_default`: the manifest is stricter than the live
 *   column (strengthening). The differ emits executable SQL for these on
 *   engines that support `ALTER COLUMN`.
 * - `drop_not_null` / `drop_default`: the live column is stricter than the
 *   manifest (relaxing). Reported as an advisory by default and only made
 *   executable when the caller opts in (`DiffOptions.relaxColumns`), because
 *   weakening a production column on the strength of a manifest that may
 *   itself be under-specified is not something to do silently.
 */
export type ColumnAlteration =
  | 'set_not_null'
  | 'drop_not_null'
  | 'set_default'
  | 'drop_default';

/**
 * Advisory attached to a change the differ reports but does not execute
 * (orphan columns/indexes, or relaxations the caller has not opted into).
 * `suggestedSql` is remediation the operator can run by hand; it is never
 * part of the executable statement stream.
 */
export interface SchemaChangeAdvisory {
  /** `warning` when the state will break application writes; `info` otherwise. */
  severity: 'warning' | 'info';
  /** Human-readable explanation of the drift and how to resolve it. */
  message: string;
  /** Remediation SQL the differ suggests but does not run. */
  suggestedSql?: string[];
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
    | 'alter_column'
    | 'orphan_column'
    | 'add_index'
    | 'add_foreign_key'
    | 'drop_foreign_key'
    | 'drop_index'
    | 'orphan_index'
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
  /** Foreign-key definition (for add_foreign_key/drop_foreign_key). */
  foreignKey?: ForeignKeyDefinition;
  /**
   * For type mismatches/upgrades: expected vs actual type. For
   * `alter_column`: the expected vs actual constraint rendering (e.g.
   * `NOT NULL` vs `NULL`, `DEFAULT ''` vs `(no default)`). For
   * `orphan_column`: `expected` is `(not in manifest)` and `actual` is the
   * live column shape.
   */
  mismatch?: {
    expected: string;
    actual: string;
  };
  /** Which property an `alter_column` change repairs. */
  alteration?: ColumnAlteration;
  /**
   * Ordering phase for changes that must run before an unrelated family of
   * statements in the same batch. `pre_foreign_key` marks the pre-R11
   * `text` -> `uuid` column convergence (#2608): PostgreSQL cannot implement
   * a foreign key across mismatched physical types, so these conversions —
   * and the advisories that replace them when convergence is refused —
   * precede every foreign-key statement in the migration stream, including
   * the deferred constraints emitted for newly created tables.
   */
  phase?: 'pre_foreign_key';
  /**
   * Present on report-only changes (`orphan_column`, `orphan_index`, and
   * `alter_column` relaxations the caller has not opted into). A change
   * carrying an advisory and no `sql`/`sqlStatements` is never executed.
   */
  advisory?: SchemaChangeAdvisory;
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
  /**
   * Application tables present in the database but absent from the manifest
   * (system `_smrt_*` / `sqlite_*` tables excluded). Always reported so a
   * stale table is never silently retained; dropping stays opt-in via
   * `dropped_tables`. Informational — does not affect `has_changes`.
   */
  orphan_tables?: string[];
  /** Changes to existing tables */
  changes: SchemaChange[];
  /**
   * Whether any executable, manual, or warning-level difference was found.
   * Info-level report-only notes in `changes` (a harmless orphan column, a
   * stale default) and `orphan_tables` do not set it.
   */
  has_changes: boolean;
}
