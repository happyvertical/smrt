/**
 * Generated `_changes` HTTP route for the change feed (issue #1758).
 *
 * Handles `GET {basePath}/_changes` in the REST generator: an auth-guarded,
 * tenant-scoped cursor read over the `_smrt_changes` log. This module keeps
 * the feed logic out of `rest.ts` (which only registers the path) so
 * sibling generator changes stay conflict-free.
 *
 * Contract (part of the client/mobile sync contract, PRD #1755):
 * - `GET {basePath}/_changes?since=<cursor>&tables=<a,b>&limit=<n>` returns
 *   `{ changes, cursor, resyncRequired? }` — see `getChangesSince` for the
 *   exact cursor guarantee (strictly monotonic; reads miss no committed
 *   changes under concurrent writers). `resyncRequired: true` — served as
 *   HTTP 200, it is protocol state rather than an error — means the cursor
 *   cannot be served incrementally (pruned out of the retained window, or
 *   foreign/reset) and the client must re-fetch its data in full.
 * - **Auth is fail-closed** (#1540 posture): the route requires the
 *   generator's `authMiddleware`. Without one configured, every request is
 *   refused with 401 — the feed spans all tables, so per-model
 *   `api: { public }` opt-outs deliberately do NOT apply to it.
 * - **Tenant scoping** follows the active tenant context through the same
 *   dependency-inversion hook the DispatchBus uses: with tenancy enabled, a
 *   request only ever sees its own tenant's changes plus global rows; with
 *   tenancy enabled but no active tenant, only global rows (fail-closed).
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  ensureChangeFeedTable,
  getTenantScopedChangesSince,
} from '../change-feed.js';

const logger = createLogger({ level: 'info' });

/**
 * Structural copy of `APIConfig['authMiddleware']` (from `rest.ts`) so this
 * module never imports the generator back (keeps the dependency one-way).
 *
 * Exported so the sibling `_events` route (#1763) reuses the exact same
 * fail-closed auth contract without redeclaring it.
 */
export type ChangesAuthMiddleware = (
  objectName: string,
  action: string,
) => (req: Request) => Promise<Request | Response>;

export interface ChangesRouteOptions {
  /** The generator's configured auth middleware, if any. */
  authMiddleware?: ChangesAuthMiddleware;
  /** The generator's `APIContext.db` (instance, config object, or URL string). */
  db?: unknown;
}

/**
 * Pseudo object name passed to the auth middleware for the feed route, so
 * middlewares can recognize and specially authorize it if they want to.
 */
export const CHANGES_ROUTE_OBJECT_NAME = '_changes';

// Resolve the APIContext db option once per distinct option value so every
// request reads the same underlying database (getDatabase() would otherwise
// mint a fresh instance per call for config objects / `:memory:` URLs).
const resolvedInstanceDbs = new WeakMap<object, Promise<DatabaseInterface>>();
const resolvedUrlDbs = new Map<string, Promise<DatabaseInterface>>();

/**
 * Resolve the generator's `db` option (instance, config object, or URL string)
 * to a single shared {@link DatabaseInterface} per distinct option value.
 *
 * Exported so the sibling `_events` route (#1763) resolves its database
 * identically — sharing this WeakMap/Map means both routes read the same
 * underlying handle for a given option, which matters for `:memory:` databases
 * where a fresh `getDatabase()` per call would mint a separate database.
 */
export function resolveChangesDb(
  dbOption: unknown,
): Promise<DatabaseInterface> {
  if (dbOption && typeof dbOption === 'object') {
    if (
      'query' in dbOption &&
      typeof (dbOption as { query?: unknown }).query === 'function'
    ) {
      return Promise.resolve(dbOption as DatabaseInterface);
    }
    let resolved = resolvedInstanceDbs.get(dbOption);
    if (!resolved) {
      resolved = getDatabase(
        dbOption as Parameters<typeof getDatabase>[0],
      ) as Promise<DatabaseInterface>;
      resolvedInstanceDbs.set(dbOption, resolved);
    }
    return resolved;
  }

  if (typeof dbOption === 'string' && dbOption) {
    let resolved = resolvedUrlDbs.get(dbOption);
    if (!resolved) {
      // Match SmrtClass's connection-sharing convention for file-backed URLs.
      const isMemoryDb = dbOption === ':memory:';
      resolved = getDatabase({
        url: dbOption,
        ...(isMemoryDb ? {} : { dbid: `smrt:${dbOption}` }),
      }) as Promise<DatabaseInterface>;
      resolvedUrlDbs.set(dbOption, resolved);
    }
    return resolved;
  }

  return Promise.reject(
    new Error('The _changes route requires a database in APIContext'),
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Handle a request against the generated `_changes` route.
 *
 * Returns 401 when no auth middleware is configured (fail-closed) or the
 * middleware rejects; 405 for non-GET methods; 400 for malformed `since`/
 * `limit`; 503 when the generator has no database; otherwise a
 * `{ changes, cursor }` page scoped to the active tenant context.
 */
export async function handleChangesRoute(
  req: Request,
  options: ChangesRouteOptions,
): Promise<Response> {
  if (req.method !== 'GET') {
    return errorResponse(405, 'Method not allowed');
  }

  // Fail-closed (#1540): the change feed spans every table, so it is never
  // public — an auth middleware must be configured and must pass. The action
  // is the lowercased HTTP method, matching the generator's other call sites.
  if (!options.authMiddleware) {
    return errorResponse(401, 'Authentication required');
  }
  const authCheck = options.authMiddleware(
    CHANGES_ROUTE_OBJECT_NAME,
    req.method.toLowerCase(),
  );
  const authResult = await authCheck(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (options.db == null) {
    return errorResponse(
      503,
      'Change feed unavailable: no database configured for the API generator',
    );
  }

  const url = new URL(authResult.url);
  const since = Number(url.searchParams.get('since') ?? '0');
  if (!Number.isFinite(since) || since < 0) {
    return errorResponse(400, "'since' must be a non-negative number");
  }

  let limit: number | undefined;
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || limit < 1) {
      return errorResponse(400, "'limit' must be a positive number");
    }
  }

  const tablesParam = url.searchParams.get('tables');
  const tables = tablesParam
    ? tablesParam
        .split(',')
        .map((table) => table.trim())
        .filter(Boolean)
    : undefined;

  try {
    const db = await resolveChangesDb(options.db);
    // System tables are runtime-ensured; a raw handle passed straight to the
    // generator may not have gone through framework init yet.
    await ensureChangeFeedTable(db);
    const page = await getTenantScopedChangesSince(db, {
      since,
      tables,
      limit,
    });
    return jsonResponse(page);
  } catch (error) {
    logger.error('Change feed route failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(500, 'Internal server error');
  }
}
