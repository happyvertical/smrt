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
 * identically by **every** transport — the generated SvelteKit `_changes`/
 * `_events` routes AND the runtime REST generator's `_changes`/`_events`
 * (`generators/changes-route.ts`, `generators/events-route.ts`) — so no
 * transport can leak what another denies. Two independent hooks,
 * dependency-inverted onto `globalThis` exactly like
 * {@link resolveDispatchTenantScope} (`dispatch/tenant-resolver.ts`) so a
 * consumer app registers them once — wherever it already calls
 * `enableTenancy()`, or its `hooks.server.ts` — with **no change to the
 * generated "DO NOT EDIT" route files' imports**:
 *
 * - `authorizeChangeFeed({ locals, request, tables }) => allowedTables` —
 *   table-level. Its result is INTERSECTED with the client's `?tables=`
 *   filter (never unioned): a table the hook does not name is never queried,
 *   let alone returned, regardless of what the client asked for.
 * - `isChangeFeedEntryVisible({ locals, request, entry }) => boolean` —
 *   row-level, for scope narrower than a whole table (a station sees only its
 *   own rows). Applied per entry, after the table-level filter, before
 *   anything is serialized to the client — including a live `_events` signal,
 *   which never carries a payload but still carries the row id and write
 *   timing the row hook exists to withhold.
 *
 * ## `locals` vs. `request`
 *
 * SvelteKit routes pass both `event.locals` and `event.request`. The REST
 * generator has no `locals` concept, so it passes `locals: undefined` and the
 * `authMiddleware`-processed `Request` (whatever properties/headers the
 * middleware attached) as `request` — a REST-hosting consumer identifies the
 * principal from `request`, not `locals`. Every real caller supplies
 * `request`; it is typed optional only so a low-level unit test can omit it.
 *
 * ## Default table policy: what list/get would serve (#5446)
 *
 * With no table authorizer registered — never registered, cleared with
 * `setChangeFeedAuthorizer(undefined)`, or a non-function in the slot — the
 * feed serves a table exactly when the caller could list that table's model
 * on the same transport (`change-feed-default-authz.ts`):
 *
 * - the table belongs to a registered, served model: never a framework table
 *   (`CHANGE_FEED_EXCLUDED_TABLES`), a sensitive table, an unregistered
 *   table, or a table whose registrations are all abstract (a registered
 *   domain model on a `_smrt_`-named table is decided by its model). Each
 *   registration is first resolved to the model serving its rows (a
 *   collection to its item), then an STI subtype to its base: an STI table is
 *   decided by its base model, so a subtype is served only through its
 *   base's table, and feed entries of subtype rows the caller could not list
 *   are still served once the base passes (interim; REST list filters
 *   subtype rows per caller). A junction row model (the item of a
 *   `SmrtJunction`/`SmrtJunctionBase` collection) is served only when its
 *   own `@smrt({ api })` is declared and opens `list`. When several models
 *   decide one table, every one must pass. This internal-model rule is
 *   interim: the T-exposure work replaces it with the shared internal-model
 *   rule every transport uses;
 * - the model's API action gate opens `list` (`isApiActionEnabledForObject`:
 *   `api: false` and an `include`/`exclude` that closes `list` refuse);
 * - the runtime exposure gate admits the model for the tenant the
 *   transport's list route resolves (`isRuntimeModelEnabled`, surface
 *   `rest`): REST's `requestTenant(req).effectiveTenantId`
 *   ({@link ChangeFeedRequestContext.exposureTenantId}); SvelteKit's tenant
 *   from `locals`, then the captured or active tenant scope;
 * - on the REST transport, the model is one the server serves
 *   ({@link ChangeFeedRequestContext.servedModels}: a
 *   `createRestServer(objects)` scope, unambiguous segments, no framework
 *   base classes), and the route's own `authMiddleware(objectName, 'get')`
 *   admits the request under the object name the REST routes use, asked at
 *   most once per model per request
 *   ({@link ChangeFeedRequestContext.authMiddleware}); the SvelteKit list
 *   routes have no per-model check beyond authentication, so neither does
 *   their feed.
 *
 * Tenant scoping and the sensitive-table filter apply on top, unchanged. A
 * registered authorizer replaces this default entirely; a row hook narrows
 * whichever table answer applies. `setChangeFeedAuthorizer(allowAllChangeFeedTables)`
 * is the explicit opt-in to the behaviour before #5446 (every table, for
 * every authenticated, tenant-scoped principal). An authorizer may also return
 * {@link allowAllChangeFeedTables}'s result for some principals and a table
 * list for others.
 *
 * The all-tables answer is a `Symbol.for` value, so a second copy of core in
 * one process recognises it; the hook slot itself is on `globalThis`, so the
 * registration made through either copy governs both. The default policy
 * reads the registry of the copy that resolves the request.
 *
 * Reads that serve no principal do not pass through this module and are
 * unaffected: `getChangesSince`/`getTenantScopedChangesSince` called directly
 * (internal sync, webhooks' tenant-context poll, diagnostics), the
 * conditional-GET table versions (`getTableVersion`), and dispatch.
 *
 * ## Fail-closed
 *
 * A hook that throws or returns something other than the documented shape,
 * and a default-policy check that throws for a model, are treated as
 * authorizing nothing for that call (or that model) — the same posture
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
 * on it. Table denial is implemented via `getChangesSince`'s explicit
 * `denyAllTables` option rather than an empty `tables` array —
 * `getChangesSince` treats an omitted/empty `tables` as "no filter", so an
 * empty array would (perversely) widen the read to everything, and an
 * earlier version of this module instead passed a guaranteed-no-match
 * sentinel table name through the ordinary `table_name IN (...)` path; that
 * broke on PostgreSQL, which rejects a NUL byte in a text parameter, turning
 * a denied request into a 500 instead of the required 200 empty page. A
 * `denyAllTables` request skips the `IN (...)` clause entirely — no
 * synthesized value ever reaches the driver — while still running the same
 * horizon/pruned-cursor computation any other filter does, so the cursor
 * still advances correctly; it just matches zero rows.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type ChangeFeedPage,
  type GetChangesOptions,
  getChangesSince,
  getTenantScopedChangesSince,
} from './change-feed.js';
import { defaultChangeFeedTables } from './change-feed-default-authz.js';

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

