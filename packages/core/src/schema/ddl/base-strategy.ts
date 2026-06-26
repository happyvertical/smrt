/**
 * Base DDL Strategy - Shared logic for all database engines
 *
 * Provides common DDL generation logic that engine-specific strategies
 * can override for their particular requirements.
 */

import { createLogger } from '@happyvertical/logger';
import {
  formatDefaultValue as formatDefaultValueShared,
  isSafeIdentifier,
  isSafeIdentifierPath,
  quoteIdentifier,
  quoteStringLiteral,
} from '../sql-identifiers.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
  TriggerDefinition,
} from '../types.js';
import type { DatabaseEngine, DDLStrategy } from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Validate the column + JSON path used to build a JSON-path index expression.
 *
 * The path segment is embedded as a SQL string literal inside a dialect
 * function/operator (`json_extract("col", '$.path')` / `"col"->>'path'`), and
 * the column as a delimited identifier. We escape both, but also reject paths
 * or columns that aren't simple (dotted) identifiers so a malformed `@meta`
 * field name can't smuggle structure into the expression even after escaping.
 * These names are developer-controlled build-time inputs, so an invalid one is
 * a programming error and throwing is the safest, loudest outcome.
 */
function assertSafeJsonPathTarget(jsonColumn: string, path: string): void {
  if (!isSafeIdentifier(jsonColumn)) {
    throw new Error(
      `[DDL] Unsafe JSON-path index column "${jsonColumn}": must be a simple identifier`,
    );
  }
  if (!isSafeIdentifierPath(path)) {
    throw new Error(
      `[DDL] Unsafe JSON-path index path "${path}": must be a simple (dotted) identifier`,
    );
  }
}

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

    let sql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (\n`;

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
    const parts: string[] = [
      quoteIdentifier(columnName),
      this.mapType(columnDef.type),
    ];

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
        const columns = index.columns.map((c) => quoteIdentifier(c)).join(', ');
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
        logger.warn(`[DDL] Skipping malformed index: ${JSON.stringify(index)}`);
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
        : index.columns.map((c) => quoteIdentifier(c)).join(', ');

      let sql = `CREATE ${indexType} IF NOT EXISTS ${quoteIdentifier(
        index.name,
      )} ON ${quoteIdentifier(tableName)} (${target})`;

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
    assertSafeJsonPathTarget(jsonColumn, path);
    return `${quoteIdentifier(jsonColumn)}->>${quoteStringLiteral(path)}`;
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
    let sql = `CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(trigger.name)}\n`;
    sql += `${trigger.when} ${trigger.event} ON ${quoteIdentifier(tableName)}\n`;

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
   * Format default value for SQL.
   *
   * Delegates to the shared, injection-safe `formatDefaultValue`
   * (`schema/sql-identifiers.ts`) so every DDL path uses one set of rules:
   * an allowlist of SQL keyword/function defaults (not "contains `(`"),
   * type-driven literal quoting, and no folding of the string `"null"` into
   * the SQL NULL keyword. Boolean rendering is bridged through
   * `formatBooleanDefault` so engine overrides (SQLite → 0/1) still apply.
   */
  formatDefaultValue(value: unknown, type: SQLDataType): string {
    return formatDefaultValueShared(value, type, {
      booleanLiterals: [
        this.formatBooleanDefault(true),
        this.formatBooleanDefault(false),
      ],
    });
  }

  /**
   * Format boolean default
   * Override for engines that use INTEGER (SQLite)
   */
  protected formatBooleanDefault(value: boolean): string {
    return value ? 'TRUE' : 'FALSE';
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
