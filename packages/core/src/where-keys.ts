/**
 * How a `where` key names a column.
 *
 * A filter key is caller spelling, not a column name: `tenantId`, `tenant_id`,
 * `TenantId` and `tenantId =` all filter the column `tenant_id` for equality.
 * `SmrtCollection` resolves keys to columns with the functions in this module
 * and refuses a record in which two keys resolve to the same column and
 * operator, so a filter never depends on which spelling was written last.
 *
 * Anything that inspects a filter before the collection resolves it — a
 * `beforeList` / `beforeGet` interceptor deciding whether a column is already
 * filtered, a route forcing a scope onto caller input — must compare resolved
 * columns through these same functions, never literal keys.
 */

import { ValidationError } from './errors';
import { toSnakeCase } from './utils/naming';

/**
 * A `where` clause the collection refuses to run.
 *
 * Extends `ValidationError` so the retry classifier never retries it, and
 * carries `status` / `publicMessage` so `normalizeTypedHttpError()` renders it
 * as a structured 400.
 */
export class WhereClauseError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(
    message: string,
    code = 'INVALID_WHERE_CLAUSE',
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    this.name = 'WhereClauseError';
    this.publicMessage = message;
  }
}

/** The column and operator one `where` key resolves to. */
export interface ResolvedWhereKey {
  /** Field portion of the key as written, including any dot path. */
  field: string;
  /** Field portion before the first dot, as written. */
  baseField: string;
  /** snake_case column the key filters on. */
  column: string;
  /** Dot path after the column (with its leading dot), or `null`. */
  path: string | null;
  /** Operator as written; `'='` when the key names none. */
  operator: string;
}

/**
 * Column name for a field name: camelCase to snake_case, keeping a leading
 * underscore (`_metaType` and `_meta_type` are both `_meta_type`).
 */
export function whereColumnName(field: string): string {
  return field.startsWith('_')
    ? `_${toSnakeCase(field.slice(1))}`
    : toSnakeCase(field);
}

/**
 * Split a `where` key into the column and operator it filters on.
 *
 * Total: it never throws and does not validate. `SmrtCollection` validates the
 * parts afterwards (identifier shape, known operator, declared field).
 */
export function resolveWhereKey(key: string): ResolvedWhereKey {
  const parts = key.trim().split(/\s+/);
  const field = parts[0];
  const operator = parts.slice(1).join(' ') || '=';
  const dotIndex = field.indexOf('.');
  const baseField = dotIndex >= 0 ? field.substring(0, dotIndex) : field;
  return {
    field,
    baseField,
    column: whereColumnName(baseField),
    path: dotIndex >= 0 ? field.substring(dotIndex) : null,
    operator,
  };
}

/**
 * Operator a key runs with for a given value: an array under the default `=`
 * is an `in` list.
 */
export function effectiveWhereOperator(
  operator: string,
  value: unknown,
): string {
  return operator === '=' && Array.isArray(value) ? 'in' : operator;
}

/**
 * The predicate a key/value pair resolves to: `column` for equality, otherwise
 * `column operator`. Two keys with the same result filter the same column with
 * the same operator, whatever their spelling.
 */
export function normalizeWhereKey(key: string, value: unknown): string {
  const { column, path, operator } = resolveWhereKey(key);
  const effective = effectiveWhereOperator(operator, value);
  const target = path ? `${column}${path}` : column;
  return effective === '=' ? target : `${target} ${effective}`;
}

/**
 * Add predicates the caller must not be able to change to one `where` record.
 *
 * Each caller key that resolves to the same column and operator as an owned
 * key is dropped, under any spelling, and the owned predicate takes its place.
 * Caller keys with a different operator on that column stay and are ANDed, so
 * they can only narrow the result. That holds even when such a key is written
 * exactly like an owned key — `_meta_type: [a, b]` (an `in` list) beside an
 * owned `_meta_type: x` (equality): the caller key is renamed to another
 * spelling of its own predicate (`_meta_type in`; for equality `field =` or
 * the bare `field`) so both predicates reach the query.
 */