/**
 * The requesting principal's context, common to both hooks. `locals` is
 * SvelteKit's `event.locals`, or `undefined` on the REST transport (which has
 * no `locals` concept). `request` is the SvelteKit route's `event.request`,
 * or the REST route's `authMiddleware`-processed `Request` — a
 * REST-hosting consumer identifies the principal from `request`, since
 * `locals` is never populated there. Every generated route supplies
 * `request`; it is optional only so a low-level unit test can omit it.
 */
export interface ChangeFeedRequestContext {
  locals: unknown;
  request?: Request;
  /**
   * The REST route's own `authMiddleware` (#5446). When present, the default
   * table policy serves a model's table only if
   * `authMiddleware(model, 'get')(request)` admits the request, the same
   * decision a REST `get` of that model makes. The SvelteKit routes pass none.
   * A registered authorizer receives it too and may ignore it.
   */
  authMiddleware?: ChangeFeedRouteAuthMiddleware;
  /**
   * The tenant the transport's list route resolves for this request, for the
   * default policy's runtime exposure check: REST passes its
   * `requestTenant(req).effectiveTenantId` (`resolveTenant` /
   * `APIContext.tenantId`, then the ambient tenant). When omitted, the
   * default derives it as generated SvelteKit list routes do: from `locals`
   * (`tenantId`, `user`, `session`, `tenantContext`), then
   * {@link ambientTenantId}, then the active dispatch tenant scope. Distinct
   * from a read's `tenantId` filter.
   */
  exposureTenantId?: string | null;
  /**
   * The tenant scope captured at `_events` connection open, used after
   * `locals` when {@link exposureTenantId} is omitted. Set by
   * `buildChangeEventStream`.
   */
  ambientTenantId?: string | null;
  /**
   * The models a REST server serves, as registry key → the object name its
   * routes pass to `authMiddleware` and the action gate (#5446). When set,
   * the default policy serves only tables these models decide; a
   * `createRestServer(objects)` scope, ambiguous segments, models with
   * generated-field errors and framework base classes are therefore never
   * served. The SvelteKit routes pass none.
   */
  servedModels?: ReadonlyMap<string, string>;
}

