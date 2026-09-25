/**
 * Change-feed table/row authorization seam (issue #3020).
 *
 * The generated `_changes`/`_events` routes authorize on "an authenticated
 * principal" plus tenant scope (`getTenantScopedChangesSince`,
 * `resolveDispatchTenantScope`) — see `change-feed-sensitivity.ts`'s scope
 * note. That is enough to keep one tenant from seeing another's rows, but it
 * cannot express "table X is readable by some principals of the tenant but
 * not others" or "principal P only sees their own rows of table X" (a
 * bay-tablet station versus the back office). `?tables=` was a client-chosen
 * filter, never enforcement: a table the client did not ask for was withheld
 * only because it did not ask, not because it could not have.
 *
 * This module is the consumer-supplied seam that closes that gap, evaluated
 * identically by both routes so the pull (`_changes`) and push (`_events`)
 * halves of the sync contract cannot diverge. Two independent hooks,
 * dependency-inverted onto `globalThis` exactly like
 * {@link resolveDispatchTenantScope} (`dispatch/tenant-resolver.ts`) so a
 * consumer app registers them once — wherever it already calls
 * `enableTenancy()`, or its `hooks.server.ts` — with **no change to the
 * generated "DO NOT EDIT" route files' imports**:
 *
 * - `authorizeChangeFeed({ locals, tables }) => allowedTables` — table-level.
 *   Its result is INTERSECTED with the client's `?tables=` filter (never
 *   unioned): a table the hook does not name is never queried, let alone
 *   returned, regardless of what the client asked for.
 * - `isChangeFeedEntryVisible({ locals, entry }) => boolean` — row-level, for
 *   scope narrower than a whole table (a station sees only its own rows).
 *   Applied per entry, after the table-level filter, before anything is
 *   serialized to the client — including a live `_events` signal, which never
 *   carries a payload but still carries the row id and write timing the row
 *   hook exists to withhold.
 *
 * Both hooks are optional and independent. When neither is registered, both
 * routes behave exactly as before (#1540 posture — authenticated + tenant
 * scoped only, no per-table or per-row check): every call in this module is a
 * synchronous no-op pass-through until a consumer opts in.
 *
 * ## Fail-closed
 *
 * A hook that throws, or returns something other than the documented shape,
 * is treated as authorizing nothing for that call — the same posture
 * {@link resolveDispatchTenantScope} takes for a throwing tenant resolver
 * (fail closed rather than fail the request), and the same *shape* of answer
 * (200, empty `changes`, cursor still advances) the change-feed sensitivity
 * filter (#2937) already gives a request naming only tables it may not see.
 * A 5xx here would tell a caller its own hook is broken, which is
 * indistinguishable from "your hook denied me" from the caller's side and
 * would leak that distinction; the contract that matters — never an
 * unfiltered feed — holds identically either way.
 *
 * ## Cursor correctness
 *
 * Every filter here narrows the *returned* `changes` array; nothing here ever
 * touches `cursor`/`resyncRequired`/`resyncCursor`. This mirrors #2937's
 * sensitivity filter (`change-feed.ts`, "Filters ... affect which rows are
 * returned, never how the cursor advances") and for the same reason: a
 * client must advance past a denied entry without re-polling it forever, and
 * the entry's row id/timing must never be inferable from a cursor that stalls
 * on it. Table denial is implemented by asking the underlying read for a
 * table name that cannot exist ({@link DENY_ALL_TABLES_SENTINEL}) rather than
 * an empty list — `getChangesSince` treats an omitted/empty `tables` as "no
 * filter", so an empty array would (perversely) widen the read to everything.
 * A guaranteed-no-match name instead takes the ordinary `table_name IN (...)`
 * path — the same one an authorized request for a subset of real tables
 * takes, and the same one already exercised by a client naming a table that
 * happens not to exist, which `getChangesSince` has never validated — so the
 * real horizon computation runs and the cursor still advances correctly; it
 * just matches zero rows.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type ChangeFeedPage,
  type GetChangesOptions,
  getChangesSince,
  getTenantScopedChangesSince,
} from './change-feed.js';

const logger = createLogger({ level: 'info' });

/**
 * Minimal shape shared by a durable {@link ChangeFeedEntry} (`change-feed.ts`)
 * and a live `ChangeSignal` (`change-signals.ts`) — both carry exactly
 * table/row/operation/tenant/seq and nothing else observable, so one
 * visibility hook covers catch-up entries and live signals alike.
 */
export interface ChangeFeedVisibilityEntry {
  table: string;
  rowId: string | null;
  operation: string;
  tenantId: string | null;
  seq: number;
}

