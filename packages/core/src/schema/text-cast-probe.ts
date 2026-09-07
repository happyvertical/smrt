/**
 * Shared "probe, then cast" helpers for text-column type convergence (#2771,
 * #2772).
 *
 * Two drift shapes on a table SMRT itself creates share one problem: a live
 * `text` column holds values that would parse losslessly into the manifest's
 * declared PostgreSQL type (`timestamptz` or `jsonb`), but the differ cannot
 * know that without looking at the data. `probeCastSafety()` answers that with
 * a genuine, exception-safe cast attempt — not a shape heuristic — over every
 * non-null value, and returns one sample so a fail-closed diagnostic can name
 * the offending value without dumping the whole column into JS.
 *
 * PostgreSQL has no `TRY_CAST`/safe-cast builtin before 17 (`pg_input_is_valid`),
 * and this fleet targets 16 (see `.github/workflows/postgres-tests.yml`), so a
 * real per-row safe cast needs PL/pgSQL's exception handling. That handler is
 * created as a session-scoped (`pg_temp`) function, which is why the create
 * statement and the probe query run inside one `db.transaction()` — the two
 * must land on the same physical connection, and a pooled adapter only
 * guarantees that within one transaction. `target_type` is never derived from
 * column data (always the literal `'jsonb'`/`'timestamptz'` this module
 * passes), so the dynamic `EXECUTE format(...)` it builds cannot be steered by
 * a row value; `%L` quotes the probed value as a literal.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { formatDefaultValue, quoteIdentifier } from './sql-identifiers.js';

/** Outcome of a server-side cast-safety probe over one column's non-null values. */
export type ShapeProbeResult =
  | { status: 'clean' }
  | { status: 'dirty'; count: number; sample?: string }
  | { status: 'unavailable'; reason: string };

/**
 * Mask a probed sample value for display in a diagnostic message: keep just
 * enough of the value to recognize it without echoing a full record verbatim
 * into logs/CI output (`created_at`/`_meta_data` values are user data).
 */
export function maskSampleValue(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length <= 6)
    return `${'•'.repeat(value.length)} (length ${value.length})`;
  return `${value.slice(0, 3)}…${value.slice(-3)} (length ${value.length})`;
}

/** Session-scoped helper function name; `pg_temp` keeps it off the real schema. */
const PROBE_FUNCTION = 'pg_temp.smrt_probe_cast_ok';

/**
 * PostgreSQL's "special" date/time input values (see the "Special Values"
 * table in the PostgreSQL docs). Every one of these parses successfully to
 * `timestamptz` — `probeCastSafety`'s real-cast test alone would call a text
 * column literally holding the string `now` or `infinity` "clean" — but
 * casting them evaluates to the *migration's* execution time or an infinite
 * sentinel, silently destroying the original value with no error and no
 * advisory. They must never be treated as safe, regardless of what a bare
 * cast attempt reports.
 */
const TIMESTAMPTZ_SPECIAL_VALUES = new Set([
  'epoch',
  'infinity',
  '-infinity',
  'now',
  'today',
  'tomorrow',
  'yesterday',
  'allballs',
]);

/**
 * A `timestamptz` cast is only safe to apply unattended when the source text
 * already carries an explicit UTC offset (`Z` or `+HH[:MM]`/`-HH[:MM]`) —
 * without one, PostgreSQL interprets the value under the *migrating
 * session's* `TimeZone` setting, so the exact same text can cast to a
 * different instant on a different run/server. That ambiguity is exactly
 * what `--legacy-timezone=UTC` exists to resolve explicitly; the probe must
 * fail closed (not silently guess UTC) so naive values route to that opt-in
 * path instead of being auto-converged.
 */
// PostgreSQL's ARE ("advanced regular expression") dialect, matched with the
// case-insensitive `~*` operator server-side — not a JS RegExp, and not
// derived from one, since the two dialects diverge on escaping/anchoring.
const TIMESTAMPTZ_EXPLICIT_OFFSET_SQL_PATTERN =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}([ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]+)?)?)?[[:space:]]*(Z|[+-][0-9]{2}(:?[0-9]{2})?)$';

/**
 * `target` is one of this module's own literal type names — never data —
 * so building the DDL by interpolation is safe; there is no column, table,
 * or row value in this string.
 */
function renderCreateProbeFunctionSql(): string {
  const specialValuesArray = [...TIMESTAMPTZ_SPECIAL_VALUES]
    .map((value) => `'${value}'`)
    .join(',');
  return (
    `CREATE OR REPLACE FUNCTION ${PROBE_FUNCTION}(value text, target_type text) ` +
    'RETURNS boolean LANGUAGE plpgsql AS $$ ' +
    'BEGIN ' +
    'IF value IS NULL THEN RETURN true; END IF; ' +
    "IF target_type = 'timestamptz' THEN " +
    `IF lower(trim(value)) = ANY (ARRAY[${specialValuesArray}]) THEN RETURN false; END IF; ` +
    `IF trim(value) !~* '${TIMESTAMPTZ_EXPLICIT_OFFSET_SQL_PATTERN}' THEN RETURN false; END IF; ` +
    'END IF; ' +
    "EXECUTE format('SELECT %L::%s', value, target_type); " +
    'RETURN true; ' +
    'EXCEPTION WHEN OTHERS THEN RETURN false; ' +
    'END; $$'
  );
}