/** The REST generator's `authMiddleware` shape (`APIConfig.authMiddleware`). */
export type ChangeFeedRouteAuthMiddleware = (
  objectName: string,
  action: string,
) => (req: Request) => Promise<Request | Response>;

/** Input to the table-level {@link ChangeFeedTableAuthorizer} hook. */
export interface ChangeFeedTableAuthorizationRequest
  extends ChangeFeedRequestContext {
  /**
   * The client's `?tables=` filter, or `undefined` when it named none (the
   * unrestricted default). On `_events`, which has no `?tables=` param, this
   * is always `undefined` — the hook's answer alone bounds what the
   * connection may ever see.
   */
  tables: string[] | undefined;
}

/**
 * The "every table" answer a {@link ChangeFeedTableAuthorizer} may return.
 * `Symbol.for`, so a value produced by another copy of core is the same
 * symbol.
 */
const ALL_CHANGE_FEED_TABLES: unique symbol = Symbol.for(
  '@happyvertical/smrt-core:change-feed-all-tables',
);

/** Type of {@link allowAllChangeFeedTables}'s result: "every table". */
export type ChangeFeedAllTables = typeof ALL_CHANGE_FEED_TABLES;

/**
 * Table-level change-feed authorization hook (#3020). Returns the tables the
 * requester may read from the feed at all; a table it does not name is denied
 * regardless of the client's own `?tables=` filter. Returning
 * {@link allowAllChangeFeedTables}'s result instead grants every table (the
 * client's `?tables=` still narrows it). Register with
 * {@link setChangeFeedAuthorizer}; it replaces the default table policy
 * (#5446, see the module docs).
 */
export type ChangeFeedTableAuthorizer = (
  request: ChangeFeedTableAuthorizationRequest,
) => string[] | ChangeFeedAllTables | Promise<string[] | ChangeFeedAllTables>;

/**
 * Explicit opt-in to serving every table of the change feed to every
 * principal the route already admits (authenticated, tenant scoped, minus
 * sensitive tables) — the behaviour before the default table policy (#5446),
 * including system, unregistered and non-exposed models' tables. Register it as the authorizer
 * (`setChangeFeedAuthorizer(allowAllChangeFeedTables)`), or return its result
 * from your own authorizer for the principals that may read every table.
 */
export function allowAllChangeFeedTables(): ChangeFeedAllTables {
  return ALL_CHANGE_FEED_TABLES;
}

