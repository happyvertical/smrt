/**
 * Index-rendering helpers shared across DDL strategies, schema aggregator,
 * and the migration generator/differ.
 *
 * IMPORTANT: this module must remain a pure utility with **type-only
 * imports** to avoid introducing a cycle with `registry.ts` /
 * `collection.ts`. Don't add runtime imports that pull SmrtClass /
 * SmrtCollection / ObjectRegistry through here.
 */

import type { DatabaseEngine } from './ddl/types.js';
import type { IndexDefinition } from './types.js';

/**
 * Render the SQL target of a CREATE INDEX statement.
 *
 * For ordinary indexes this is a comma-separated, double-quoted column list.
 * For JSON-path indexes (introduced by `@meta({ indexed: true })`) it is the
 * dialect-specific expression that points into a JSONB column.
 *
 * @param index - The index definition (may carry `jsonPath`)
 * @param engine - The target database dialect
 * @returns The contents of the trailing `(...)` of the CREATE INDEX statement
 */
export function renderIndexTarget(
  index: Pick<IndexDefinition, 'columns' | 'jsonPath'>,
  engine: DatabaseEngine,
): string {
  if (index.jsonPath?.column && index.jsonPath.path) {
    const col = index.jsonPath.column;
    const path = index.jsonPath.path;
    if (engine === 'sqlite') {
      return `json_extract("${col}", '$.${path}')`;
    }
    // Postgres / DuckDB JSON path access via ->>
    return `"${col}"->>'${path}'`;
  }
  return (index.columns ?? []).map((c) => `"${c}"`).join(', ');
}

/**
 * True if the index has a valid jsonPath target.
 */
export function isJsonPathIndex(
  index: Pick<IndexDefinition, 'jsonPath'>,
): boolean {
  return !!(index.jsonPath?.column && index.jsonPath.path);
}
