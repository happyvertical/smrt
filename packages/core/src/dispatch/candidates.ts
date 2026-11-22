/**
 * Pending-candidate query for `DispatchBus.process()` (internal).
 *
 * Selects, oldest first, the pending rows routed to one subscriber, with the
 * routing predicate (`dispatch/routing.ts`), the compiled subscription
 * patterns (`dispatch/pattern.ts`), the optional `signalTypes` filter and the
 * tenant predicate all applied in SQL BEFORE the page limit, so an eligible
 * row is never hidden behind newer or non-matching rows.
 *
 * Pages are keyset-paged and come in two phases:
 *
 * 1. `undated`: `status = 'pending' AND created_at IS NULL`, ordered by id
 *    (pre-default legacy rows, taken as the oldest);
 * 2. `dated`: `status = 'pending' AND created_at IS NOT NULL`, ordered by
 *    `(created_at, id)`.
 *
 * The cursor compares the same expressions the query orders by, so any
 * non-NULL text id pages exactly once (identical timestamps and arbitrary
 * caller ids included) and a value JavaScript cannot parse never stops the
 * cursor. The id is always compared as `CAST(id AS TEXT)`. `created_at` is
 * ordered and compared by instant on every engine:
 *
 * - PostgreSQL (and PGlite): the native column. `CAST(timestamptz AS TEXT)`
 *   renders in the session `TimeZone`, which is not chronological across a
 *   DST fall-back hour, so the text form is never the sort key there. The
 *   cursor value is that text rendering (it carries its UTC offset and full
 *   precision) and is compared against the native column, which reads it
 *   back as the same instant.
 * - SQLite and DuckDB: `CAST(created_at AS TEXT)`. SQLite stores the ISO
 *   UTC string the bus writes; DuckDB's `TIMESTAMP` has no zone. Comparing
 *   the text keeps a SQLite value JavaScript cannot parse from stopping the
 *   cursor.
 *
 * Ordering by the text form means no index serves the sort on SQLite and
 * DuckDB; the `status` index narrows the scan to pending rows. A dedicated
 * `(status, created_at, id)` index belongs to the lease schema change.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { pushTenantPredicate } from './collections/Dispatches.js';
import { Dispatch, type DispatchData } from './models/Dispatch.js';
import type { DispatchSubscription } from './models/DispatchSubscription.js';
import { type DispatchPatternDialect, dispatchPatternSql } from './pattern.js';
import type { DispatchTenantScope } from './tenant-resolver.js';

/** Candidate phases, in the order `process()` reads them. */
export type PendingCandidatePhase = 'undated' | 'dated';

export const PENDING_CANDIDATE_PHASES: readonly PendingCandidatePhase[] = [
  'undated',
  'dated',
];

/** Keyset position after the last row read in a phase. */
export interface PendingCandidateCursor {
  createdAt: string | null;
  id: string;
}

/** Column aliases carrying each row's cursor values. */
export const CURSOR_CREATED_COLUMN = 'smrt_cursor_created';
export const CURSOR_ID_COLUMN = 'smrt_cursor_id';

export interface PendingCandidateQuery {
  dialect: DispatchPatternDialect;
  /**
   * Order and page `created_at` on the native column (PostgreSQL and
   * PGlite, where the text form depends on the session time zone) instead
   * of its text form.
   */
  nativeCreatedAt: boolean;
  subscriber: string;
  /** The subscriber's enabled subscriptions for the active scope. */
  subscriptions: readonly DispatchSubscription[];
  /** Optional exact signal-type filter (`process({ signalTypes })`). */
  signalTypes?: readonly string[];
  tenantScope?: DispatchTenantScope;
  phase: PendingCandidatePhase;
  cursor?: PendingCandidateCursor;
  pageSize: number;
}

/** Read the cursor of a candidate row. */
export function candidateCursor(
  row: Record<string, unknown>,
): PendingCandidateCursor {
  const created = row[CURSOR_CREATED_COLUMN];
  return {
    createdAt: created == null ? null : String(created),
    id: String(row[CURSOR_ID_COLUMN]),
  };
}