/** Input to the table-level {@link ChangeFeedTableAuthorizer} hook. */
export interface ChangeFeedTableAuthorizationRequest {
  /** SvelteKit `locals` for the requesting connection/request. */
  locals: unknown;
  /**
   * The client's `?tables=` filter, or `undefined` when it named none (the
   * unrestricted default). On `_events`, which has no `?tables=` param, this
   * is always `undefined` — the hook's answer alone bounds what the
   * connection may ever see.
   */
  tables: string[] | undefined;
}

/**
 * Table-level change-feed authorization hook (#3020). Returns the tables
 * `locals` may read from the feed at all; a table it does not name is denied
 * regardless of the client's own `?tables=` filter. Register with
 * {@link setChangeFeedAuthorizer}.
 */
export type ChangeFeedTableAuthorizer = (
  request: ChangeFeedTableAuthorizationRequest,
) => string[] | Promise<string[]>;

/** Input to the row-level {@link ChangeFeedEntryVisibility} hook. */
export interface ChangeFeedEntryVisibilityRequest {
  locals: unknown;
  entry: ChangeFeedVisibilityEntry;
}

/**
 * Row-level change-feed visibility hook (#3020), for scope narrower than a
 * whole table (a station sees only its own rows). Register with
 * {@link setChangeFeedEntryVisibility}.
 */
export type ChangeFeedEntryVisibility = (
  request: ChangeFeedEntryVisibilityRequest,
) => boolean | Promise<boolean>;

declare global {
  // eslint-disable-next-line no-var
  var __smrtChangeFeedTableAuthorizer: ChangeFeedTableAuthorizer | undefined;
  // eslint-disable-next-line no-var
  var __smrtChangeFeedEntryVisibility: ChangeFeedEntryVisibility | undefined;
}

/**
 * Register the table-level change-feed authorization hook used by both
 * generated routes. `undefined` clears it, restoring the pre-#3020 default
 * (tenant-scoped only, no per-table check).
 */
export function setChangeFeedAuthorizer(
  authorizeChangeFeed: ChangeFeedTableAuthorizer | undefined,
): void {
  globalThis.__smrtChangeFeedTableAuthorizer = authorizeChangeFeed;
}

/**
 * Register the row-level change-feed visibility hook used by both generated
 * routes. `undefined` clears it (every table-authorized row is visible).
 */
export function setChangeFeedEntryVisibility(
  isChangeFeedEntryVisible: ChangeFeedEntryVisibility | undefined,
): void {
  globalThis.__smrtChangeFeedEntryVisibility = isChangeFeedEntryVisible;
}

/** Whether a table authorizer is currently registered. */
export function hasChangeFeedTableAuthorizerHook(): boolean {
  return globalThis.__smrtChangeFeedTableAuthorizer !== undefined;
}

/** Whether a row visibility hook is currently registered. */
export function hasChangeFeedEntryVisibilityHook(): boolean {
  return globalThis.__smrtChangeFeedEntryVisibility !== undefined;
}

/**
 * A table name that cannot collide with a real one (SQL identifiers cannot
 * carry a NUL byte). See the module docs' "Cursor correctness" section for
 * why denial is expressed this way instead of an empty `tables` array.
 */
const DENY_ALL_TABLES_SENTINEL = ['\u0000__smrt_change_feed_denied__'];

/**
 * Translate a resolved allow-list into a `getChangesSince`-ready `tables`
 * filter: `undefined` (no hook registered — unchanged default) passes
 * through, and an explicit empty allow-list becomes
 * {@link DENY_ALL_TABLES_SENTINEL} so the read is denied rather than widened.
 */
export function toChangeFeedTablesFilter(
  tables: string[] | undefined,
): string[] | undefined {
  return tables !== undefined && tables.length === 0
    ? DENY_ALL_TABLES_SENTINEL
    : tables;
}

/**
 * Resolve the tables a request may read from the feed: the registered
 * {@link ChangeFeedTableAuthorizer}'s answer intersected with the client's
 * own `?tables=` filter (never widened by it). Returns `requestedTables`
 * unchanged, including `undefined`, when no hook is registered — the
 * unmodified default behavior.
 *
 * Once a hook is registered, the result is always an explicit array (possibly
 * empty): a throwing or malformed hook fails closed to `[]` (logged, never
 * surfaced as a 5xx — see module docs).
 */
