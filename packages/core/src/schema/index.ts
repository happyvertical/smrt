/**
 * Schema generation module exports
 */

export { SchemaCodeGenerator } from './code-generator';
export { SchemaGenerator } from './generator';
export { SchemaOverrideSystem } from './override-system';
export { RuntimeSchemaManager } from './runtime-manager';
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
