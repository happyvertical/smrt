/**
 * Candidate query for `DispatchBus.process()` (internal).
 *
 * Selects, oldest first, the claimable rows routed to one subscriber, with
 * the routing predicate (`dispatch/routing.ts`), the compiled subscription
 * patterns (`dispatch/pattern.ts`), the optional `signalTypes` filter, the
 * claim budget and the tenant predicate all applied in SQL BEFORE the page
 * limit, so an eligible row is never hidden behind newer, non-matching or
 * spent rows.
 *
 * Pages are keyset-paged and come in phases, read in this order:
 *
 * 1. `expired`: `status = 'processing' AND claimed_until IS NOT NULL AND
 *    claimed_until < <call start>`, ordered by `(claimed_until, id)`: leases
 *    whose holder stopped renewing before this call began;
 * 2. `undated`: `status = 'pending' AND created_at IS NULL`, ordered by id
 *    (pre-default legacy rows, taken as the oldest);
 * 3. `dated`: `status = 'pending' AND created_at IS NOT NULL`, ordered by
 *    `(created_at, id)`.
 *
 * The call start is read once per `process()` call, so a lease that expires
 * while the call runs (or one this call wrote) is never in its expired phase.
 *
 * The cursor compares the same expressions the query orders by, so any
 * non-NULL text id pages exactly once (identical timestamps and arbitrary
 * caller ids included) and a value JavaScript cannot parse never stops the
 * cursor. The id is always compared as `CAST(id AS TEXT)`. The phase's
 * timestamp column (`claimed_until` or `created_at`) is ordered and compared
 * by instant on every engine:
 *
 * - PostgreSQL (and PGlite): the native column. `CAST(timestamptz AS TEXT)`
 *   renders in the session `TimeZone`, which is not chronological across a
 *   DST fall-back hour, so the text form is never the sort key there. The
 *   cursor value is that text rendering (it carries its UTC offset and full
 *   precision) and is compared against the native column, which reads it
 *   back as the same instant.
 * - SQLite and DuckDB: `CAST(<column> AS TEXT)`. SQLite stores the ISO UTC
 *   string the bus writes; DuckDB's `TIMESTAMP` has no zone. Comparing the
 *   text keeps a SQLite value JavaScript cannot parse from stopping the
 *   cursor.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { pushTenantPredicate } from './collections/Dispatches.js';
import { Dispatch, type DispatchData } from './models/Dispatch.js';
import type { DispatchSubscription } from './models/DispatchSubscription.js';
import { type DispatchPatternDialect, dispatchPatternSql } from './pattern.js';
import type { DispatchTenantScope } from './tenant-resolver.js';

/** Candidate phases, in the order `process()` reads them. */
export type DispatchCandidatePhase = 'expired' | 'undated' | 'dated';

export const DISPATCH_CANDIDATE_PHASES: readonly DispatchCandidatePhase[] = [
  'expired',
  'undated',
  'dated',
];

/** Keyset position after the last row read in a phase. */
export interface DispatchCandidateCursor {
  /** Text form of the phase's sort column (`null` in the `undated` phase). */
  key: string | null;
  id: string;
}

/** Column aliases carrying each row's cursor values. */
export const CURSOR_KEY_COLUMN = 'smrt_cursor_key';
export const CURSOR_ID_COLUMN = 'smrt_cursor_id';

export interface DispatchCandidateQuery {
  dialect: DispatchPatternDialect;
  /**
   * Order and page the phase's timestamp column on the native column
   * (PostgreSQL and PGlite, where the text form depends on the session time
   * zone) instead of its text form.
   */
  nativeTimestamps: boolean;
  subscriber: string;
  /** The subscriber's enabled subscriptions for the active scope. */
  subscriptions: readonly DispatchSubscription[];
  /** Optional exact signal-type filter (`process({ signalTypes })`). */
  signalTypes?: readonly string[];
  tenantScope?: DispatchTenantScope;
  phase: DispatchCandidatePhase;
  cursor?: DispatchCandidateCursor;
  pageSize: number;
  /** Start of the `process()` call: the expired phase's upper bound. */
  callStart: Date;
  /** Claim budget: rows with `COALESCE(attempts, 0)` at or above it are not candidates. */
  maxAttempts: number;
}

/** Sort column of each phase (besides id). */
const PHASE_SORT_COLUMN: Record<DispatchCandidatePhase, string | null> = {
  expired: 'claimed_until',
  undated: null,
  dated: 'created_at',
};

/** Read the cursor of a candidate row. */
export function candidateCursor(
  row: Record<string, unknown>,
): DispatchCandidateCursor {
  const key = row[CURSOR_KEY_COLUMN];
  return {
    key: key == null ? null : String(key),
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
 * Read one page of candidates of one phase. Returns raw rows (with the
 * cursor aliases); the caller hydrates and isolates malformed rows.
 */
export async function readCandidatePage(
  db: DatabaseInterface,
  query: DispatchCandidateQuery,
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

  const sortColumn = PHASE_SORT_COLUMN[query.phase];
  const keyText = sortColumn ? `CAST(${sortColumn} AS TEXT)` : 'NULL';
  // One sort key for ORDER BY and the cursor comparison.
  const sortKey = sortColumn && query.nativeTimestamps ? sortColumn : keyText;
  const idText = 'CAST(id AS TEXT)';
  const conditions: string[] = ['id IS NOT NULL', route];

  if (query.phase === 'expired') {
    conditions.push(
      "status = 'processing'",
      'claimed_until IS NOT NULL',
      `claimed_until < ${bind(query.callStart.toISOString())}`,
    );
  } else {
    conditions.push(
      "status = 'pending'",
      query.phase === 'undated'
        ? 'created_at IS NULL'
        : 'created_at IS NOT NULL',
    );
  }
  conditions.push(`COALESCE(attempts, 0) < ${bind(query.maxAttempts)}`);

  if (query.cursor) {
    if (sortColumn === null) {
      conditions.push(`${idText} > ${bind(query.cursor.id)}`);
    } else if (query.cursor.key !== null) {
      // Each placeholder used once, in text order (positional adapters).
      const after = bind(query.cursor.key);
      const same = bind(query.cursor.key);
      const id = bind(query.cursor.id);
      conditions.push(
        `(${sortKey} > ${after} OR (${sortKey} = ${same} AND ${idText} > ${id}))`,
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

  const order = sortColumn ? `${sortKey}, ${idText}` : idText;
  const sql = `SELECT *, ${keyText} AS ${CURSOR_KEY_COLUMN}, ${idText} AS ${CURSOR_ID_COLUMN}
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
  query: DispatchCandidateQuery,
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
