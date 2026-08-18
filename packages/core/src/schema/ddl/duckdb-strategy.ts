/**
 * DuckDB DDL Strategy
 *
 * DuckDB-specific DDL generation with the following characteristics:
 * - UNIQUE constraints MUST be inline for UPSERT to work (DuckDB issue #12684)
 * - Supports CAST in DEFAULT values
 * - Native BOOLEAN, JSON types
 * - Does NOT support triggers
 *
 * CRITICAL: DuckDB's ON CONFLICT clause only works with inline UNIQUE constraints,
 * not with separate UNIQUE indexes. This is a known DuckDB limitation.
 */

import { isStiSubtypeUniqueIndex, renderIndexTarget } from '../index-utils.js';
import type { SchemaDefinition, SQLDataType } from '../types.js';
import { BaseDDLStrategy } from './base-strategy.js';
import type { DatabaseEngine } from './types.js';

export class DuckDBStrategy extends BaseDDLStrategy {
  readonly engine: DatabaseEngine = 'duckdb';

  /**
   * Map types for DuckDB
   * DuckDB has native support for most types
   */
  mapType(type: SQLDataType): string {
    switch (type) {
      case 'TIMESTAMP':
        return 'TIMESTAMP'; // DuckDB supports TIMESTAMP natively
      case 'JSON':
        return 'JSON'; // DuckDB has native JSON type
      case 'UUID':
        return 'UUID'; // DuckDB has a native UUID type (R11)
      default:
        return super.mapType(type);
    }
  }

  /**
   * Generate CREATE INDEX statements
   *
   * CRITICAL: Skip UNIQUE indexes - they must be inline constraints for UPSERT
   */
  generateIndexes(schema: SchemaDefinition): string[] {
    const { tableName, indexes } = schema;
    const statements: string[] = [];

    for (const index of indexes) {
      // Skip UNIQUE indexes - they're inline constraints
      if (index.unique && !index.where && !index.jsonPath) {
        continue;
      }

      // An STI subtype-scoped UNIQUE (`unique: true` declared only on a
      // descendant, #2359) cannot degrade to a full index the way the other
      // partial indexes below do: dropping the predicate while keeping UNIQUE
      // would enforce one subtype's constraint across every sibling's rows in
      // the shared table. DuckDB has no faithful shape for it, so it is not
      // emitted here (nor by the migration differ on this engine) — the
      // constraint is simply not enforced on DuckDB/JSON. Caller-declared
      // partial uniques (`WHERE active = TRUE`) keep degrading to full UNIQUE.
      if (isStiSubtypeUniqueIndex(index)) {
        continue;
      }

      const target = renderIndexTarget(index, this.engine);
      if (!target) {
        continue;
      }
      const indexType = index.unique ? 'UNIQUE INDEX' : 'INDEX';
      let sql = `CREATE ${indexType} IF NOT EXISTS "${index.name}" ON "${tableName}" (${target})`;

      // DuckDB (and the JSON adapter backed by it) rejects partial indexes.
      // Match the migration differ's documented compatibility behavior by
      // degrading the declaration to a full index while preserving UNIQUE.

      sql += ';';
      statements.push(sql);
    }

    return statements;
  }

  /**
   * DuckDB does NOT support triggers
   */
  generateTriggers(_schema: SchemaDefinition): string[] {
    return []; // DuckDB doesn't support triggers
  }

  /**
   * DuckDB does NOT support triggers
   */
  supportsTriggers(): boolean {
    return false;
  }

  /**
   * CRITICAL: DuckDB requires inline UNIQUE for UPSERT
   *
   * DuckDB issue #12684: ON CONFLICT only works with inline UNIQUE constraints,
   * not with separate CREATE UNIQUE INDEX statements.
   */
  requiresInlineUnique(): boolean {
    return true;
  }
}