/** Input to the row-level {@link ChangeFeedEntryVisibility} hook. */
export interface ChangeFeedEntryVisibilityRequest
  extends ChangeFeedRequestContext {
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
 * generated routes, replacing the default table policy. `undefined` clears it
 * and restores the default (#5446, see the module docs). Pass
 * {@link allowAllChangeFeedTables} to serve every table.
 */
export function setChangeFeedAuthorizer(
  authorizeChangeFeed: ChangeFeedTableAuthorizer | undefined,
): void {
  globalThis.__smrtChangeFeedTableAuthorizer = authorizeChangeFeed;
}

/**
 * Register the row-level change-feed visibility hook used by both generated
 * routes. `undefined` clears it (every table-authorized row is visible). It
 * narrows the table answer (a registered authorizer's, or the default
 * policy's) and grants nothing on its own (#5446).
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
 * Whether a resolved allow-list means "match no tables" (an explicit empty
 * array — every table was denied, the default policy serves none, or the
 * hook's answer was unusable) as opposed to `undefined` (the authorizer
 * granted every table and the client named no filter). Callers pass this
 * through to `getChangesSince`'s
 * `denyAllTables` option rather than an empty `tables` array — see the
 * module docs' "Cursor correctness" section for why.
 */
export function isChangeFeedDenyAll(tables: string[] | undefined): boolean {
  return tables !== undefined && tables.length === 0;
}

/**
 * Whether `name` is a usable change-feed table name: a non-empty string
 * containing no NUL byte. A NUL byte is PostgreSQL's hard failure mode — it
 * rejects one outright in a text parameter — so a hook returning one would
 * otherwise reach the ordinary `table_name IN (...)` clause (built from the
 * hook's OWN answer, not a client-supplied value) and turn a legitimate
 * authorization decision into a 500 instead of the documented fail-closed
 * 200/empty contract. An empty string is equally never a real table name.
 */
function isValidChangeFeedTableName(name: string): boolean {
  return name.length > 0 && !name.includes('\u0000');
}

/** A registered authorizer's validated answer; anything unusable is `[]`. */
async function callTableAuthorizer(
  authorizer: ChangeFeedTableAuthorizer,
  ctx: ChangeFeedRequestContext,
  requestedTables: string[] | undefined,
): Promise<string[] | ChangeFeedAllTables> {
  try {
    const result = await authorizer({ ...ctx, tables: requestedTables });
    if (result === ALL_CHANGE_FEED_TABLES) return result;
    if (
      !Array.isArray(result) ||
      result.some(
        (t) => typeof t !== 'string' || !isValidChangeFeedTableName(t),
      )
    ) {
      logger.error(
        'authorizeChangeFeed() returned a non-string-array or invalid table name; failing closed to no tables',
      );
      return [];
    }
    return result;
  } catch (error) {
    logger.error('authorizeChangeFeed() threw; failing closed to no tables', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Resolve the tables a request may read from the feed: the registered
 * {@link ChangeFeedTableAuthorizer}'s answer — or, with none registered, the
 * default table policy's (#5446, see the module docs) — intersected with the
 * client's own `?tables=` filter (never widened by it).
 *
 * The result is an explicit array (possibly empty), except when the hook
 * returns {@link allowAllChangeFeedTables}'s
 * result: then `requestedTables` is returned unchanged, with an explicit
 * empty `requestedTables` (`tables: []`) normalized to `undefined`, because
 * `getChangesSince` (and this module's own {@link isChangeFeedDenyAll}) treat
 * an omitted filter and an empty one as equivalent "no filter" and an
 * all-tables grant must not read a client's `tables: []` as "deny every
 * table" (#3020 Copilot follow-up).
 *
 * A throwing or malformed hook fails closed to `[]` (logged, never surfaced
 * as a 5xx — see module docs). A returned table name that is not
 * {@link isValidChangeFeedTableName} (at minimum: contains a NUL byte, or is
 * empty) is treated the same way — the hook's own answer must never be able
 * to reach the database with an unusable value.
 */
export async function resolveAuthorizedChangeFeedTables(
  ctx: ChangeFeedRequestContext,
  requestedTables: string[] | undefined,
): Promise<string[] | undefined> {
  const authorizer = globalThis.__smrtChangeFeedTableAuthorizer;
  const allowed =
    typeof authorizer === 'function'
      ? await callTableAuthorizer(authorizer, ctx, requestedTables)
      : await defaultChangeFeedTables(ctx);
  if (allowed === ALL_CHANGE_FEED_TABLES) {
    return requestedTables && requestedTables.length === 0
      ? undefined
      : requestedTables;
  }

  if (!requestedTables || requestedTables.length === 0) return allowed;
  const allowedSet = new Set(allowed);
  return requestedTables.filter((table) => allowedSet.has(table));
}

/**
 * Whether `entry` is visible to the requester under the registered
 * {@link ChangeFeedEntryVisibility} hook. `true` (visible) when no hook is
 * registered — the unmodified default. A throwing or non-boolean hook fails
 * closed to `false` (hidden), never falls back to visible.
 */
export async function isChangeFeedEntryVisible(
  ctx: ChangeFeedRequestContext,
  entry: ChangeFeedVisibilityEntry,
): Promise<boolean> {
  const predicate = globalThis.__smrtChangeFeedEntryVisibility;
  if (!predicate) return true;
  try {
    return (await predicate({ ...ctx, entry })) === true;
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
>(ctx: ChangeFeedRequestContext, entries: readonly T[]): Promise<T[]> {
  if (entries.length === 0 || !globalThis.__smrtChangeFeedEntryVisibility) {
    return entries as T[];
  }
  const visible: T[] = [];
  for (const entry of entries) {
    if (await isChangeFeedEntryVisible(ctx, entry)) visible.push(entry);
  }
  return visible;
}

interface AuthorizedChangesInput
  extends Omit<GetChangesOptions, 'tables' | 'denyAllTables'>,
    ChangeFeedRequestContext {
  tables?: string[];
}

/** Shared implementation behind {@link getAuthorizedChangesSince} and {@link getAuthorizedTenantScopedChangesSince}. */
async function readAuthorized(
  ctx: ChangeFeedRequestContext,
  requestedTables: string[] | undefined,
  read: (
    tables: string[] | undefined,
    denyAllTables: boolean,
  ) => Promise<ChangeFeedPage>,
): Promise<ChangeFeedPage> {
  const effectiveTables = await resolveAuthorizedChangeFeedTables(
    ctx,
    requestedTables,
  );
  const denyAllTables = isChangeFeedDenyAll(effectiveTables);
  const page = await read(
    denyAllTables ? undefined : effectiveTables,
    denyAllTables,
  );
  if (page.changes.length === 0) return page;
  const visibleChanges = await filterVisibleChangeFeedEntries(
    ctx,
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
 * the `_events` catch-up replay (both transports), which captures its tenant
 * scope once at connection open, and the REST `_changes` route, which has no
 * DispatchBus tenant context of its own to resolve.
 */
export async function getAuthorizedChangesSince(
  db: DatabaseInterface,
  options: AuthorizedChangesInput,
): Promise<ChangeFeedPage> {
  const {
    locals,
    request,
    authMiddleware,
    exposureTenantId,
    ambientTenantId,
    servedModels,
    tables,
    ...rest
  } = options;
  return readAuthorized(
    {
      locals,
      request,
      authMiddleware,
      exposureTenantId,
      // The caller-resolved read tenant is the scope the request acts in.
      ambientTenantId: ambientTenantId ?? rest.tenantId,
      servedModels,
    },
    tables,
    (effectiveTables, denyAllTables) =>
      getChangesSince(db, {
        ...rest,
        tables: effectiveTables,
        denyAllTables,
      }),
  );
}

/**
 * {@link getTenantScopedChangesSince}, additionally applying the registered
 * table and row-level authorization hooks (#3020). This is what the
 * generated SvelteKit `_changes` route calls.
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
  const {
    locals,
    request,
    authMiddleware,
    exposureTenantId,
    ambientTenantId,
    servedModels,
    tables,
    ...rest
  } = options;
  return readAuthorized(
    {
      locals,
      request,
      authMiddleware,
      exposureTenantId,
      ambientTenantId,
      servedModels,
    },
    tables,
    (effectiveTables, denyAllTables) =>
      getTenantScopedChangesSince(db, {
        ...rest,
        tables: effectiveTables,
        denyAllTables,
      }),
  );
}
