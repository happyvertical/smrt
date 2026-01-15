/**
 * Schema Differ
 *
 * Compares manifest schemas to database schemas and generates
 * a SchemaDiff with the differences.
 */

import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
  SQLDataType,
} from '../schema/types.js';
import type { DatabaseInterface, SqlTableSchemaInfo } from './types.js';

/**
 * Valid SQLDataType values for validation
 */
const VALID_SQL_DATA_TYPES: Set<SQLDataType> = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'BOOLEAN',
  'JSON',
  'TIMESTAMP',
]);

/**
 * Check if a string is a valid SQLDataType
 */
function isValidSQLDataType(type: string): type is SQLDataType {
  return VALID_SQL_DATA_TYPES.has(type as SQLDataType);
}

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
  private engine: DatabaseEngine;
  private ddlStrategy: ReturnType<typeof getDDLStrategy>;

  constructor(db: DatabaseInterface, options: DiffOptions = {}) {
    this.db = db;
    this.options = {
      includeDroppedTables: false,
      includeDroppedColumns: false,
      ignoreTypeMismatches: false,
      ...options,
    };
    // Use the shared detectEngine utility for consistent detection
    // Handles :memory:, .json, and other edge cases
    this.engine = detectEngine(this.db.url || '');
    this.ddlStrategy = getDDLStrategy(this.engine);
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
    dbSchema: SqlTableSchemaInfo,
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

        // Map manifest's abstract type to engine-specific type
        // e.g., JSON → TEXT for SQLite, JSON → JSONB for PostgreSQL
        // Validate the manifest type before mapping
        const manifestType = colDef.type;
        if (!isValidSQLDataType(manifestType)) {
          // Invalid manifest type - treat as TEXT (safest fallback)
          console.warn(
            `[SchemaComparer] Invalid manifest type "${manifestType}" for ${tableName}.${colName}, treating as TEXT`,
          );
        }
        const validatedType: SQLDataType = isValidSQLDataType(manifestType)
          ? manifestType
          : 'TEXT';
        const expectedEngineType = this.ddlStrategy.mapType(validatedType);
        const normalizedExpected = this.normalizeType(expectedEngineType);
        const normalizedActual = this.normalizeType(dbCol.type);

        if (normalizedExpected !== normalizedActual) {
          // Check if this is a safe type upgrade that SMRT can handle
          // Since SMRT owns the data lifecycle, we know the intent from the manifest
          if (this.isCompatibleTypeUpgrade(colDef.type, dbCol.type)) {
            // Generate type upgrade SQL
            const sql = this.generateTypeUpgradeSQL(
              tableName,
              colName,
              colDef.type,
              dbCol.type,
            );
            changes.push({
              type: 'type_upgrade',
              table: tableName,
              name: colName,
              column: colDef,
              mismatch: {
                expected: colDef.type,
                actual: dbCol.type,
              },
              sql,
            });
          } else if (!this.options.ignoreTypeMismatches) {
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
   *
   * Issue #741: Also checks for functionally equivalent indexes to avoid
   * detecting indexes as "missing" when a different-named index with the
   * same columns already exists. This is critical for STI tables where
   * child classes may generate indexes with different name prefixes.
   */
  private compareIndexes(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];
    const dbIndexNames = new Set(dbSchema.indexes.map((idx) => idx.name));

    // Build a map of existing index signatures for functional equivalence checking
    // Signature format: "col1,col2:unique" with columns in their defined order
    const dbIndexSignatures = new Map<string, string>();
    for (const idx of dbSchema.indexes) {
      const signature = this.getIndexSignature(
        idx.columns,
        idx.unique ?? false,
      );
      dbIndexSignatures.set(signature, idx.name);
    }

    // Check for new indexes
    for (const idx of manifest.indexes) {
      // First, check by exact name match
      if (dbIndexNames.has(idx.name)) {
        continue; // Index exists with same name
      }

      // Second, check for functionally equivalent index (same columns, same uniqueness)
      // This prevents creating redundant indexes with different names
      const manifestSignature = this.getIndexSignature(
        idx.columns,
        idx.unique ?? false,
      );
      const equivalentIndexName = dbIndexSignatures.get(manifestSignature);

      if (equivalentIndexName) {
        // A functionally equivalent index already exists
        // Skip this index to avoid PostgreSQL "relation already exists" errors
        continue;
      }

      // No equivalent index found - this is genuinely missing
      changes.push({
        type: 'add_index',
        table: tableName,
        name: idx.name,
        index: idx,
        sql: this.generateAddIndexSQL(tableName, idx),
      });
    }

    return changes;
  }

  /**
   * Generate a signature for an index based on its columns and uniqueness.
   * Used for functional equivalence checking (Issue #741).
   *
   * Note: Column order is preserved because it is semantically significant for
   * composite indexes. An index on (a, b) is NOT equivalent to (b, a) - they
   * have different query performance characteristics.
   *
   * Limitation: Partial indexes (with WHERE clauses) are not fully supported.
   * The database introspection layer doesn't provide WHERE clause information,
   * so two partial indexes with the same columns but different WHERE clauses
   * cannot be distinguished and may be incorrectly treated as equivalent.
   *
   * @param columns - Array of column names (order is preserved)
   * @param unique - Whether the index is unique
   * @returns Signature string like "col1,col2:false"
   */
  private getIndexSignature(columns: string[], unique: boolean): string {
    // Preserve column order because it is semantically significant for composite indexes
    const columnList = columns.join(',');
    return `${columnList}:${unique}`;
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

    const result = await this.db.query(query);
    const rows = result.rows as { name?: string; table_name?: string }[];
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
   * Check if a type change is a safe upgrade that can be auto-migrated.
   *
   * SMRT controls the data lifecycle for these columns, so we know:
   * - TEXT→JSON: The column stores JSON data serialized as text (arrays, objects)
   * - INTEGER→REAL: Safe widening of integer to floating point
   *
   * @param manifestType - The abstract type from the manifest (e.g., 'JSON')
   * @param dbType - The actual type in the database (e.g., 'TEXT')
   * @returns true if the change from dbType to manifestType is a safe upgrade
   */
  private isCompatibleTypeUpgrade(
    manifestType: string,
    dbType: string,
  ): boolean {
    const manifest = this.normalizeType(manifestType);
    const db = this.normalizeType(dbType);

    // TEXT → JSON is safe: SMRT serializes arrays/objects as JSON text
    // When the manifest says JSON, the data is already valid JSON in TEXT column
    if (manifest === 'JSON' && db === 'TEXT') {
      return true;
    }

    // JSON → TEXT is also safe (downgrade, but data is preserved as-is)
    if (manifest === 'TEXT' && db === 'JSON') {
      return true;
    }

    // INTEGER → REAL is safe (widening)
    if (manifest === 'REAL' && db === 'INTEGER') {
      return true;
    }

    return false;
  }

  /**
   * Generate SQL for a type upgrade migration.
   *
   * Engine-specific SQL:
   * - SQLite: TEXT and JSON are equivalent, no-op or comment
   * - DuckDB: ALTER COLUMN TYPE (native type conversion)
   * - PostgreSQL: ALTER COLUMN TYPE with USING clause
   */
  private generateTypeUpgradeSQL(
    tableName: string,
    colName: string,
    manifestType: string,
    dbType: string,
  ): string {
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedCol = this.quoteIdentifier(colName);

    // Validate manifestType before mapping
    const validatedType: SQLDataType = isValidSQLDataType(manifestType)
      ? manifestType
      : 'TEXT';
    const targetType = this.ddlStrategy.mapType(validatedType);

    switch (this.engine) {
      case 'sqlite':
        // SQLite has dynamic typing - TEXT and JSON are functionally equivalent
        // For SQLite, we just return a comment since no actual change is needed
        if (
          this.normalizeType(manifestType) === 'JSON' &&
          this.normalizeType(dbType) === 'TEXT'
        ) {
          return `-- SQLite: ${quotedCol} already stores JSON as TEXT (no change needed)`;
        }
        // For other type upgrades, SQLite requires recreating the table
        return `-- SQLite: Type upgrade for ${quotedCol} requires table recreation`;

      case 'postgres':
        // PostgreSQL requires explicit ALTER COLUMN with USING clause
        if (
          this.normalizeType(manifestType) === 'JSON' &&
          this.normalizeType(dbType) === 'TEXT'
        ) {
          // TEXT → JSONB: cast text to jsonb
          return `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE ${targetType} USING ${quotedCol}::${targetType.toLowerCase()}`;
        }
        if (
          this.normalizeType(manifestType) === 'TEXT' &&
          this.normalizeType(dbType) === 'JSON'
        ) {
          // JSONB → TEXT: cast jsonb to text
          return `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE TEXT USING ${quotedCol}::text`;
        }
        if (
          this.normalizeType(manifestType) === 'REAL' &&
          this.normalizeType(dbType) === 'INTEGER'
        ) {
          // INTEGER → DOUBLE PRECISION
          return `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE ${targetType}`;
        }
        return `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE ${targetType}`;

      case 'duckdb':
        // DuckDB supports ALTER COLUMN TYPE for type conversions
        return `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE ${targetType}`;

      default: {
        // Escape special characters in type names for safe comment generation
        const safeDbType = dbType.replace(/[^\w]/g, '_');
        const safeManifestType = manifestType.replace(/[^\w]/g, '_');
        return `-- Type upgrade for ${quotedCol}: ${safeDbType} → ${safeManifestType}`;
      }
    }
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
