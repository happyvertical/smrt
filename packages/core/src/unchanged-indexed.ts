/**
 * Unchanged indexed assignments on persisted rows (#3737).
 *
 * DuckDB rewrites a row (delete + insert) when an INDEXED column is assigned,
 * even with its existing value. A parent that a foreign key still references
 * therefore raises a referenced-parent violation for `SET slug = <same slug>`.
 * `SmrtObject.save()` serializes the whole model, so every existing-row write
 * used to assign `slug`, `context`, `tenant_id`, `created_at`, ... unchanged.
 *
 * This module holds the pure decisions: which columns are indexed, whether a
 * pending value provably equals the stored one, and how an assignment value
 * is bound by the generic UPDATE API. Nothing here touches a database, so the
 * save path keeps owning revision checks, tenant isolation and error typing.
 *
 * Everything errs toward "assign as before": an unknown column, a missing
 * stored value or a value that cannot be compared is NOT reported unchanged.
 */

import type { SchemaDefinition } from './schema/types.js';
import { toSnakeCase } from './utils';

/** Columns the save path always writes, whatever their stored value. */
const ALWAYS_ASSIGNED = new Set(['id', 'updated_at']);

/**
 * Columns whose assignment DuckDB may treat as an index rewrite.
 *
 * The union of what the registry schema declares (primary key, UNIQUE, every
 * declared index including partial and JSON-path ones, foreign keys) and the
 * natural-key / ownership columns the runtime itself keys writes by. Being
 * over-inclusive is harmless — a column is only skipped when it is also proven
 * unchanged — so this never has to be an exact model of the physical DDL.
 */
export function collectIndexedColumns(
  schemas: ReadonlyArray<SchemaDefinition | undefined>,
  runtimeKeyColumns: Iterable<string>,
): Set<string> {
  const indexed = new Set<string>();
  for (const column of runtimeKeyColumns) {
    // Only camelCase field names need mapping; `toSnakeCase` would strip the
    // leading underscore of `_meta_type`.
    indexed.add(/[A-Z]/u.test(column) ? toSnakeCase(column) : column);
  }
  for (const schema of schemas) {
    if (!schema) continue;
    for (const [name, column] of Object.entries(schema.columns ?? {})) {
      if (column.primaryKey || column.unique || column.foreignKey) {
        indexed.add(name);
      }
    }
    for (const index of schema.indexes ?? []) {
      for (const name of index.columns ?? []) indexed.add(name);
      if (index.jsonPath?.column) indexed.add(index.jsonPath.column);
    }
    for (const foreignKey of schema.foreignKeys ?? []) {
      indexed.add(foreignKey.column);
    }
  }
  return indexed;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ZONED_TIMESTAMP = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/iu;

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function instantOf(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  // An unzoned string would be read in the process zone; only a string that
  // names its own zone identifies an instant.
  if (typeof value === 'string' && ZONED_TIMESTAMP.test(value.trim())) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

function canonicalJson(value: unknown): string | undefined {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return node;
  };
  try {
    return JSON.stringify(normalize(parsed));
  } catch {
    return undefined;
  }
}

/**
 * Whether `next` (the value about to be written) provably equals `stored`
 * (the canonical value read back from the row). `false` means "assign it":
 * either it differs or equality cannot be established.
 */
export function storedValueEquals(
  columnType: string | undefined,
  next: unknown,
  stored: unknown,
): boolean {
  if (isNullish(next) || isNullish(stored)) {
    return isNullish(next) && isNullish(stored);
  }
  const type = (columnType ?? '').toUpperCase();
  if (type === 'TIMESTAMP') {
    const a = instantOf(next);
    const b = instantOf(stored);
    return a !== undefined && b !== undefined && a === b;
  }
  if (type === 'JSON') {
    const a = canonicalJson(next);
    const b = canonicalJson(stored);
    return a !== undefined && b !== undefined && a === b;
  }
  if (typeof next === 'string' && typeof stored === 'string') {
    if (
      type === 'UUID' &&
      UUID_PATTERN.test(next) &&
      UUID_PATTERN.test(stored)
    ) {
      return next.toLowerCase() === stored.toLowerCase();
    }
    return next === stored;
  }
  if (typeof next === 'boolean' && typeof stored === 'boolean') {
    return next === stored;
  }
  const numeric = (value: unknown): bigint | number | undefined =>
    typeof value === 'bigint' || typeof value === 'number' ? value : undefined;
  const a = numeric(next);
  const b = numeric(stored);
  if (a !== undefined && b !== undefined) {
    // biome-ignore lint/suspicious/noDoubleEquals: bigint/number cross-type value equality is the point.
    return a == b;
  }
  return false;
}

/**
 * Indexed columns of `data` whose value provably equals the stored row's, in
 * snake_case column names. `id` and `updated_at` are never reported: the
 * revision token always advances, and `id` is the write's key.
 */
export function unchangedIndexedColumns(
  data: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
  indexedColumns: ReadonlySet<string>,
  columnTypes: Readonly<Record<string, { type?: string } | undefined>>,
): Set<string> {
  const unchanged = new Set<string>();
  for (const [column, value] of Object.entries(data)) {
    if (ALWAYS_ASSIGNED.has(column) || !indexedColumns.has(column)) continue;
    // A column the stored row does not carry cannot be compared.
    if (!Object.hasOwn(stored, column)) continue;
    if (storedValueEquals(columnTypes[column]?.type, value, stored[column])) {
      unchanged.add(column);
    }
  }
  return unchanged;
}

/**
 * An id-targeted `UPDATE` for native DuckDB, with every identifier quoted and
 * every value bound the way the DuckDB adapter's `upsert()` binds its
 * `DO UPDATE SET` values: `NULL` literals, `''` cast to TEXT, dates as ISO
 * strings, arrays and plain objects as JSON text.
 *
 * The adapter's generic `update()` is not used because it renders column names
 * unquoted (a column named `order` or `group` is a syntax error) and hands
 * dates and structures to the driver untouched; the `upsert()` it replaces
 * handled both.
 */
export function buildDuckDbIdUpdate(
  table: string,
  id: unknown,
  assignments: Readonly<Record<string, unknown>>,
): { sql: string; values: unknown[] } {
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const values: unknown[] = [];
  const sets: string[] = [];
  for (const [column, value] of Object.entries(assignments)) {
    let expression: string;
    if (value === null || value === undefined) {
      expression = 'NULL';
    } else if (value === '') {
      values.push(value);
      expression = 'CAST(? AS TEXT)';
    } else if (value instanceof Date) {
      values.push(value.toISOString());
      expression = '?';
    } else if (
      Array.isArray(value) ||
      (typeof value === 'object' &&
        Object.getPrototypeOf(value) === Object.prototype)
    ) {
      values.push(JSON.stringify(value));
      expression = 'CAST(? AS JSON)';
    } else {
      values.push(value);
      expression = '?';
    }
    sets.push(`${quote(column)} = ${expression}`);
  }
  values.push(id);
  return {
    sql: `UPDATE ${quote(table)} SET ${sets.join(', ')} WHERE ${quote('id')} = ?`,
    values,
  };
}
