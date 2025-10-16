/**
 * Schema generation module exports
 */

export * from './types';
export { SchemaGenerator } from './generator';
export { SchemaCodeGenerator } from './code-generator';
export { RuntimeSchemaManager } from './runtime-manager';
export { SchemaOverrideSystem } from './override-system';

// Re-export for easy access
export type {
  SchemaDefinition,
  SchemaManifest,
  SchemaOverride,
  ColumnDefinition,
  IndexDefinition,
  TriggerDefinition,
  ForeignKeyDefinition,
  SchemaMigration,
} from './types';
