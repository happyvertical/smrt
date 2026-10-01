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
  | { status: 'clean'; emptyCount?: number }
  | {
      status: 'dirty';
      /** Every non-null value that does not cast, empty text included. */
      count: number;
      /**
       * How many of `count` are empty or whitespace-only text (#3226). When
       * it equals `count` (and there is no `reason`), empty text is the only
       * obstacle and the opt-in `emptyTextAsNull` conversion can store those
       * values as NULL.
       */
      emptyCount?: number;
      /**
       * One offending value, preferring a non-empty one; `''` when empty
       * text is the only obstacle. Display it with {@link maskSampleValue}.
       */
      sample?: string;
      /**
       * `duplicate_keys`: every value casts, but `count` JSON objects carry
       * duplicate keys that `jsonb` would silently collapse (#3041).
       * `preservation_unverified`: every value casts, but the duplicate-key
       * walk did not finish (its bound, a lock wait); `count` is 0 and no
       * conversion may be offered, but the decision must stay visible.
       */
      reason?: 'duplicate_keys' | 'preservation_unverified';
      /** Why the preservation walk did not finish (`preservation_unverified`). */
      detail?: string;
    }
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

/**
 * SQL predicate: the text form of `column` is empty or whitespace-only
 * (#3226). `column` must already be a quoted identifier.
 */
export function renderEmptyTextPredicate(column: string): string {
  return `btrim(${column}::text, E' \\t\\n\\r') = ''`;
}

/**
 * SQL expression: the text form of `column`, with empty or whitespace-only
 * text as NULL (#3226). The cast target of the opt-in empty-text-as-null
 * conversions. `column` must already be a quoted identifier.
 */
export function renderEmptyTextAsNullExpression(column: string): string {
  return `CASE WHEN ${renderEmptyTextPredicate(column)} THEN NULL ELSE ${column}::text END`;
}

/** Options for {@link probeCastSafety}. */
export interface ProbeCastSafetyOptions {
  /**
   * The caller may store empty text as NULL (#3226). For `jsonb`, a column
   * whose only non-castable values are empty text then still gets the
   * duplicate-key preservation walk over its remaining values, so the
   * opt-in conversion is never offered on an unverified column.
   */
  emptyTextAsNull?: boolean;
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
  // #3226: empty/whitespace-only text is counted on its own (it never casts
  // to either target) and kept out of the sample, so the diagnostic shows a
  // genuinely malformed value when there is one. The cast probe runs once
  // per non-empty value.
  const isValid = `${PROBE_FUNCTION}(candidate.value, '${targetType}')`;
  return (
    'SELECT ' +
    'count(*) FILTER (WHERE probe.is_empty OR NOT probe.is_valid) AS invalid_count, ' +
    'count(*) FILTER (WHERE probe.is_empty) AS empty_count, ' +
    'min(probe.value) FILTER (WHERE NOT probe.is_empty AND NOT probe.is_valid) AS sample_value ' +
    'FROM (SELECT candidate.value, candidate.is_empty, ' +
    `CASE WHEN candidate.is_empty THEN true ELSE ${isValid} END AS is_valid ` +
    `FROM (SELECT ${column}::text AS value, ${renderEmptyTextPredicate(column)} AS is_empty ` +
    `FROM ${table} WHERE ${column} IS NOT NULL) AS candidate) AS probe`
  );
}

/**
 * One set-based jsonb cast over every non-null value: `count(expr)` forces
 * the cast for each row, and any value jsonb rejects raises instead of
 * returning, so success proves every value castable (not that the
 * conversion preserves it -- see {@link probeJsonbKeyPreservation}).
 */
function renderSetCastQuerySql(tableName: string, columnName: string): string {
  const column = quoteIdentifier(columnName);
  const table = quoteIdentifier(tableName);
  return `SELECT count((${column}::text)::jsonb) AS cast_count FROM ${table}`;
}

function classifyProbeRows(
  rows: {
    invalid_count?: unknown;
    empty_count?: unknown;
    sample_value?: unknown;
  }[],
): ShapeProbeResult {
  const count = Number(rows[0]?.invalid_count);
  if (!Number.isFinite(count)) {
    return {
      status: 'unavailable',
      reason: 'probe returned a non-numeric count',
    };
  }
  if (count === 0) return { status: 'clean' };
  const rawEmptyCount = Number(rows[0]?.empty_count);
  const emptyCount =
    rows[0]?.empty_count !== undefined && Number.isFinite(rawEmptyCount)
      ? rawEmptyCount
      : undefined;
  const rawSample = rows[0]?.sample_value;
  // #3226: when empty text is the only obstacle there is no non-empty
  // sample; report `''` so the diagnostic names the cause.
  const sample =
    typeof rawSample === 'string'
      ? rawSample
      : emptyCount !== undefined && emptyCount > 0
        ? ''
        : undefined;
  return {
    status: 'dirty',
    count,
    ...(emptyCount !== undefined ? { emptyCount } : {}),
    ...(sample !== undefined ? { sample } : {}),
  };
}

