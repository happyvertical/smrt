/**
 * PostgreSQL DDL Strategy
 *
 * PostgreSQL-specific DDL generation with the following characteristics:
 * - JSONB type for JSON columns (more efficient than JSON)
 * - Native BOOLEAN type
 * - Full trigger support with PL/pgSQL functions
 * - UNIQUE can be inline or separate indexes
 * - Supports CAST in DEFAULT values
 */

import { shortenIdentifier } from '../index-utils.js';
import type { SQLDataType, TriggerDefinition } from '../types.js';
import { BaseDDLStrategy } from './base-strategy.js';
import type { DatabaseEngine } from './types.js';

export class PostgresStrategy extends BaseDDLStrategy {
  readonly engine: DatabaseEngine = 'postgres';

  /**
   * Map types for PostgreSQL
   * - JSON → JSONB (more efficient, supports indexing)
   * - TIMESTAMP → TIMESTAMP WITH TIME ZONE (best practice)
   */
  mapType(type: SQLDataType): string {
    switch (type) {
      case 'INTEGER':
        return 'BIGINT';
      case 'BLOB':
        return 'BYTEA';
      case 'JSON':
        return 'JSONB'; // PostgreSQL JSONB is more efficient
      case 'TIMESTAMP':
        // JavaScript Date represents an instant. Preserve that contract in
        // PostgreSQL instead of discarding the ISO offset in a timezone-naive
        // TIMESTAMP column and reinterpreting the wall time at hydration.
        return 'TIMESTAMPTZ';
      case 'REAL':
        return 'DOUBLE PRECISION'; // PostgreSQL convention
      case 'UUID':
        return 'uuid'; // Native 16-byte uuid (R11) — vs 37-byte text
      default:
        return super.mapType(type);
    }
  }

  /**
   * Generate trigger for PostgreSQL
   *
   * PostgreSQL triggers require a separate function, then the trigger.
   * For updated_at timestamps, we generate both.
   */
  protected generateTriggerStatement(
    tableName: string,
    trigger: TriggerDefinition,
  ): string {
    // For simple triggers, we need to create a function first
    // This is PostgreSQL's two-step trigger process

    // Check if this is an updated_at trigger
    if (trigger.name.includes('updated_at')) {
      // Generate the function and trigger for updated_at. The function name is
      // a PostgreSQL identifier like any other, so it is subject to the same
      // 63-byte limit — and unlike an index it is *referenced* by the trigger
      // below, so a truncation that CREATE FUNCTION accepts would leave
      // EXECUTE FUNCTION pointing at a name PostgreSQL never stored (#2374).
      const functionName = shortenIdentifier(`update_${tableName}_updated_at`);

      let sql = `-- Function for ${trigger.name}\n`;
      sql += `CREATE OR REPLACE FUNCTION ${functionName}()\n`;
      sql += `RETURNS TRIGGER AS $$\n`;
      sql += `BEGIN\n`;
      sql += `  NEW.updated_at = CURRENT_TIMESTAMP;\n`;
      sql += `  RETURN NEW;\n`;
      sql += `END;\n`;
      sql += `$$ LANGUAGE plpgsql;\n\n`;

      sql += `-- Trigger\n`;
      sql += `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${tableName}";\n`;
      sql += `CREATE TRIGGER "${trigger.name}"\n`;
      sql += `${trigger.when} ${trigger.event} ON "${tableName}"\n`;
      sql += `FOR EACH ROW\n`;
      sql += `EXECUTE FUNCTION ${functionName}();`;

      return sql;
    }

    // For custom triggers, use the provided body
    let sql = `DROP TRIGGER IF EXISTS "${trigger.name}" ON "${tableName}";\n`;
    sql += `CREATE TRIGGER "${trigger.name}"\n`;
    sql += `${trigger.when} ${trigger.event} ON "${tableName}"\n`;
    sql += `FOR EACH ROW\n`;

    if (trigger.condition) {
      sql += `WHEN (${trigger.condition})\n`;
    }

    // PostgreSQL triggers need EXECUTE FUNCTION or EXECUTE PROCEDURE
    // If body contains a function call, use it directly
    if (trigger.body.includes('EXECUTE')) {
      sql += trigger.body;
    } else {
      // Wrap in anonymous DO block or assume it's a function name
      sql += `EXECUTE FUNCTION ${trigger.body}`;
    }

    return `${sql};`;
  }

  /**
   * PostgreSQL supports triggers
   */
  supportsTriggers(): boolean {
    return true;
  }

  /**
   * PostgreSQL doesn't require inline UNIQUE for UPSERT
   * Both inline and separate indexes work with ON CONFLICT
   */
  requiresInlineUnique(): boolean {
    return false;
  }
}
