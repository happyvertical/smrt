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

import type { SQLDataType } from '../types.js';
import { BaseDDLStrategy } from './base-strategy.js';
import type { DatabaseEngine } from './types.js';

export class SQLiteStrategy extends BaseDDLStrategy {
  readonly engine: DatabaseEngine = 'sqlite';

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
   * Format boolean as 0/1 for SQLite
   */
  protected formatBooleanDefault(value: any): string {
    return value ? '1' : '0';
  }

  /**
   * Format default value for SQLite
   *
   * CRITICAL: SQLite does NOT support CAST expressions in DEFAULT values.
   * We use plain literals instead.
   */
  formatDefaultValue(value: any, type: SQLDataType): string {
    // Handle SQL functions and keywords
    if (typeof value === 'string') {
      if (value.includes('(')) {
        return value;
      }
      const sqlKeywords = [
        'current_timestamp',
        'current_date',
        'current_time',
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

    // Handle by type - NO CAST expressions!
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
