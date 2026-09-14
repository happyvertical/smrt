/**
 * Shared live-data column probes (#2874, consolidated for #2878).
 *
 * `detectRenameDataPending()` exists in both `migrations/differ.ts` and
 * `schema/live-parity.ts` — tracked as its own maintenance hazard by #2878,
 * since the #2874 regression had to be fixed twice, in lockstep, in #2876
 * (once per copy). Until now the two batched live-data probes that function
 * depends on were duplicated right along with it: does a named column hold
 * any non-empty value, and does every non-empty value in a named column
 * look UUID-shaped? Both copies used the exact same shape —
 * uncorrelated scalar subqueries, one per column, each with its own
 * `LIMIT 1` early exit (#2874 review finding F1: never an aggregate over
 * the whole table, which would force a full scan per probed column even
 * when the very first row already answers it), and the same positional
 * `c<index>` aliasing to sidestep PostgreSQL's 63-byte identifier
 * truncation (#2874 review finding F2'). Extracted here so the two call
 * sites can never drift out of lockstep again.
 *
 * Both functions fall back to isolated per-column probing when the batched
 * statement itself fails, so one bad column (dropped concurrently, a `CAST`
 * the engine rejects) withholds only that column's result rather than the
 * whole table's (#2874 review finding F2). A column absent from the
 * returned map means "could not be probed" — callers apply their own
 * fail-closed default, not this module.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import type { DatabaseEngine } from './ddl/types.js';
import {
  CANONICAL_UUID_PATTERN,
  CANONICAL_UUID_SQLITE_GLOB_PATTERN,
} from './foreign-key-ddl.js';
import { quoteIdentifier } from './sql-identifiers.js';

/**
 * Live-data probe, batched across every column named: does each hold any
 * non-null, non-empty value? One round trip regardless of column count,
 * one row of uncorrelated scalar subqueries,
 * `(SELECT 1 FROM t WHERE ... LIMIT 1) AS c<N>`, portable across PostgreSQL
 * and SQLite.
 */
export async function columnsHaveNonEmptyValueBatch(
  db: DatabaseInterface,
  table: string,
  columns: string[],
): Promise<Map<string, boolean>> {
  if (columns.length === 0) return new Map();
  try {
    return await columnsHaveNonEmptyValueBatchQuery(db, table, columns);
  } catch {
    const hasData = new Map<string, boolean>();
    for (const column of columns) {
      try {
        hasData.set(
          column,
          await columnHasNonEmptyValueSingle(db, table, column),
        );
      } catch {
        // Left absent: the caller's own default applies (#2874 review F2).
      }
    }
    return hasData;
  }
}

async function columnsHaveNonEmptyValueBatchQuery(
  db: DatabaseInterface,
  table: string,
  columns: string[],
): Promise<Map<string, boolean>> {
  const quotedTable = quoteIdentifier(table);
  // Positional aliases (`c0`, `c1`, …), not the column name (#2874 review
  // finding F2'): PostgreSQL silently truncates a `name` identifier —
  // including a quoted alias — to 63 bytes, so a long column name, or two
  // columns sharing their first 63 bytes, would collide on the same output
  // key and mis-key a result. Positional aliases are immune to identifier
  // length and never collide with each other.
  const selects = columns.map((column, index) => {
    const quotedColumn = quoteIdentifier(column);
    return (
      `(SELECT 1 FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL ` +
      `AND CAST(${quotedColumn} AS TEXT) <> '' LIMIT 1) AS c${index}`
    );
  });
  const result = await db.query(`SELECT ${selects.join(', ')}`);
  const row = (result?.rows?.[0] ?? {}) as Record<string, unknown>;
  const hasData = new Map<string, boolean>();
  columns.forEach((column, index) => {
    hasData.set(column, row[`c${index}`] != null);
  });
  return hasData;
}

