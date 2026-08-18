/**
 * Schema generation module exports
 */

export { SchemaCodeGenerator } from './code-generator.js';
// Re-export DDL strategies for per-engine schema generation
export * from './ddl/index.js';
export { SchemaGenerator } from './generator.js';
// Live-schema parity check (#2368)
export {
  type ConflictTargetInput,
  checkLiveSchemaParity,
  type ExpectedTableOrigin,
  type LiveParityFinding,
  type LiveParityFindingKind,
  type LiveParitySeverity,
  LiveSchemaParityError,
  type LiveSchemaParityOptions,
  type LiveSchemaParityReport,
  normalizeSqlType,
  parseIndexDefColumns,
} from './live-parity.js';
export { SchemaOverrideSystem } from './override-system.js';
export type {
  AggregatedTable,
  AggregateOptions,
  AggregationResult,
} from './schema-aggregator.js';
export { SchemaAggregator } from './schema-aggregator.js';
export { createSchemaManager, SchemaManager } from './schema-manager.js';
export {
  getSystemTableShapes,
  parseTableShapes,
  SYSTEM_TABLE_NAMES,
  type SystemTableColumnShape,
  type SystemTableIndexShape,
  type SystemTableShape,
} from './system-table-shapes.js';

// Re-export for easy access
export type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  SchemaDefinition,
  SchemaManifest,
  SchemaMigration,
  SchemaOverride,
  TriggerDefinition,
} from './types.js';
export * from './types.js';
