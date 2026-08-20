/**
 * SMRT Migrations Module
 *
 * Production-ready database migration system with:
 * - Migration tracking and checksums
 * - Transaction-wrapped execution
 * - PostgreSQL-specific handling (CONCURRENTLY, lock timeout)
 * - Drift detection
 * - Rollback support
 */

// Backfill tracking (data corrections, not schema migrations)
export {
  type BackfillRecord,
  BackfillTableUnavailableError,
  BackfillTracker,
  type BackfillTrackerOptions,
} from './backfill-tracker.js';
// Checksum utilities
export {
  computeChecksum,
  normalizeSQL,
  shortChecksum,
  verifyChecksum,
} from './checksum.js';
export type { DiffOptions } from './differ.js';
// Schema comparison
export {
  canonicalizeDefault,
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  isAdvisoryOnlyChange,
  isInfoOnlyChange,
  isManualOrAdvisoryChange,
  SchemaComparer,
  uniqueColumnIndexName,
} from './differ.js';
export type {
  GeneratedMigration,
  GenerateMigrationOptions,
} from './generator.js';
// Migration file generation
export {
  createMigrationDefinition,
  generateMigrationSequence,
  generateMigrationTimestamp,
  MigrationGenerator,
} from './generator.js';
// Explicit int4 → int8 deployment widening (#2424)
export {
  buildIntegerWidthStatements,
  collectIntegerWidthTargets,
  type IntegerWidthColumnReport,
  type IntegerWidthColumnState,
  type IntegerWidthOptions,
  type IntegerWidthPreflightResult,
  type IntegerWidthTableReport,
  type IntegerWidthTarget,
  type IntegerWidthWidenOptions,
  type IntegerWidthWidenResult,
  preflightIntegerWidthWidening,
  widenIntegerColumnsToBigInt,
} from './integer-width.js';
// Money major-units → integer minor-units rescale (#2401)
export {
  buildMinorUnitsStatements,
  type MinorUnitsColumnReport,
  type MinorUnitsColumnState,
  type MinorUnitsOptions,
  MinorUnitsPreflightError,
  type MinorUnitsPreflightResult,
  type MinorUnitsProblemRow,
  type MinorUnitsRescaleOptions,
  type MinorUnitsRescaleResult,
  type MoneyColumnTarget,
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from './minor-units.js';
// High-level schema orchestration over ObjectRegistry
export {
  getPendingSchemaStatements,
  type MigrateSmrtSchemasOptions,
  type MigrateSmrtSchemasResult,
  migrateSmrtSchemas,
  type PendingSchemaStatementsResult,
} from './orchestrate.js';
// SQLite table rebuild (type changes SQLite cannot ALTER in place)
export {
  type BuildSqliteRebuildStatementsInput,
  buildSqliteRebuildStatements,
  isSqliteRebuildPlaceholder,
  type PlanSqliteTableRebuildsOptions,
  planSqliteTableRebuilds,
  rewriteSqliteCreateTable,
  SQLITE_REBUILD_TABLE_PREFIX,
  type SqliteTableRebuildPlan,
  sqliteRebuildPlaceholderSql,
} from './sqlite-rebuild.js';
// Core classes
export {
  buildConcurrentIndexPlan,
  extractCreatedIndexName,
  MigrationTracker,
  parsePostgresTimeoutMs,
  planPostgresStatements,
} from './tracker.js';

// Types
export type {
  ApplyMigrationsOptions,
  ColumnDefinitionWithName,
  ColumnInfo,
  DatabaseEngine,
  DatabaseInterface,
  // Data migration types (for STI upgrades, etc.)
  DataMigration,
  DataMigrationResult,
  DataMigrationStatement,
  DriftReport,
  ForeignKeyInfo,
  IndexDefinition,
  IndexInfo,
  MigrationDefinition,
  MigrationMode,
  MigrationResult,
  // From schema types
  MigrationStatus,
  MigrationsConfig,
  // Migration-specific types
  MigrationTrackerOptions,
  ParsedMigrationFile,
  ParseMigrationOptions,
  RollbackOptions,
  SchemaChange,
  SchemaDiff,
  SchemaMigrationRecord,
  StiDiscriminatorMigration,
  TableSchemaInfo,
} from './types.js';