export async function resolveAuthorizedChangeFeedTables(
  locals: unknown,
  requestedTables: string[] | undefined,
): Promise<string[] | undefined> {
  const authorizer = globalThis.__smrtChangeFeedTableAuthorizer;
  if (!authorizer) return requestedTables;

  let allowed: string[];
  try {
    const result = await authorizer({ locals, tables: requestedTables });
    if (!Array.isArray(result) || result.some((t) => typeof t !== 'string')) {
      logger.error(
        'authorizeChangeFeed() returned a non-string-array result; failing closed to no tables',
      );
      return [];
    }
    allowed = result;
  } catch (error) {
    logger.error('authorizeChangeFeed() threw; failing closed to no tables', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  if (!requestedTables || requestedTables.length === 0) return allowed;
  const allowedSet = new Set(allowed);
  return requestedTables.filter((table) => allowedSet.has(table));
}

/**
 * Whether `entry` is visible to `locals` under the registered
 * {@link ChangeFeedEntryVisibility} hook. `true` (visible) when no hook is
 * registered — the unmodified default. A throwing or non-boolean hook fails
 * closed to `false` (hidden), never falls back to visible.
 */
export async function isChangeFeedEntryVisible(
  locals: unknown,
  entry: ChangeFeedVisibilityEntry,
): Promise<boolean> {
  const predicate = globalThis.__smrtChangeFeedEntryVisibility;
  if (!predicate) return true;
  try {
    return (await predicate({ locals, entry })) === true;
  } catch (error) {
    logger.error('isChangeFeedEntryVisible() threw; failing closed to hidden', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * {@link isChangeFeedEntryVisible}, applied to a page of entries in order.
 * Returns `entries` unchanged (same array reference) when no hook is
 * registered.
 */
export async function filterVisibleChangeFeedEntries<
  T extends ChangeFeedVisibilityEntry,
>(locals: unknown, entries: readonly T[]): Promise<T[]> {
  if (entries.length === 0 || !globalThis.__smrtChangeFeedEntryVisibility) {
    return entries as T[];
  }
  const visible: T[] = [];
  for (const entry of entries) {
    if (await isChangeFeedEntryVisible(locals, entry)) visible.push(entry);
  }
  return visible;
}

interface AuthorizedChangesInput extends Omit<GetChangesOptions, 'tables'> {
  tables?: string[];
  locals: unknown;
}

/** Shared implementation behind {@link getAuthorizedChangesSince} and {@link getAuthorizedTenantScopedChangesSince}. */
async function readAuthorized(
  locals: unknown,
  requestedTables: string[] | undefined,
  read: (tables: string[] | undefined) => Promise<ChangeFeedPage>,
): Promise<ChangeFeedPage> {
  const effectiveTables = await resolveAuthorizedChangeFeedTables(
    locals,
    requestedTables,
  );
  const page = await read(toChangeFeedTablesFilter(effectiveTables));
  if (page.changes.length === 0) return page;
  const visibleChanges = await filterVisibleChangeFeedEntries(
    locals,
    page.changes,
  );
  return visibleChanges.length === page.changes.length
    ? page
    : { ...page, changes: visibleChanges };
}

/**
 * {@link getChangesSince}, additionally applying the registered table and
 * row-level authorization hooks (#3020). Used where the tenant filter (if
 * any) is resolved by the caller rather than the active DispatchBus context —
 * the `_events` catch-up replay, which captures its tenant scope once at
 * connection open.
 */
export async function getAuthorizedChangesSince(
  db: DatabaseInterface,
  options: AuthorizedChangesInput,
): Promise<ChangeFeedPage> {
  const { locals, tables, ...rest } = options;
  return readAuthorized(locals, tables, (effectiveTables) =>
    getChangesSince(db, { ...rest, tables: effectiveTables }),
  );
}

/**
 * {@link getTenantScopedChangesSince}, additionally applying the registered
 * table and row-level authorization hooks (#3020). This is what the
 * generated `_changes` route calls.
 *
 * Table authorization narrows `tables` BEFORE the query runs (a denied table
 * is never queried, let alone returned); row visibility filters the fetched
 * page's `changes` AFTER. Neither touches `cursor`/`resyncRequired`/
 * `resyncCursor` — see the module docs' "Cursor correctness" section.
 */
export async function getAuthorizedTenantScopedChangesSince(
  db: DatabaseInterface,
  options: Omit<AuthorizedChangesInput, 'tenantId'>,
): Promise<ChangeFeedPage> {
  const { locals, tables, ...rest } = options;
  return readAuthorized(locals, tables, (effectiveTables) =>
    getTenantScopedChangesSince(db, { ...rest, tables: effectiveTables }),
  );
}
