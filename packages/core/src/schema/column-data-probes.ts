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
 * SQL predicate: a quoted column holds a non-null, non-empty value. Shared
 * by every probe below (single-table batch, single-column fallback, and
 * `migrations/differ.ts`'s cross-table batch, #2878) so the emptiness rule
 * can never drift between them the way #2874's regression drifted between
 * `differ.ts` and `live-parity.ts` before this module existed.
 */
export function nonEmptyValuePredicate(quotedColumn: string): string {
  return `${quotedColumn} IS NOT NULL AND CAST(${quotedColumn} AS TEXT) <> ''`;
}

/**
 * SQL predicate: a quoted column's value does *not* look UUID-shaped
 * ({@link CANONICAL_UUID_PATTERN}), engine-aware (PostgreSQL regex vs.
 * SQLite `GLOB`). Shared for the same reason as {@link nonEmptyValuePredicate}.
 */
export function uuidInvalidShapePredicate(
  engine: DatabaseEngine,
  quotedColumn: string,
): string {
  return engine === 'postgres'
    ? `CAST(${quotedColumn} AS TEXT) !~* '${CANONICAL_UUID_PATTERN}'`
    : `NOT (LENGTH(CAST(${quotedColumn} AS TEXT)) = 36 ` +
        `AND LOWER(CAST(${quotedColumn} AS TEXT)) GLOB '${CANONICAL_UUID_SQLITE_GLOB_PATTERN}')`;
}

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
      `(SELECT 1 FROM ${quotedTable} WHERE ${nonEmptyValuePredicate(quotedColumn)} ` +
      `LIMIT 1) AS c${index}`
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
      `WHERE ${nonEmptyValuePredicate(quotedColumn)} LIMIT 1`,
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
    return (
      `(SELECT 1 FROM ${quotedTable} WHERE ${nonEmptyValuePredicate(quotedColumn)} ` +
      `AND ${uuidInvalidShapePredicate(engine, quotedColumn)} LIMIT 1) AS c${index}`
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
  const result = await db.query(
    `SELECT 1 AS invalid FROM ${quotedTable} ` +
      `WHERE ${nonEmptyValuePredicate(quotedColumn)} ` +
      `AND ${uuidInvalidShapePredicate(engine, quotedColumn)} LIMIT 1`,
  );
  return (result?.rows?.length ?? 0) === 0;
}

/**
 * One rename-data-pending candidate pairing: `targetName` (a declared
 * column confirmed empty) might have had its data left behind in
 * `sourceName` (an undeclared, populated, type-compatible column).
 * `requiresShapeCheck` marks a UUID-cast pairing whose source still needs
 * {@link columnsAllValuesUuidShapedBatch} before it can be trusted.
 * `extra` carries whatever caller-specific payload (e.g. differ.ts's
 * `isUuidCast` repair-SQL flag) needs to travel with a surviving candidate.
 */
export interface RenameDataPendingCandidate<Extra = undefined> {
  targetName: string;
  sourceName: string;
  requiresShapeCheck: boolean;
  extra: Extra;
}

/**
 * Group rename-data-pending candidates by declared target column and
 * resolve inference ambiguity (#2911: false positives that both blocked
 * production deploys through `db:status:assert` and, worse, recommended
 * copying data into the wrong column). Shared by every
 * `detectRenameDataPending()` copy — `migrations/differ.ts`'s single-table
 * and cross-table-batched variants, and `schema/live-parity.ts`'s — so this
 * inference rule can never drift between them the way the #2874 regression
 * drifted before column-data-probes.ts existed (#2878).
 *
 * "Ambiguity must suppress a finding, never multiply it" (#2911) covers two
 * independent shapes:
 *
 *  - **Multiple sources, one target.** More than one undeclared column is a
 *    compatible, populated candidate for the *same* target: which one is
 *    the real rename origin cannot be inferred. This was already handled
 *    pre-#2911 by emitting an ambiguous, no-suggested-SQL advisory instead
 *    of guessing — preserved here as a returned list with more than one
 *    entry. Two targets that each independently have several qualifying
 *    sources — even the *same* several sources — each still get their own
 *    ambiguous finding: every individual finding already discloses that it
 *    could not pick a source, so this shape does not need the extra
 *    cross-target check below.
 *  - **One source, multiple targets (#2911's actual bug).** A source column
 *    that would otherwise be the single, *unambiguous* match for a target
 *    is simultaneously the single, unambiguous match for one or more
 *    *other* targets too — e.g. `tenants.timezone` alone nominated as the
 *    rename source for `hierarchy_path`, `repo_template`, and `github_org`
 *    simultaneously. A single column cannot be the renamed predecessor of
 *    three unrelated columns at once, so a source this heuristic was about
 *    to trust as one target's sole candidate is disqualified the moment it
 *    is also some other target's sole candidate — every one of those
 *    targets is dropped from the result entirely, rather than emitting a
 *    wrong recommendation for each. This check applies only to
 *    would-be-unambiguous (single-candidate) targets: it must not reach
 *    into an already-ambiguous target's candidate list, or two targets that
 *    happen to share the same *pair* of ambiguous candidates (a
 *    plausible, unrelated coincidence — see the batched-probe-fallback
 *    regression in `migrations/__tests__/differ.test.ts`) would wrongly
 *    lose their otherwise-correct ambiguous findings too.
 *
 * A target absent from the returned map produced no surviving, trustworthy
 * candidate — emit nothing for it. A target present with exactly one
 * candidate is an unambiguous match; more than one is the first
 * (multiple-sources) ambiguity shape above.
 */
export function resolveRenameDataPendingCandidates<Extra = undefined>(
  candidates: RenameDataPendingCandidate<Extra>[],
  isShaped: (sourceName: string) => boolean,
): Map<string, { sourceName: string; extra: Extra }[]> {
  const survivors = candidates.filter(
    (candidate) =>
      !candidate.requiresShapeCheck || isShaped(candidate.sourceName),
  );

  const byTarget = new Map<string, { sourceName: string; extra: Extra }[]>();
  for (const candidate of survivors) {
    const list = byTarget.get(candidate.targetName) ?? [];
    list.push({ sourceName: candidate.sourceName, extra: candidate.extra });
    byTarget.set(candidate.targetName, list);
  }

  // One source, multiple targets (#2911): among targets that would
  // otherwise resolve to exactly one candidate, count how many distinct
  // targets each such sole source was the sole candidate for.
  const soleTargetsBySource = new Map<string, Set<string>>();
  for (const [targetName, list] of byTarget) {
    if (list.length !== 1) continue;
    const sourceName = list[0].sourceName;
    const set = soleTargetsBySource.get(sourceName) ?? new Set<string>();
    set.add(targetName);
    soleTargetsBySource.set(sourceName, set);
  }

  const resolved = new Map<string, { sourceName: string; extra: Extra }[]>();
  for (const [targetName, list] of byTarget) {
    if (list.length === 1) {
      const isSharedSoleSource =
        (soleTargetsBySource.get(list[0].sourceName)?.size ?? 0) > 1;
      if (isSharedSoleSource) continue;
    }
    resolved.set(targetName, list);
  }
  return resolved;
}