/** Single-column fallback for {@link columnsHaveNonEmptyValueBatch}. */
async function columnHasNonEmptyValueSingle(
  db: DatabaseInterface,
  table: string,
  column: string,
): Promise<boolean> {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const result = await db.query(
    `SELECT 1 AS present FROM ${quotedTable} ` +
      `WHERE ${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> '' LIMIT 1`,
  );
  return (result?.rows?.length ?? 0) > 0;
}

/**
 * Live-data probe, batched across every column named: are all of a
 * column's non-empty values UUID-shaped ({@link CANONICAL_UUID_PATTERN})?
 * One round trip regardless of column count, mirroring
 * {@link columnsHaveNonEmptyValueBatch}: a value is absent from the result
 * exactly when no invalid row exists, so this also short-circuits on the
 * first invalid row rather than counting every one. PostgreSQL pushes the
 * shape check into its regex operator; SQLite has no regex operator, but
 * its case-sensitive `GLOB` can still express the fixed 36-character
 * canonical shape ({@link CANONICAL_UUID_SQLITE_GLOB_PATTERN} against
 * `LOWER(...)`, guarded by an exact `LENGTH(...) = 36` check).
 */
export async function columnsAllValuesUuidShapedBatch(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
  columns: string[],
): Promise<Map<string, boolean>> {
  if (columns.length === 0) return new Map();
  try {
    return await columnsAllValuesUuidShapedBatchQuery(
      db,
      engine,
      table,
      columns,
    );
  } catch {
    const shaped = new Map<string, boolean>();
    for (const column of columns) {
      try {
        shaped.set(
          column,
          await allNonEmptyValuesUuidShapedSingle(db, engine, table, column),
        );
      } catch {
        // Left absent: the caller's own default applies (#2874 review F2).
      }
    }
    return shaped;
  }
}

async function columnsAllValuesUuidShapedBatchQuery(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
  columns: string[],
): Promise<Map<string, boolean>> {
  const quotedTable = quoteIdentifier(table);
  // Positional aliases, not the column name (#2874 review finding F2') —
  // see {@link columnsHaveNonEmptyValueBatchQuery}.
  const selects = columns.map((column, index) => {
    const quotedColumn = quoteIdentifier(column);
    const nonEmptyPredicate = `${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> ''`;
    const invalidPredicate =
      engine === 'postgres'
        ? `CAST(${quotedColumn} AS TEXT) !~* '${CANONICAL_UUID_PATTERN}'`
        : `NOT (LENGTH(CAST(${quotedColumn} AS TEXT)) = 36 ` +
          `AND LOWER(CAST(${quotedColumn} AS TEXT)) GLOB '${CANONICAL_UUID_SQLITE_GLOB_PATTERN}')`;
    return (
      `(SELECT 1 FROM ${quotedTable} WHERE ${nonEmptyPredicate} ` +
      `AND ${invalidPredicate} LIMIT 1) AS c${index}`
    );
  });
  const result = await db.query(`SELECT ${selects.join(', ')}`);
  const row = (result?.rows?.[0] ?? {}) as Record<string, unknown>;
  const shaped = new Map<string, boolean>();
  columns.forEach((column, index) => {
    shaped.set(column, row[`c${index}`] == null);
  });
  return shaped;
}

/** Single-column fallback for {@link columnsAllValuesUuidShapedBatch}. */
async function allNonEmptyValuesUuidShapedSingle(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
  column: string,
): Promise<boolean> {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const nonEmptyPredicate = `${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> ''`;
  const invalidPredicate =
    engine === 'postgres'
      ? `CAST(${quotedColumn} AS TEXT) !~* '${CANONICAL_UUID_PATTERN}'`
      : `NOT (LENGTH(CAST(${quotedColumn} AS TEXT)) = 36 ` +
        `AND LOWER(CAST(${quotedColumn} AS TEXT)) GLOB '${CANONICAL_UUID_SQLITE_GLOB_PATTERN}')`;
  const result = await db.query(
    `SELECT 1 AS invalid FROM ${quotedTable} ` +
      `WHERE ${nonEmptyPredicate} AND ${invalidPredicate} LIMIT 1`,
  );
  return (result?.rows?.length ?? 0) === 0;
}
