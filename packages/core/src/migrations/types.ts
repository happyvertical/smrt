/**
 * Migration Types
 *
 * Re-exports migration types from schema and adds migration-specific types.
 */

// Import and re-export database types from @happyvertical/sql for compatibility
import type {
  DatabaseInterface,
  ColumnDefinitionWithName as SqlColumnDefinitionWithName,
  IndexDefinition as SqlIndexDefinition,
  TableSchemaInfo as SqlTableSchemaInfo,
} from '@happyvertical/sql';

export type {
  SqlColumnDefinitionWithName,
  DatabaseInterface,
  SqlIndexDefinition,
  SqlTableSchemaInfo,
};

// Re-export schema migration types
export type {
  DriftReport,
  MigrationDefinition,
  MigrationResult,
  MigrationStatus,
  SchemaChange,
  SchemaDiff,
  SchemaMigrationRecord,
} from '../schema/types.js';

/**
 * Options for the MigrationTracker
 */
export interface MigrationTrackerOptions {
  /** Database interface from @happyvertical/sql */
  db: DatabaseInterface;
  /** PostgreSQL lock timeout in milliseconds (default: 30000) */
  lockTimeout?: number;
  /** PostgreSQL statement timeout in milliseconds (default: 60000) */
  statementTimeout?: number;
  /** Use CREATE INDEX CONCURRENTLY for indexes in PostgreSQL (default: true) */
  useConcurrentIndexes?: boolean;
}

/**
 * Table schema info from database introspection
 */
export interface TableSchemaInfo {
  tableName: string;
  columns: Record<string, ColumnInfo>;
  indexes: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
}

/**
 * Column info from database introspection
 */
export interface ColumnInfo {
  name: string;
  type: string;
  notNull?: boolean;
  defaultValue?: unknown;
  primaryKey?: boolean;
}

/**
 * Index info from database introspection
 */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique?: boolean;
}

/**
 * Foreign key info from database introspection
 */
export interface ForeignKeyInfo {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete?: string;
  onUpdate?: string;
}

/**
 * Column definition with name for alterTable operations
 */
export interface ColumnDefinitionWithName {
  name: string;
  type: string;
  notNull?: boolean;
  defaultValue?: unknown;
  unique?: boolean;
  primaryKey?: boolean;
}

/**
 * Index definition for alterTable operations
 */
export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string;
}

/**
 * Database engine type
 */
export type DatabaseEngine = 'sqlite' | 'postgres' | 'duckdb';

/**
 * Options for batch migration application
 */
export interface ApplyMigrationsOptions {
  /** Continue applying migrations even if one fails */
  continueOnError?: boolean;
  /** Dry run - don't actually apply migrations */
  dryRun?: boolean;
  /** Force application even if checksums don't match */
  force?: boolean;
  /**
   * Reconcile migration history with live schema drift.
   *
   * When true, the tracker may re-run a migration if the caller has already
   * independently determined the change is still required. Completed
   * migrations still require a checksum match. Failed migrations may be retried
   * with the current definition because they were never applied successfully.
   * Running migrations still require `force` because SMRT does not currently
   * have a heartbeat or lock-owner check that can prove the original process
   * is dead.
   */
  reconcile?: boolean;
  /** Use PostgreSQL-safe operations (CONCURRENTLY, lock timeout) */
  postgresSafe?: boolean;
}

/**
 * Options for rollback operations
 */
export interface RollbackOptions {
  /** Number of migrations to rollback (default: 1) */
  steps?: number;
  /** Rollback to a specific migration (exclusive - migrations after this will be rolled back) */
  to?: string;
  /** Dry run - don't actually rollback */
  dryRun?: boolean;
  /** Skip confirmation prompt */
  force?: boolean;
}

/**
 * Options for migration file parsing
 */
export interface ParseMigrationOptions {
  /** Expected format of migration file */
  format?: 'sql' | 'typescript';
}

/**
 * Parsed migration file content
 */
export interface ParsedMigrationFile {
  /** Migration ID extracted from file */
  id: string;
  /** Description extracted from file */
  description?: string;
  /** UP SQL statements */
  up: string[];
  /** DOWN SQL statements */
  down: string[];
  /** Dependencies extracted from file */
  dependencies?: string[];
}

/**
 * Migration mode configuration
 */
export type MigrationMode = 'dynamic' | 'file' | 'hybrid';

/**
 * Data migration for updating existing data (e.g., STI discriminator upgrades)
 */
export interface DataMigration {
  type: 'data';
  table: string;
  description: string;
  up: DataMigrationStatement[];
  down: DataMigrationStatement[];
}

/**
 * Single data migration statement with optional parameters
 */
export interface DataMigrationStatement {
  sql: string;
  params?: unknown[];
}

/**
 * STI discriminator migration (specific type of data migration)
 */
export interface StiDiscriminatorMigration extends DataMigration {
  type: 'data';
  migrationCategory: 'sti-discriminator';
  oldValue: string; // "Product"
  newValue: string; // "@happyvertical/smrt-core:Product"
  table: string;
  column: string; // "_meta_type"
}

/**
 * Result of applying a data migration
 */
export interface DataMigrationResult {
  success: boolean;
  name: string;
  rowsAffected?: number;
  execution_time_ms: number;
  error?: string;
}

/**
 * Migrations configuration for smrt.config.js
 */
export interface MigrationsConfig {
  /** Directory for migration files (default: './migrations') */
  directory?: string;
  /** Tracking table name (default: '_smrt_schema_migrations') */
  table?: string;
  /** Default file format (default: 'sql') */
  format?: 'sql' | 'typescript';
  /** Naming scheme (default: 'sequence') */
  naming?: 'sequence' | 'timestamp';
  /** Migration mode (default: 'dynamic') */
  mode?: MigrationMode;
  /** Or configure by environment */
  modeByEnvironment?: Record<string, MigrationMode>;
  /** Auto-generate DOWN scripts (default: true) */
  autoGenerateDown?: boolean;
  /** PostgreSQL-specific options */
  postgres?: {
    /** Use CONCURRENTLY for index creation (default: true) */
    useConcurrently?: boolean;
    /** Lock timeout for migrations (default: '30s') */
    lockTimeout?: string;
    /** Statement timeout for migrations (default: '60s') */
    statementTimeout?: string;
  };
}