/**
 * Probe every non-null value of a candidate `text` (or, for `jsonb`, native
 * `json`) column for whether it can cast losslessly to `timestamptz` or
 * `jsonb`, in two stages:
 *
 * 1. Cast: a real, exception-safe cast attempt (not a shape heuristic) so an
 *    invalid-calendar timestamp or a structurally-malformed-but-bracket-
 *    balanced JSON document is caught the same as an obviously wrong value.
 *    Any failure to run it (adapter without transaction support, a missing
 *    table mid-run, a test double without a realistic response) resolves to
 *    `unavailable` -- callers must not treat that as "clean".
 * 2. Preservation (`jsonb` only, after a clean cast): duplicate object keys
 *    are `dirty` with reason `duplicate_keys`; a walk that does not finish is
 *    `dirty` with reason `preservation_unverified` and `count: 0`.
 *
 * SMRT never coerces or discards data on an unproven assumption.
 */
export async function probeCastSafety(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  targetType: 'timestamptz' | 'jsonb',
  options: ProbeCastSafetyOptions = {},
): Promise<ShapeProbeResult> {
  const castResult = await probeCastOnly(db, tableName, columnName, targetType);
  if (targetType !== 'jsonb') return castResult;
  if (castResult.status === 'clean') {
    return probeJsonbKeyPreservation(db, tableName, columnName);
  }
  // #3226: empty text is the only obstacle and the caller may store it as
  // NULL -- the remaining values still need the preservation walk before a
  // conversion can be offered.
  if (options.emptyTextAsNull === true && isEmptyTextOnlyProbe(castResult)) {
    const preservation = await probeJsonbKeyPreservation(
      db,
      tableName,
      columnName,
    );
    if (preservation.status === 'dirty') {
      return { ...preservation, emptyCount: castResult.emptyCount };
    }
    return castResult;
  }
  return castResult;
}

/**
 * Whether a probe found non-castable values that are all empty or
 * whitespace-only text (#3226) -- the one shape the opt-in
 * empty-text-as-null conversion can repair.
 */
export function isEmptyTextOnlyProbe(
  result: ShapeProbeResult | undefined,
): result is Extract<ShapeProbeResult, { status: 'dirty' }> & {
  emptyCount: number;
} {
  return (
    result?.status === 'dirty' &&
    result.reason === undefined &&
    result.emptyCount !== undefined &&
    result.emptyCount > 0 &&
    result.emptyCount === result.count
  );
}

/**
 * #3041 review finding: a successful jsonb cast proves castability, not
 * preservation. `jsonb` keeps only the last of duplicate object keys (it
 * also drops key order and insignificant whitespace, which SMRT never
 * treats as data). Walk every container node, nested ones included, and
 * look for a key that appears more than once in an object's own `json` key
 * list (no jsonb re-parse); any such object makes the column dirty so the conversion stays a fail-closed
 * advisory instead of a silent, irreversible rewrite. The result columns
 * reuse the cast probe's names so one classifier reads both.
 */
