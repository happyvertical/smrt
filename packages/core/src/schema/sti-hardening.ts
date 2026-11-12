/**
 * Database rules for a shared-table subclass that makes a field required
 * (#4932, rule 3 of #4920).
 *
 * Every column of a shared (STI) table is nullable, because a row of one
 * subclass has no value for another subclass's columns. A subclass that
 * hardens a field the base leaves optional therefore needs a rule that holds
 * only for its own rows: a `CHECK` that is true for every other class.
 *
 * ```sql
 * CHECK (_meta_type NOT IN ('@app/pkg:Strict') OR "code" IS NOT NULL)
 * ```
 *
 * One constraint per column lists every class that requires it. The name is
 * derived from the table, the column and the expression, so a change of the
 * class list is a different constraint and the migration differ can swap it.
 *
 * Only PostgreSQL emits these (see `DDLStrategy.supportsTableChecks`). SQLite
 * cannot add a table constraint in place and DuckDB has no per-class form, so
 * there the rule stays in the manifest and in smrt's own save-time check.
 * A field the base itself requires is not covered: today its column stays
 * nullable, as it always has.
 */
import { sha256Hex } from '../utils/sha256.js';
import { quoteIdentifier, quoteStringLiteral } from './sql-identifiers.js';
import type { TableCheckDefinition } from './types.js';

/** Prefix of every constraint this module names; the differ owns these. */
export const STI_CHECK_PREFIX = 'smrt_ck_';

/** The slice of a field this module reads. */
interface HardenableField {
  type?: string;
  required?: boolean;
  transient?: boolean;
  _meta?: { [key: string]: unknown } | undefined;
}

function isRequiredColumn(field: HardenableField | undefined): boolean {
  if (field?.required !== true) return false;
  if (field.transient || field._meta?.transient) return false;
  if (field._meta?.nullable === true) return false;
  return !['oneToMany', 'manyToMany', 'meta'].includes(field.type ?? '');
}

/**
 * The checks a shared table needs.
 *
 * @param tableName - the shared table
 * @param toColumn - field name to column name
 * @param base - the base class's effective fields
 * @param subclasses - each subclass (as stored in `_meta_type`) with its
 *   effective fields
 */
export function stiHardeningChecks(
  tableName: string,
  toColumn: (fieldName: string) => string,
  base: Iterable<readonly [string, HardenableField]>,
  subclasses: Array<{
    className: string;
    fields: Iterable<readonly [string, HardenableField]>;
  }>,
): TableCheckDefinition[] {
  const baseFields = new Map(base);
  const classesByColumn = new Map<string, Set<string>>();
  for (const { className, fields } of subclasses) {
    for (const [fieldName, field] of fields) {
      if (!isRequiredColumn(field)) continue;
      if (isRequiredColumn(baseFields.get(fieldName))) continue;
      const column = toColumn(fieldName);
      const classes = classesByColumn.get(column) ?? new Set<string>();
      classes.add(className);
      classesByColumn.set(column, classes);
    }
  }
  return [...classesByColumn.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([column, classes]) => {
      const list = [...classes]
        .sort()
        .map((name) => quoteStringLiteral(name))
        .join(', ');
      const expression = `_meta_type NOT IN (${list}) OR ${quoteIdentifier(column)} IS NOT NULL`;
      return {
        name: `${STI_CHECK_PREFIX}${sha256Hex(`${tableName}|${column}|${expression}`).slice(0, 12)}`,
        columns: [column],
        expression,
      };
    });
}