function renderProbeQuerySql(
  tableName: string,
  columnName: string,
  targetType: 'timestamptz' | 'jsonb',
): string {
  const column = quoteIdentifier(columnName);
  const table = quoteIdentifier(tableName);
  const isValid = `${PROBE_FUNCTION}(${column}::text, '${targetType}')`;
  return (
    `SELECT count(*) AS invalid_count, ` +
    `min(CASE WHEN NOT ${isValid} THEN ${column}::text END) AS sample_value ` +
    `FROM ${table} WHERE ${column} IS NOT NULL AND NOT ${isValid}`
  );
}

function classifyProbeRows(
  rows: { invalid_count?: unknown; sample_value?: unknown }[],
): ShapeProbeResult {
  const count = Number(rows[0]?.invalid_count);
  if (!Number.isFinite(count)) {
    return {
      status: 'unavailable',
      reason: 'probe returned a non-numeric count',
    };
  }
  if (count === 0) return { status: 'clean' };
  const sample = rows[0]?.sample_value;
  return {
    status: 'dirty',
    count,
    ...(typeof sample === 'string' ? { sample } : {}),
  };
}

/**
 * Probe every non-null value of a candidate `text` column for whether it can
 * cast losslessly to `timestamptz` or `jsonb`, using a real, exception-safe
 * cast attempt (not a shape heuristic) so an invalid-calendar timestamp or a
 * structurally-malformed-but-bracket-balanced JSON document is caught the
 * same as an obviously wrong value. Any failure to run the probe (adapter
 * without transaction support, a missing table mid-run, a test double
 * without a realistic response) resolves to `unavailable` — callers must not
 * treat that as "clean"; SMRT never coerces or discards data on an unproven
 * assumption.
 */
export async function probeCastSafety(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  targetType: 'timestamptz' | 'jsonb',
): Promise<ShapeProbeResult> {
  if (!db.transaction) {
    return {
      status: 'unavailable',
      reason: 'adapter does not support transactions',
    };
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.query(renderCreateProbeFunctionSql());
      const result = await tx.query(
        renderProbeQuerySql(tableName, columnName, targetType),
      );
      const rows = (Array.isArray(result) ? result : (result?.rows ?? [])) as {
        invalid_count?: unknown;
        sample_value?: unknown;
      }[];
      return classifyProbeRows(rows);
    });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Column-conversion options shared by {@link renderTimestamptzColumnConversion}
 * and {@link renderJsonbColumnConversion}.
 *
 * `defaultValue` must be passed whenever `hasDefault` is true: PostgreSQL
 * requires `DROP DEFAULT` before `ALTER COLUMN ... TYPE` can run (the old
 * default is rarely valid syntax for the new type), but the manifest still
 * declares a default for this column — omitting the matching `SET DEFAULT`
 * would leave the live column permanently defaultless, silently breaking any
 * writer that relies on the database to supply it (see #2771/#2772 review
 * finding: this mirrors the DROP/TYPE/SET DEFAULT sequence the pre-existing
 * `generateTypeUpgradeSQL` path already uses).
 */
interface ColumnConversionOptions {
  hasDefault?: boolean;
  defaultValue?: unknown;
}

/**
 * Render the one-time PostgreSQL conversion of a legacy `text` column to
 * native `timestamptz`, once {@link probeCastSafety} has confirmed every
 * non-null value casts safely.
 */
export function renderTimestamptzColumnConversion(
  tableName: string,
  columnName: string,
  options: ColumnConversionOptions = {},
): string[] {
  const table = quoteIdentifier(tableName);
  const column = quoteIdentifier(columnName);
  const statements: string[] = [];
  if (options.hasDefault) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
  }
  statements.push(
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE timestamptz USING ${column}::timestamptz`,
  );
  if (options.hasDefault) {
    const formattedDefault = formatDefaultValue(
      options.defaultValue,
      'TIMESTAMP',
    );
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${formattedDefault}`,
    );
  }
  return statements;
}

/**
 * Render the one-time PostgreSQL conversion of a legacy `text` column to
 * native `jsonb`, once {@link probeCastSafety} has confirmed every non-null
 * value casts safely.
 */
export function renderJsonbColumnConversion(
  tableName: string,
  columnName: string,
  options: ColumnConversionOptions = {},
): string[] {
  const table = quoteIdentifier(tableName);
  const column = quoteIdentifier(columnName);
  const statements: string[] = [];
  if (options.hasDefault) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
  }
  statements.push(
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE jsonb USING ${column}::jsonb`,
  );
  if (options.hasDefault) {
    const formattedDefault = formatDefaultValue(options.defaultValue, 'JSON');
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${formattedDefault}::jsonb`,
    );
  }
  return statements;
}