async function probeJsonbKeyPreservation(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
): Promise<ShapeProbeResult> {
  if (!db.transaction) {
    return {
      status: 'unavailable',
      reason: 'adapter does not support transactions',
    };
  }
  try {
    const result = await db.transaction(async (tx) => {
      await tx.query(
        `SET LOCAL statement_timeout = '${PRESERVATION_PROBE_TIMEOUT}'`,
      );
      return tx.query(renderDuplicateKeyQuerySql(tableName, columnName));
    });
    const rows = (Array.isArray(result) ? result : (result?.rows ?? [])) as {
      invalid_count?: unknown;
      sample_value?: unknown;
    }[];
    const classified = classifyProbeRows(rows);
    return classified.status === 'dirty'
      ? { ...classified, reason: 'duplicate_keys' }
      : classified;
  } catch (error) {
    // #3041 review finding: the cast already proved the column castable, so
    // a walk that ran and gave up (typically the timeout below) is not the
    // "could not probe" state `unavailable` means -- returning it would
    // silently withdraw the conversion. Fail closed, visibly.
    return {
      status: 'dirty',
      count: 0,
      reason: 'preservation_unverified',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderDuplicateKeyQuerySql(
  tableName: string,
  columnName: string,
): string {
  const column = quoteIdentifier(columnName);
  const table = quoteIdentifier(tableName);
  // Only containers recurse (scalars are pruned at the edge), and each
  // object node is checked from its own key list -- a duplicate is a key
  // that appears more than once -- so no subtree is re-parsed as jsonb and
  // the walk stays linear in the number of container nodes.
  const containers = "json_typeof(value) IN ('object', 'array')";
  return (
    'WITH RECURSIVE nodes(v) AS (' +
    `SELECT (${column}::text)::json FROM ${table} ` +
    // #3226: empty text (which becomes NULL under the opt-in conversion)
    // never reaches the json cast; a CASE keeps that evaluation order.
    `WHERE ${column} IS NOT NULL AND CASE WHEN ${renderEmptyTextPredicate(column)} THEN false ` +
    `ELSE json_typeof((${column}::text)::json) IN ('object', 'array') END ` +
    'UNION ALL ' +
    'SELECT child.value FROM nodes CROSS JOIN LATERAL (' +
    "SELECT value FROM json_each(CASE WHEN json_typeof(nodes.v) = 'object' THEN nodes.v ELSE '{}'::json END) " +
    `WHERE ${containers} ` +
    'UNION ALL ' +
    "SELECT value FROM json_array_elements(CASE WHEN json_typeof(nodes.v) = 'array' THEN nodes.v ELSE '[]'::json END) " +
    `WHERE ${containers}` +
    ') AS child) ' +
    'SELECT count(*) AS invalid_count, min(v::text) AS sample_value FROM nodes ' +
    "WHERE json_typeof(v) = 'object' AND EXISTS (" +
    'SELECT 1 FROM json_object_keys(v) AS k(key) GROUP BY k.key HAVING count(*) > 1)'
  );
}

/**
 * Upper bound for the preservation walk. A walk that does not finish (this
 * timeout, a lock wait) resolves to `dirty` with reason
 * `preservation_unverified`: the differ then emits a visible warning
 * advisory with no conversion SQL (never a silent collapse, and never the
 * silent withdrawal `unavailable` would mean).
 */
const PRESERVATION_PROBE_TIMEOUT = '60s';

async function probeCastOnly(
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
  if (targetType === 'jsonb') {
    // #3041 review finding: the per-row PL/pgSQL probe opens a
    // subtransaction per value, and native `json` columns are the large
    // legacy `_meta_data`-style ones. A single set-based cast that succeeds
    // proves every value castable (preservation is checked separately, see
    // `probeJsonbKeyPreservation`); only a failed cast falls through to the
    // per-row probe for the count and sample.
    try {
      const castCount = await db.transaction(async (tx) => {
        const result = await tx.query(
          renderSetCastQuerySql(tableName, columnName),
        );
        const rows = (
          Array.isArray(result) ? result : (result?.rows ?? [])
        ) as {
          cast_count?: unknown;
        }[];
        return rows[0]?.cast_count;
      });
      // Only a realistic answer counts as proof; anything else (an adapter
      // or test double that does not return the count) takes the per-row
      // probe below instead.
      if (
        castCount !== undefined &&
        castCount !== null &&
        Number.isFinite(Number(castCount))
      ) {
        return { status: 'clean' };
      }
    } catch {
      // Fall through: the per-row probe classifies the failure (dirty
      // values, or unavailable for a missing table / unrealistic adapter).
    }
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
 * `hasLiveDefault` and `manifestDefaultValue` are independent: PostgreSQL
 * rejects `ALTER COLUMN ... TYPE` outright whenever the column has *any*
 * existing default that cannot be auto-cast to the target type — this is
 * true whether or not the manifest itself declares a default (a legacy
 * `text` column with `DEFAULT ''` blocks the ALTER exactly the same as one
 * the manifest also wants a default on), so `DROP DEFAULT` must be gated on
 * the *live* default. `SET DEFAULT` afterward must be gated on the
 * *manifest* default instead: re-establishing a live-only default the
 * manifest no longer declares would silently resurrect drift
 * `compareColumnConstraints` is supposed to report and let an operator
 * choose to drop (see #2771/#2772 review findings: DROP/TYPE/SET DEFAULT
 * mirrors the pre-existing `generateTypeUpgradeSQL` path, and the DROP gate
 * must key off live state PostgreSQL itself enforces, not manifest intent).
 */
interface ColumnConversionOptions {
  hasLiveDefault?: boolean;
  manifestDefaultValue?: unknown;
  /**
   * Store empty or whitespace-only text as NULL (#3226). Only for a
   * nullable column whose probe found empty text as the sole obstacle.
   */
  emptyTextAsNull?: boolean;
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
  const hasManifestDefault = options.manifestDefaultValue !== undefined;
  const statements: string[] = [];
  if (options.hasLiveDefault || hasManifestDefault) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
  }
  statements.push(
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE timestamptz USING ${
      options.emptyTextAsNull
        ? `(${renderEmptyTextAsNullExpression(column)})`
        : column
    }::timestamptz`,
  );
  if (hasManifestDefault) {
    const formattedDefault = formatDefaultValue(
      options.manifestDefaultValue,
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
  const hasManifestDefault = options.manifestDefaultValue !== undefined;
  const statements: string[] = [];
  if (options.hasLiveDefault || hasManifestDefault) {
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP DEFAULT`);
  }
  statements.push(
    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE jsonb USING ${
      options.emptyTextAsNull
        ? `(${renderEmptyTextAsNullExpression(column)})`
        : column
    }::jsonb`,
  );
  if (hasManifestDefault) {
    const formattedDefault = formatDefaultValue(
      options.manifestDefaultValue,
      'JSON',
    );
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${formattedDefault}::jsonb`,
    );
  }
  return statements;
}