export function mergeOwnedWhere<T extends Record<string, unknown>>(
  where: T | undefined,
  owned: Record<string, unknown>,
): T {
  const ownedKeys = new Set(
    Object.entries(owned).map(([key, value]) => normalizeWhereKey(key, value)),
  );
  // Spread, then delete: assigning key by key would turn an own `__proto__`
  // entry into a prototype write and hide it from the later validation.
  const merged: Record<string, unknown> = { ...(where ?? {}) };
  for (const key of Object.keys(merged)) {
    if (ownedKeys.has(normalizeWhereKey(key, merged[key]))) {
      delete merged[key];
    }
  }
  // A surviving caller key spelled exactly like an owned key has a different
  // operator, yet the object spread below would replace it. Move it to its
  // explicit `field operator` spelling, which resolves to the same predicate.
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(owned, key)) continue;
    const value = merged[key];
    const { field, column, operator } = resolveWhereKey(key);
    const effective = effectiveWhereOperator(operator, value);
    // Another spelling of the same predicate: `field in`, or for equality
    // whichever of `field =` / `field` the caller and owner did not use.
    const spellings =
      effective === '=' ? [`${field} =`, field] : [`${field} ${effective}`];
    const explicit =
      spellings.find(
        (spelling) => spelling !== key && !Object.hasOwn(owned, spelling),
      ) ?? spellings[0];
    if (
      explicit === key ||
      Object.hasOwn(merged, explicit) ||
      Object.hasOwn(owned, explicit)
    ) {
      // Two caller keys for one column and operator: refused as the
      // collection would refuse them, before the rename could hide one.
      throw new WhereClauseError(
        `Invalid WHERE clause: '${key}' and '${explicit}' both filter ` +
          `'${column}' with operator '${effective}'. ` +
          `Give each column one condition per operator.`,
        'INVALID_WHERE_CLAUSE',
        { column, operator: effective },
      );
    }
    delete merged[key];
    merged[explicit] = value;
  }
  return { ...merged, ...owned } as T;
}

/**
 * Force a scope onto a caller-supplied `where` record.
 *
 * Every caller key that filters a scoped column is dropped — under any
 * spelling and with any operator — and the scope's own keys are added. Use it
 * where the caller must have no say at all over a column, such as an anonymous
 * read of a tenant-scoped model that is limited to rows without a tenant.
 *
 * Returns `where` unchanged when there is no scope.
 */
export function applyWhereScope(
  where: Record<string, unknown> | undefined,
  scope: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!scope) return where;
  const scopedColumns = new Set(
    Object.keys(scope).map((key) => resolveWhereKey(key).column),
  );
  const scoped: Record<string, unknown> = { ...(where ?? {}) };
  for (const key of Object.keys(scoped)) {
    if (scopedColumns.has(resolveWhereKey(key).column)) delete scoped[key];
  }
  return { ...scoped, ...scope };
}

/**
 * Refuse a `get()` / `delete()` filter that does not name a row.
 *
 * A filter is an id or slug string, or a plain object with at least one
 * condition. A number, a boolean, an array, `null` or `{}` carries no
 * condition: read as a filter it would select whichever row the engine
 * returns first.
 *
 * @throws {WhereClauseError} code `INVALID_GET_FILTER`, a typed 400
 */
export function assertGetFilter(filter: unknown): void {
  if (typeof filter === 'string') return;
  if (filter !== null && typeof filter === 'object' && !Array.isArray(filter)) {
    const prototype = Object.getPrototypeOf(filter);
    if (
      (prototype === Object.prototype || prototype === null) &&
      Object.keys(filter).length > 0
    ) {
      return;
    }
  }
  throw new WhereClauseError(
    'Invalid get filter: expected an id or slug string, or an object with at least one condition.',
    'INVALID_GET_FILTER',
  );
}
