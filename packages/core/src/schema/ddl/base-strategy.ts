/**
 * Base DDL Strategy - Shared logic for all database engines
 *
 * Provides common DDL generation logic that engine-specific strategies
 * can override for their particular requirements.
 */

import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
  TriggerDefinition,
} from '../types.js';
import type { DatabaseEngine, DDLStrategy } from './types.js';

/**
 * Abstract base class for DDL strategies
 *
 * Implements common DDL generation patterns. Engine-specific strategies
 * extend this class and override methods as needed.
 */
export abstract class BaseDDLStrategy implements DDLStrategy {
  abstract readonly engine: DatabaseEngine;

  /**
   * Generate CREATE TABLE statement
   */
  generateCreateTable(schema: SchemaDefinition): string {
    const { tableName, columns, indexes = [] } = schema;

    let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (\n`;

    // Generate column definitions
    const columnDefs: string[] = [];
    for (const [columnName, columnDef] of Object.entries(columns)) {
      columnDefs.push(this.generateColumnDefinition(columnName, columnDef));
    }

    // Add inline UNIQUE constraints for engines that require them
    if (this.requiresInlineUnique() && indexes.length > 0) {
      const uniqueConstraints = this.generateInlineUniqueConstraints(indexes);
      columnDefs.push(...uniqueConstraints);
    }

    sql += columnDefs.map((def) => `  ${def}`).join(',\n');
    sql += '\n);';

    return sql;
  }

  /**
   * Generate a single column definition
   *
   * Public so SchemaManager can reuse it for ALTER TABLE ADD COLUMN.
   */
  generateColumnDefinition(
    columnName: string,
    columnDef: ColumnDefinition,
  ): string {
    const parts: string[] = [`"${columnName}"`, this.mapType(columnDef.type)];

    // Primary key
    if (columnDef.primaryKey) {
      parts.push('PRIMARY KEY');
    }

    // NOT NULL (skip for primary key - it's implicit)
    if (columnDef.notNull && !columnDef.primaryKey) {
      parts.push('NOT NULL');
    }

    // UNIQUE (for single-column unique, not composite)
    // Skip if engine requires inline unique - those are handled separately
    if (columnDef.unique && !this.requiresInlineUnique()) {
      parts.push('UNIQUE');
    }

    // DEFAULT value
    if (columnDef.defaultValue !== undefined) {
      const formatted = this.formatDefaultValue(
        columnDef.defaultValue,
        columnDef.type,
      );
      parts.push(`DEFAULT ${formatted}`);
    }

    // CHECK constraint
    if (columnDef.check) {
      parts.push(`CHECK (${columnDef.check})`);
    }

    return parts.join(' ');
  }

  /**
   * Generate inline UNIQUE constraints for composite indexes
   * Used by engines that require inline UNIQUE for UPSERT to work (DuckDB)
   */
  protected generateInlineUniqueConstraints(
    indexes: IndexDefinition[],
  ): string[] {
    const constraints: string[] = [];

    if (!indexes || !Array.isArray(indexes)) {
      return constraints;
    }

    for (const index of indexes) {
      // Skip malformed index entries
      if (!index || !index.columns || !Array.isArray(index.columns)) {
        continue;
      }

      if (index.unique && index.columns.length > 0) {
        const columns = index.columns.map((c) => `"${c}"`).join(', ');
        constraints.push(`UNIQUE(${columns})`);
      }
    }

    return constraints;
  }

  /**
   * Generate CREATE INDEX statements
   * Override in engine-specific strategies if needed
   */
  generateIndexes(schema: SchemaDefinition): string[] {
    const { tableName, indexes = [] } = schema;
    const statements: string[] = [];

    if (!indexes || indexes.length === 0) {
      return statements;
    }

    for (const index of indexes) {
      // Narrow the jsonPath target up-front so the formatter call doesn't
      // need optional-chained args (and so the malformed-entry check has a
      // single source of truth).
      const jsonPath =
        index?.jsonPath?.column && index.jsonPath.path ? index.jsonPath : null;
      if (
        !index ||
        (!jsonPath &&
          (!index.columns ||
            !Array.isArray(index.columns) ||
            index.columns.length === 0))
      ) {
        console.warn(
          `[DDL] Skipping malformed index: ${JSON.stringify(index)}`,
        );
        continue;
      }

      // Skip UNIQUE indexes if engine requires them inline
      if (index.unique && this.requiresInlineUnique()) {
        continue;
      }

      const indexType = index.unique ? 'UNIQUE INDEX' : 'INDEX';

      // JSON-path indexes use a dialect-specific expression
      const target = jsonPath
        ? `(${this.formatJsonPathIndexExpression(
            jsonPath.column,
            jsonPath.path,
          )})`
        : index.columns.map((c) => `"${c}"`).join(', ');

      let sql = `CREATE ${indexType} IF NOT EXISTS "${index.name}" ON "${tableName}" (${target})`;

      // Partial index condition
      if (index.where) {
        sql += ` WHERE ${index.where}`;
      }

      sql += ';';
      statements.push(sql);
    }

    return statements;
  }

  /**
   * Render the SQL expression used to index a JSON path inside a JSONB column.
   * Subclasses override for dialect-specific syntax.
   *
   * Default (ANSI-ish): `<jsonColumn>->>'<path>'` — works on Postgres.
   */
  protected formatJsonPathIndexExpression(
    jsonColumn: string,
    path: string,
  ): string {
    return `"${jsonColumn}"->>'${path}'`;
  }

  /**
   * Generate CREATE TRIGGER statements
   * Override in engine-specific strategies - DuckDB returns empty
   */
  generateTriggers(schema: SchemaDefinition): string[] {
    if (!this.supportsTriggers()) {
      return [];
    }

    const { tableName, triggers = [] } = schema;
    const statements: string[] = [];

    if (!triggers || triggers.length === 0) {
      return statements;
    }

    for (const trigger of triggers) {
      const sql = this.generateTriggerStatement(tableName, trigger);
      if (sql) {
        statements.push(sql);
      }
    }

    return statements;
  }

  /**
   * Generate a single trigger statement
   * Can be overridden for engine-specific trigger syntax
   */
  protected generateTriggerStatement(
    tableName: string,
    trigger: TriggerDefinition,
  ): string {
    // Default SQLite-style trigger syntax
    let sql = `CREATE TRIGGER IF NOT EXISTS "${trigger.name}"\n`;
    sql += `${trigger.when} ${trigger.event} ON "${tableName}"\n`;

    if (trigger.condition) {
      sql += `WHEN ${trigger.condition}\n`;
    }

    sql += `BEGIN\n${trigger.body}\nEND;`;

    return sql;
  }

  /**
   * Map abstract SQL type to engine-specific type
   * Default implementation - override for engine-specific types
   */
  mapType(type: SQLDataType): string {
    // Default mapping works for most engines
    switch (type) {
      case 'TEXT':
        return 'TEXT';
      case 'INTEGER':
        return 'INTEGER';
      case 'REAL':
        return 'REAL';
      case 'BLOB':
        return 'BLOB';
      case 'BOOLEAN':
        return 'BOOLEAN';
      case 'JSON':
        return 'JSON';
      case 'TIMESTAMP':
        return 'TIMESTAMP';
      case 'UUID':
        // Fallback for engines without a native uuid type (e.g. SQLite):
        // store as TEXT. PostgreSQL/DuckDB override this with their native
        // uuid type. (R11)
        return 'TEXT';
      default:
        return 'TEXT';
    }
  }

  /**
   * Format default value for SQL
   * Override in engine-specific strategies for different syntax
   */
  formatDefaultValue(value: any, type: SQLDataType): string {
    // Handle SQL functions and keywords (pass through unchanged)
    if (typeof value === 'string') {
      // Check for SQL function calls
      if (value.includes('(')) {
        return value;
      }
      // Check for SQL keywords
      const sqlKeywords = [
        'current_timestamp',
        'current_date',
        'current_time',
        'now()',
        'uuid_generate_v4()',
        'null',
      ];
      if (sqlKeywords.some((kw) => value.toLowerCase() === kw)) {
        return value;
      }
    }

    // Handle NULL
    if (value === null || value === undefined) {
      return 'NULL';
    }

    // Handle by type
    switch (type) {
      case 'TEXT':
        return this.formatStringDefault(String(value));
      case 'INTEGER':
        return String(Math.floor(Number(value) || 0));
      case 'REAL':
        return String(Number(value) || 0);
      case 'BOOLEAN':
        return this.formatBooleanDefault(value);
      case 'TIMESTAMP':
        return this.formatTimestampDefault(value);
      case 'JSON':
        return this.formatJSONDefault(value);
      default:
        return this.formatStringDefault(String(value));
    }
  }

  /**
   * Format string default - escape single quotes
   */
  protected formatStringDefault(value: string): string {
    const escaped = value.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  /**
   * Format boolean default
   * Override for engines that use INTEGER (SQLite)
   */
  protected formatBooleanDefault(value: any): string {
    return value ? 'TRUE' : 'FALSE';
  }

  /**
   * Format timestamp default
   */
  protected formatTimestampDefault(value: any): string {
    if (typeof value === 'string') {
      return `'${value}'`;
    }
    return 'CURRENT_TIMESTAMP';
  }

  /**
   * Format JSON default
   *
   * Ensures the default value is valid JSON for PostgreSQL/SQLite.
   * Invalid inputs like empty strings or '[object Object]' are converted to 'null'.
   * @see https://github.com/happyvertical/smrt/issues/735
   */
  protected formatJSONDefault(value: any): string {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return "'null'";
    }

    // Handle string inputs - need to validate they're valid JSON
    if (typeof value === 'string') {
      // Empty string is not valid JSON
      if (value === '') {
        return "'null'";
      }
      // '[object Object]' is a common bug from accidental toString()
      if (value === '[object Object]') {
        return "'{}'";
      }
      // Try to parse as JSON to validate
      try {
        JSON.parse(value);
        // It's valid JSON, use it as-is (escaped for SQL)
        return `'${value.replace(/'/g, "''")}'`;
      } catch {
        // Not valid JSON - encode the string as a JSON string
        const json = JSON.stringify(value);
        return `'${json.replace(/'/g, "''")}'`;
      }
    }

    // Objects and arrays - stringify them
    const json = JSON.stringify(value);
    return `'${json.replace(/'/g, "''")}'`;
  }

  /**
   * Whether this engine supports triggers
   * Override in DuckDB strategy to return false
   */
  supportsTriggers(): boolean {
    return true;
  }

  /**
   * Whether UNIQUE constraints must be inline for UPSERT
   * Override in DuckDB strategy to return true
   */
  requiresInlineUnique(): boolean {
    return false;
  }
}