/**
 * Hydrate a candidate row, or `null` when the bus cannot read it (a column
 * that fails to parse, such as a timestamp JavaScript cannot interpret or a
 * non-integer attempt count). Such a row is skipped, never claimed.
 */
export function hydrateCandidate(
  row: Record<string, unknown>,
): Dispatch | null {
  try {
    const dispatch = Dispatch.fromRow(row as unknown as DispatchData);
    if (Number.isNaN(dispatch.createdAt.getTime())) return null;
    if (dispatch.processedAt && Number.isNaN(dispatch.processedAt.getTime())) {
      return null;
    }
    return dispatch;
  } catch {
    return null;
  }
}

/**
 * Read one page of pending candidates. Returns raw rows (with the cursor
 * aliases); the caller hydrates and isolates malformed rows.
 */
export async function readPendingCandidatePage(
  db: DatabaseInterface,
  query: PendingCandidateQuery,
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // Conditions are appended in the order their values are bound: SQLite
  // allocates `$n` slots by first occurrence in the statement text.
  const route = routingPredicateSql(query, bind);
  if (route === null) return [];

  const createdText = 'CAST(created_at AS TEXT)';
  // One sort key for ORDER BY and the cursor comparison.
  const createdKey = query.nativeCreatedAt ? 'created_at' : createdText;
  const idText = 'CAST(id AS TEXT)';
  const conditions: string[] = ["status = 'pending'", 'id IS NOT NULL', route];

  if (query.phase === 'undated') {
    conditions.push('created_at IS NULL');
    if (query.cursor) conditions.push(`${idText} > ${bind(query.cursor.id)}`);
  } else {
    conditions.push('created_at IS NOT NULL');
    if (query.cursor && query.cursor.createdAt !== null) {
      // Each placeholder used once, in text order (positional adapters).
      const after = bind(query.cursor.createdAt);
      const same = bind(query.cursor.createdAt);
      const id = bind(query.cursor.id);
      conditions.push(
        `(${createdKey} > ${after} OR (${createdKey} = ${same} AND ${idText} > ${id}))`,
      );
    }
  }

  if (query.signalTypes && query.signalTypes.length > 0) {
    conditions.push(`type IN (${query.signalTypes.map(bind).join(', ')})`);
  }

  pushTenantPredicate(
    conditions,
    params,
    query.tenantScope,
    `$${params.length + 1}`,
  );

  const order = query.phase === 'undated' ? idText : `${createdKey}, ${idText}`;
  const sql = `SELECT *, ${createdText} AS ${CURSOR_CREATED_COLUMN}, ${idText} AS ${CURSOR_ID_COLUMN}
     FROM _smrt_dispatch
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${order}
     LIMIT ${bind(query.pageSize)}`;

  const result = await db.query(sql, ...params);
  return (result.rows ?? []) as Record<string, unknown>[];
}

/**
 * SQL form of the routing predicate (`dispatch/routing.ts`): a row targeted at
 * the subscriber needs any matching subscription; a NULL-target row needs a
 * matching compete subscription. `null` when no subscription can route
 * anything.
 */
function routingPredicateSql(
  query: PendingCandidateQuery,
  bind: (value: unknown) => string,
): string | null {
  const enabled = query.subscriptions.filter((sub) => sub.enabled);
  if (enabled.length === 0) return null;

  // Placeholders are bound in the order they appear in the statement text.
  const target = bind(query.subscriber);
  const anyMatch = enabled
    .map((sub) =>
      dispatchPatternSql(sub.signalType, query.dialect, 'type', bind),
    )
    .join(' OR ');
  const branches = [`(target_subscriber = ${target} AND (${anyMatch}))`];

  const compete = enabled.filter((sub) => sub.delivery === 'compete');
  if (compete.length > 0) {
    const competeMatch = compete
      .map((sub) =>
        dispatchPatternSql(sub.signalType, query.dialect, 'type', bind),
      )
      .join(' OR ');
    branches.push(`(target_subscriber IS NULL AND (${competeMatch}))`);
  }

  return `(${branches.join(' OR ')})`;
}
