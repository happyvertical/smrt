/**
 * Shared "shape probe, then cast" helpers for text-column type convergence
 * (#2771, #2772).
 *
 * Two drift shapes on a table SMRT itself creates share one problem: a live
 * `text` column holds values that would parse losslessly into the manifest's
 * declared PostgreSQL type (`timestamptz` or `jsonb`), but the differ cannot
 * know that without looking at the data. Both probes follow the same
 * pattern the pre-R11 `text`->`uuid` convergence established
 * (`schema/uuid-convergence.ts`, `renderUuidShapeProbe`): a single
 * server-side aggregate query counts values that do NOT match the target
 * shape, and returns one sample so a fail-closed diagnostic can name the
 * offending value without dumping the whole column into JS.
 *
 * The `timestamptz` probe validates by regex shape only (mirroring the uuid
 * probe exactly) because every value SMRT itself ever wrote is a
 * JavaScript `Date#toISOString()` output. `jsonb` shape validation cannot be
 * a true parser in plain SQL (PostgreSQL has no `TRY_CAST`/safe-cast builtin
 * before 17, and this fleet targets 16 — see `.github/workflows/postgres-tests.yml`
 * — so a per-row exception-catching probe would need a session-scoped
 * PL/pgSQL helper function whose lifetime would have to be pinned to one
 * physical connection across two separate queries). The regex used here is a
 * conservative shape check, not a full grammar, so it can theoretically
 * accept a structurally-invalid document (e.g. mismatched nesting). That is
 * an acceptable residual risk: the actual `ALTER COLUMN … TYPE jsonb USING
 * col::jsonb` this module renders always runs inside the same atomic
 * migration transaction as everything else in a `db:migrate` batch, so
 * PostgreSQL's own real JSON parser is the final safety net — a probe false
 * negative aborts and rolls back the whole batch with a clear PostgreSQL
 * error instead of writing corrupt data.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { quoteIdentifier } from './sql-identifiers.js';

/** Outcome of a server-side shape probe over one column's non-null values. */
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

/**
 * Explicit-offset ISO-8601 instant shape: every value SMRT itself writes for
 * a timestamp column (`Date#toISOString()`, e.g.
 * `2023-01-15T10:00:00.000Z`) or an equivalent explicit-offset form. A
 * timestamp with NO offset (a naive wall time) deliberately does not match:
 * interpreting it unambiguously requires the operator-confirmed
 * `postgresTimestampMigration.legacyTimezone` path, not this probe.
 */
export const TIMESTAMPTZ_SHAPE_PATTERN =
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$';

/**
 * Conservative JSON value shape: an object, an array, a quoted string, a
 * number, or a JSON literal. See the module doc for why this is a shape
 * check rather than a full parser.
 */
export const JSON_SHAPE_PATTERN =
  '^\\s*(\\{.*\\}|\\[.*\\]|"([^"\\\\]|\\\\.)*"|-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)\\s*$';

function renderShapeProbeSql(
  tableName: string,
  columnName: string,
  pattern: string,
): string {
  const column = quoteIdentifier(columnName);
  return (
    `SELECT count(*) AS invalid_count, min(${column}::text) AS sample_value ` +
    `FROM ${quoteIdentifier(tableName)} ` +
    `WHERE ${column} IS NOT NULL AND ${column}::text !~ '${pattern}'`
  );
}

/** Render the shape-probe query for a candidate `text` -> `timestamptz` column. */
export function renderTimestamptzShapeProbe(
  tableName: string,
  columnName: string,
): string {
  return renderShapeProbeSql(tableName, columnName, TIMESTAMPTZ_SHAPE_PATTERN);
}

/** Render the shape-probe query for a candidate `text` -> `jsonb` column. */
export function renderJsonbShapeProbe(
  tableName: string,
  columnName: string,
): string {
  return renderShapeProbeSql(tableName, columnName, JSON_SHAPE_PATTERN);
}

/**
 * Run a rendered shape-probe query and classify the result. Any query
 * failure (missing table mid-run, adapter error, a mock without a realistic
 * response) resolves to `unavailable` — callers must not treat that as
 * "clean"; SMRT never coerces or discards data on an unproven assumption.
 */
export async function runShapeProbe(
  db: DatabaseInterface,
  sql: string,
): Promise<ShapeProbeResult> {
  try {
    const result = await db.query(sql);
    const rows = (Array.isArray(result) ? result : (result?.rows ?? [])) as {
      invalid_count?: unknown;
      sample_value?: unknown;
    }[];
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
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Render the one-time PostgreSQL conversion of a legacy `text` column to
 * native `timestamptz`, once a shape probe has confirmed every non-null
 * value parses unambiguously.
 */
export function renderTimestamptzColumnConversion(
  tableName: string,
  columnName: string,
  options: { hasDefault?: boolean } = {},
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
  return statements;
}

/**
 * Render the one-time PostgreSQL conversion of a legacy `text` column to
 * native `jsonb`, once a shape probe has confirmed every non-null value is
 * JSON-shaped.
 */
export function renderJsonbColumnConversion(
  tableName: string,
  columnName: string,
  options: { hasDefault?: boolean } = {},
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
  return statements;
}
