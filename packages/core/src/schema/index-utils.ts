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
import {
  isSafeIdentifierPath,
  quoteIdentifier,
  quoteStringLiteral,
} from './sql-identifiers.js';
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
    // The column is interpolated as an identifier and the path as a SQL string
    // literal. Validate both against an identifier allowlist (these are
    // developer-controlled `@meta` field names) so a malformed name can't
    // smuggle structure into the expression even after escaping.
    if (!isSafeIdentifierPath(col)) {
      throw new Error(
        `[index-utils] Unsafe JSON-path index column "${col}": must be a simple identifier`,
      );
    }
    if (!isSafeIdentifierPath(path)) {
      throw new Error(
        `[index-utils] Unsafe JSON-path index path "${path}": must be a simple (dotted) identifier`,
      );
    }
    if (engine === 'sqlite') {
      // SQLite's json_extract is a function call — no extra wrapping needed.
      return `json_extract(${quoteIdentifier(col)}, ${quoteStringLiteral(
        `$.${path}`,
      )})`;
    }
    // Postgres / DuckDB JSON path access via `->>`. PostgreSQL requires
    // operator expressions in index elements to be parenthesized — the
    // outer `()` in `CREATE INDEX ... ON tbl (...)` is the column list, so
    // the expression itself needs its own parens. Returning the wrapped
    // form here keeps the rule local to this helper and works on DuckDB
    // (extra parens are harmless).
    return `(${quoteIdentifier(col)}->>${quoteStringLiteral(path)})`;
  }
  return (index.columns ?? []).map((c) => quoteIdentifier(c)).join(', ');
}

/**
 * True if the index has a valid jsonPath target.
 */
export function isJsonPathIndex(
  index: Pick<IndexDefinition, 'jsonPath'>,
): boolean {
  return !!(index.jsonPath?.column && index.jsonPath.path);
}
