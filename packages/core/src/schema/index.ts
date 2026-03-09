/**
 * Schema generation module exports
 */

export { SchemaCodeGenerator } from './code-generator';
// Re-export DDL strategies for per-engine schema generation
export * from './ddl';
export { SchemaGenerator } from './generator';
export { SchemaOverrideSystem } from './override-system';
export type {
  AggregatedTable,
  AggregateOptions,
  AggregationResult,
} from './schema-aggregator';
export { SchemaAggregator } from './schema-aggregator';
export { createSchemaManager, SchemaManager } from './schema-manager';

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
} from './types';
export * from './types';
