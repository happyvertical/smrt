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
  | 'DATETIME';

export interface ColumnDefinition {
  type: SQLDataType;
  primaryKey?: boolean;
  unique?: boolean;
  notNull?: boolean;
  defaultValue?: any;
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
