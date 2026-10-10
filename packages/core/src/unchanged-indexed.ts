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
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/iu;

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * An instant as whole microseconds since the epoch, or `undefined` when it
 * cannot be established exactly.
 *
 * A `Date` holds milliseconds. Text is read at its full written precision;
 * digits beyond microseconds must be zero. Text without a zone is a wall
 * clock in the process zone unless `naiveIsUtc` (DuckDB's `TIMESTAMP` text,
 * which this runtime always writes as UTC).
 */
export function timestampMicros(
  value: unknown,
  naiveIsUtc = false,
): bigint | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : BigInt(time) * 1000n;
  }
  if (typeof value !== 'string') return undefined;
  const match = TIMESTAMP_TEXT.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  if (fraction.length > 6 && /[1-9]/u.test(fraction.slice(6))) return undefined;
  if (zone === undefined && !naiveIsUtc) return undefined;
  // `Date.UTC` maps years 0-99 onto 1900-1999; set the literal year instead.
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const wall = date.getTime();
  if (Number.isNaN(wall)) return undefined;
  // Date rolls impossible fields over (month 13, minute 60, Feb 30); a field
  // that does not survive the round trip makes the text unprovable.
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return undefined;
  }
  let offsetMinutes = 0;
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetRest = Number(digits.slice(2) || '0');
    if (offsetHours > 23 || offsetRest > 59) return undefined;
    offsetMinutes =
      (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetRest);
  }
  const micros = BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  return (BigInt(wall) - BigInt(offsetMinutes) * 60000n) * 1000n + micros;
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
  exactStoredTimestamp?: string,
): boolean {
  if (isNullish(next) || isNullish(stored)) {
    return isNullish(next) && isNullish(stored);
  }
  const type = (columnType ?? '').toUpperCase();
  if (type === 'TIMESTAMP') {
    // A hydrated `Date` has already lost anything below the millisecond, so
    // only the stored value as the database writes it can prove equality.
    if (exactStoredTimestamp === undefined) return false;
    const a = timestampMicros(next);
    const b = timestampMicros(exactStoredTimestamp, true);
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
 * `TIMESTAMP` columns of `data` whose equality needs the stored value at full
 * precision (see {@link storedValueEquals}); the caller reads them as text.
 */
export function timestampColumnsToProve(
  data: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
  indexedColumns: ReadonlySet<string>,
  columnTypes: Readonly<Record<string, { type?: string } | undefined>>,
): string[] {
  return Object.keys(data).filter(
    (column) =>
      !ALWAYS_ASSIGNED.has(column) &&
      indexedColumns.has(column) &&
      Object.hasOwn(stored, column) &&
      !isNullish(data[column]) &&
      !isNullish(stored[column]) &&
      (columnTypes[column]?.type ?? '').toUpperCase() === 'TIMESTAMP',
  );
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
  exactTimestamps: Readonly<Record<string, string>> = {},
): Set<string> {
  const unchanged = new Set<string>();
  for (const [column, value] of Object.entries(data)) {
    if (ALWAYS_ASSIGNED.has(column) || !indexedColumns.has(column)) continue;
    // A column the stored row does not carry cannot be compared.
    if (!Object.hasOwn(stored, column)) continue;
    if (
      storedValueEquals(
        columnTypes[column]?.type,
        value,
        stored[column],
        exactTimestamps[column],
      )
    ) {
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
