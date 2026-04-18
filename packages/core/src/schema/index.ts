/**
 * Schema generation module exports
 */

export { SchemaCodeGenerator } from './code-generator.js';
// Re-export DDL strategies for per-engine schema generation
export * from './ddl/index.js';
export { SchemaGenerator } from './generator.js';
export { SchemaOverrideSystem } from './override-system.js';
export type {
  AggregatedTable,
  AggregateOptions,
  AggregationResult,
} from './schema-aggregator.js';
export { SchemaAggregator } from './schema-aggregator.js';
export { createSchemaManager, SchemaManager } from './schema-manager.js';

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
