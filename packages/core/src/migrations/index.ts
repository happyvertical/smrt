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
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  SchemaComparer,
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
// Core classes
export { MigrationTracker } from './tracker.js';

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
