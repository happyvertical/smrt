/**
 * Schema Differ
 *
 * Compares manifest schemas to database schemas and generates
 * a SchemaDiff with the differences.
 */

import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
} from '../schema/types.js';
import type { DatabaseInterface, TableSchemaInfo } from './types.js';

/**
 * Options for schema comparison
 */
export interface DiffOptions {
  /** Include dropped tables in diff (default: false for safety) */
  includeDroppedTables?: boolean;
  /** Include dropped columns in diff (default: false for safety) */
  includeDroppedColumns?: boolean;
  /** Ignore type mismatches (just log warnings) */
  ignoreTypeMismatches?: boolean;
}

/**
 * SchemaComparer class for comparing manifest schemas to database
 */
export class SchemaComparer {
  private db: DatabaseInterface;
  private options: DiffOptions;

  constructor(db: DatabaseInterface, options: DiffOptions = {}) {
    this.db = db;
    this.options = {
      includeDroppedTables: false,
      includeDroppedColumns: false,
      ignoreTypeMismatches: false,
      ...options,
    };
  }

  /**
   * Compare manifest schemas to database and return differences
   */
  async compare(
    manifestSchemas: Record<string, SchemaDefinition>,
  ): Promise<SchemaDiff> {
    const diff: SchemaDiff = {
      added_tables: [],
      dropped_tables: [],
      changes: [],
      has_changes: false,
    };

    // Get list of existing tables
    const existingTables = await this.getExistingTables();

    // Check each manifest schema against database
    for (const [tableName, schema] of Object.entries(manifestSchemas)) {
      if (!existingTables.has(tableName)) {
        // Table doesn't exist - add to added_tables
        diff.added_tables.push(schema);
        diff.has_changes = true;
      } else {
        // Table exists - compare columns and indexes
        const tableChanges = await this.compareTable(tableName, schema);
        if (tableChanges.length > 0) {
          diff.changes.push(...tableChanges);
          diff.has_changes = true;
        }
      }
    }

    // Check for dropped tables (if enabled)
    if (this.options.includeDroppedTables) {
      for (const tableName of existingTables) {
        // Skip system tables
        if (tableName.startsWith('_smrt_') || tableName.startsWith('sqlite_')) {
          continue;
        }
        if (!manifestSchemas[tableName]) {
          diff.dropped_tables.push(tableName);
          diff.has_changes = true;
        }
      }
    }

    return diff;
  }

