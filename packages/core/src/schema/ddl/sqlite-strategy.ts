/**
 * SQLite DDL Strategy
 *
 * SQLite-specific DDL generation with the following characteristics:
 * - No CAST expressions in DEFAULT values
 * - BOOLEAN stored as INTEGER (0/1)
 * - JSON stored as TEXT (with JSON1 extension functions)
 * - Supports triggers with SQLite syntax
 * - UNIQUE can be inline or separate indexes
 */

import {
  isSafeIdentifierPath,
  quoteIdentifier,
  quoteStringLiteral,
} from '../sql-identifiers.js';
import type { SQLDataType } from '../types.js';
import { BaseDDLStrategy } from './base-strategy.js';
import type { DatabaseEngine } from './types.js';

export class SQLiteStrategy extends BaseDDLStrategy {
  readonly engine: DatabaseEngine = 'sqlite';

  /**
   * SQLite JSON-path index expression — uses the JSON1 `json_extract` function
   * since SQLite has no native `->>` operator pre-3.38 and we want broad
   * compatibility with hosted SQLite/libSQL variants.
   */
  protected formatJsonPathIndexExpression(
    jsonColumn: string,
    path: string,
  ): string {
    if (!isSafeIdentifierPath(jsonColumn)) {
      throw new Error(
        `[DDL] Unsafe JSON-path index column "${jsonColumn}": must be a simple identifier`,
      );
    }
    if (!isSafeIdentifierPath(path)) {
      throw new Error(
        `[DDL] Unsafe JSON-path index path "${path}": must be a simple (dotted) identifier`,
      );
    }
    return `json_extract(${quoteIdentifier(jsonColumn)}, ${quoteStringLiteral(
      `$.${path}`,
    )})`;
  }

  /**
   * Map types for SQLite
   * - BOOLEAN → INTEGER (SQLite uses 0/1)
   * - JSON → TEXT (SQLite stores JSON as text, uses JSON1 functions)
   * - TIMESTAMP → DATETIME (SQLite convention)
   */
  mapType(type: SQLDataType): string {
    switch (type) {
      case 'BOOLEAN':
        return 'INTEGER'; // SQLite uses 0/1 for booleans
      case 'JSON':
        return 'TEXT'; // SQLite stores JSON as TEXT
      case 'TIMESTAMP':
        return 'DATETIME'; // SQLite convention
      default:
        return super.mapType(type);
    }
  }

  /**
   * Format boolean as 0/1 for SQLite.
   *
   * `formatDefaultValue` is inherited from BaseDDLStrategy, which delegates to
   * the shared safe formatter and bridges this override in as the boolean
   * literals — so SQLite booleans render as 0/1 and no CAST expression is ever
   * emitted in a DEFAULT clause.
   */
  protected formatBooleanDefault(value: any): string {
    return value ? '1' : '0';
  }

  /**
   * SQLite supports triggers
   */
  supportsTriggers(): boolean {
    return true;
  }

  /**
   * SQLite doesn't require inline UNIQUE for UPSERT
   * Both inline and separate indexes work
   */
  requiresInlineUnique(): boolean {
    return false;
  }
}