  /**
   * Compare a single table's schema to manifest
   */
  async compareTable(
    tableName: string,
    manifest: SchemaDefinition,
  ): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];

    // Get current table schema from database
    const dbSchema = await this.db.getTableSchema?.(tableName);
    if (!dbSchema) {
      // Table doesn't exist - this is an add_table case
      return changes;
    }

    // Compare columns
    const columnChanges = this.compareColumns(tableName, manifest, dbSchema);
    changes.push(...columnChanges);

    // Compare indexes
    const indexChanges = this.compareIndexes(tableName, manifest, dbSchema);
    changes.push(...indexChanges);

    return changes;
  }

  /**
   * Compare columns between manifest and database
   */
  private compareColumns(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: TableSchemaInfo,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];
    const dbColumnNames = new Set(Object.keys(dbSchema.columns));

    // Check for new and modified columns
    for (const [colName, colDef] of Object.entries(manifest.columns)) {
      if (!dbColumnNames.has(colName)) {
        // Column doesn't exist - add it
        changes.push({
          type: 'add_column',
          table: tableName,
          name: colName,
          column: colDef,
          sql: this.generateAddColumnSQL(tableName, colName, colDef),
        });
      } else {
        // Column exists - check for type mismatch
        const dbCol = dbSchema.columns[colName];
        const normalizedExpected = this.normalizeType(colDef.type);
        const normalizedActual = this.normalizeType(dbCol.type);

        if (normalizedExpected !== normalizedActual) {
          if (!this.options.ignoreTypeMismatches) {
            changes.push({
              type: 'type_mismatch',
              table: tableName,
              name: colName,
              mismatch: {
                expected: colDef.type,
                actual: dbCol.type,
              },
            });
          }
        }
      }
    }

    // Check for dropped columns (if enabled)
    if (this.options.includeDroppedColumns) {
      const manifestColumnNames = new Set(Object.keys(manifest.columns));
      for (const colName of dbColumnNames) {
        if (!manifestColumnNames.has(colName)) {
          changes.push({
            type: 'drop_column',
            table: tableName,
            name: colName,
            sql: this.generateDropColumnSQL(tableName, colName),
          });
        }
      }
    }

    return changes;
  }

  /**
   * Compare indexes between manifest and database
   */
  private compareIndexes(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: TableSchemaInfo,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];
    const dbIndexNames = new Set(dbSchema.indexes.map((idx) => idx.name));

    // Check for new indexes
    for (const idx of manifest.indexes) {
      if (!dbIndexNames.has(idx.name)) {
        changes.push({
          type: 'add_index',
          table: tableName,
          name: idx.name,
          index: idx,
          sql: this.generateAddIndexSQL(tableName, idx),
        });
      }
    }

    return changes;
  }

  /**
   * Get list of existing tables from database
   */
  private async getExistingTables(): Promise<Set<string>> {
    // Query differs by database type
    const dbUrl = this.db.url || '';

    let query: string;
    if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
      query = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    } else {
      // SQLite and DuckDB
      query = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    }

    const result = await this.db.query<{ name?: string; table_name?: string }>(
      query,
    );
    const rows = result.rows || [];
    return new Set(
      rows.map((r) => r.name || r.table_name || '').filter(Boolean),
    );
  }

  /**
   * Normalize SQL types for comparison
   */
  private normalizeType(type: string): string {
    const upper = type.toUpperCase().trim();

    // Integer types
    if (/^(INTEGER|INT|BIGINT|SMALLINT|TINYINT)$/i.test(upper)) {
      return 'INTEGER';
    }

    // Text types
    if (/^(TEXT|CLOB|STRING|VARCHAR|CHAR)/i.test(upper)) {
      return 'TEXT';
    }

    // Decimal types
    if (/^(REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|NUMBER)/i.test(upper)) {
      return 'REAL';
    }

    // Boolean types
    if (/^(BOOLEAN|BOOL)/i.test(upper)) {
      return 'BOOLEAN';
    }

    // Date/time types
    if (/^(DATETIME|TIMESTAMP|DATE|TIME)/i.test(upper)) {
      return 'TIMESTAMP';
    }

    // Blob types
    if (/^(BLOB|BINARY|BYTEA)/i.test(upper)) {
      return 'BLOB';
    }

    // JSON types
    if (/^(JSON|JSONB)/i.test(upper)) {
      return 'JSON';
    }

    return upper;
  }

  /**
   * Quote a SQL identifier
   */
  private quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Generate SQL for adding a column
   */
  private generateAddColumnSQL(
    tableName: string,
    colName: string,
    colDef: ColumnDefinition,
  ): string {
    const parts: string[] = [this.quoteIdentifier(colName), colDef.type];

    if (colDef.notNull) {
      parts.push('NOT NULL');
    }
    if (colDef.unique) {
      parts.push('UNIQUE');
    }
    if (colDef.defaultValue !== undefined) {
      const defaultVal =
        typeof colDef.defaultValue === 'string'
          ? `'${colDef.defaultValue.replace(/'/g, "''")}'`
          : String(colDef.defaultValue);
      parts.push(`DEFAULT ${defaultVal}`);
    }

    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${parts.join(' ')}`;
  }

  /**
   * Generate SQL for dropping a column
   */
  private generateDropColumnSQL(tableName: string, colName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(colName)}`;
  }

  /**
   * Generate SQL for adding an index
   */
  private generateAddIndexSQL(tableName: string, idx: IndexDefinition): string {
    const uniqueStr = idx.unique ? 'UNIQUE ' : '';
    const quotedColumns = idx.columns
      .map((c) => this.quoteIdentifier(c))
      .join(', ');
    return `CREATE ${uniqueStr}INDEX ${this.quoteIdentifier(idx.name)} ON ${this.quoteIdentifier(tableName)} (${quotedColumns})`;
  }
}

/**
 * Generate a SchemaDiff from manifest and database
 */
export async function generateSchemaDiff(
  db: DatabaseInterface,
  manifestSchemas: Record<string, SchemaDefinition>,
  options: DiffOptions = {},
): Promise<SchemaDiff> {
  const comparer = new SchemaComparer(db, options);
  return comparer.compare(manifestSchemas);
}

/**
 * Check if a diff has any actionable changes (excluding type mismatches)
 */
export function hasActionableChanges(diff: SchemaDiff): boolean {
  if (diff.added_tables.length > 0) return true;
  if (diff.dropped_tables.length > 0) return true;
  return diff.changes.some((c) => c.type !== 'type_mismatch');
}

/**
 * Get SQL statements from a diff for execution
 */
export function getSQLFromDiff(diff: SchemaDiff): string[] {
  const statements: string[] = [];

  // Add table creation (requires full DDL generation - not included here)
  // This is typically handled by ensureSchema()

  // Add column and index changes
  for (const change of diff.changes) {
    if (change.sql && change.type !== 'type_mismatch') {
      statements.push(change.sql);
    }
  }

  return statements;
}
