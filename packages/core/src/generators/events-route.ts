/**
 * Generated `_events` SSE route — live change signals (issue #1763, SERVER
 * half; parent PRD #1755).
 *
 * Handles `GET {basePath}/_events` in the REST generator: an auth-guarded,
 * tenant-scoped Server-Sent-Events stream of coarse change signals ({table,
 * operation, rowId, tenantId} + a `seq` cursor in the SSE `id:` field). It is
 * the push companion to the pull-based `_changes` route (#1758): a subscriber
 * reacts to a signal by re-reading through the authorized collection routes,
 * so **no row payload ever crosses this channel** — authorization stays
 * entirely on the read path.
 *
 * The stream lifecycle (subscribe, catch-up replay, heartbeat, teardown) lives
 * in {@link buildChangeEventStream} so it is written and tested once; both the
 * REST generator here and the generated SvelteKit route import it. `rest.ts`
 * only registers the path.
 *
 * Contract:
 * - **Fail-closed auth** (identical to `_changes`, #1540 posture): no
 *   `authMiddleware` configured → 401; the middleware may return a Response to
 *   short-circuit (e.g. 403). The feed spans every table, so per-model
 *   `api: { public }` opt-outs deliberately do not apply.
 * - **Tenant scope is captured ONCE at connection open** — signal delivery
 *   happens from a different async context (the writer's afterSave, possibly
 *   another request or replica) with no tenant ALS active, so the filter must
 *   be the value resolved at subscribe time, not re-resolved per signal.
 * - **Same-origin only** for this slice: `rest.ts` does NOT wrap `_events` in
 *   CORS headers. `EventSource` cannot set request headers and credentialed
 *   cross-origin SSE needs `Access-Control-Allow-Credentials` the CORS helper
 *   does not emit; cross-origin SSE is a deliberate follow-up.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ensureChangeFeedTable, getChangesSince } from '../change-feed.js';
import {
  type ChangeSignal,
  subscribeToChangeSignals,
} from '../change-signals.js';
import {
  type DispatchTenantScope,
  resolveDispatchTenantScope,
} from '../dispatch/tenant-resolver.js';
import {
  type ChangesAuthMiddleware,
  resolveChangesDb,
} from './changes-route.js';

const logger = createLogger({ level: 'info' });

/** Options for the `_events` route handler. */
export interface EventsRouteOptions {
  /** The generator's configured auth middleware, if any. */
  authMiddleware?: ChangesAuthMiddleware;
  /** The generator's `APIContext.db` (instance, config object, or URL string). */
  db?: unknown;
}

/**
 * Pseudo object name passed to the auth middleware for the events route, so
 * middlewares can recognize and specially authorize it (mirrors `_changes`).
 */
export const EVENTS_ROUTE_OBJECT_NAME = '_events';

/** Default heartbeat interval (ms). Overridable via stream options. */
export const DEFAULT_EVENTS_HEARTBEAT_MS = 15000;

const encoder = new TextEncoder();

/** Options for {@link buildChangeEventStream}. */
export interface ChangeEventStreamOptions {
  /**
   * Catch-up cursor. When a non-negative number, changes after it are replayed
   * before going live; `null` means live-forward only (no catch-up).
   */
  cursor: number | null;
  /**
   * Tenant scope captured at connection open. Delivery filters against this
   * fixed value — it must NOT be re-resolved per signal (delivery runs outside
   * any tenant ALS context).
   */
  tenantScope: DispatchTenantScope;
  /** Heartbeat interval (ms). Defaults to {@link DEFAULT_EVENTS_HEARTBEAT_MS}. */
  heartbeatMs?: number;
}

/**
 * Whether a signal is visible to a captured tenant scope. Exact same rule as
 * `getChangesSince`'s tenantId filter, run **synchronously server-side** inside
 * the enqueue callback before any byte hits the wire:
 * - not enforced → visible.
 * - enforced, no active tenant (`tenantId === null`) → only global signals.
 * - enforced, tenant `T` → `T`'s signals plus global signals.
 */
export function signalVisibleToTenant(
  sig: ChangeSignal,
  scope: DispatchTenantScope,
): boolean {
  if (!scope.enforced) return true;
  if (scope.tenantId === null) return sig.tenantId === null;
  return sig.tenantId === scope.tenantId || sig.tenantId === null;
}

/**
 * SSE frame for a change signal. The `data` JSON is EXACTLY
 * `{table, operation, rowId, tenantId}` — the `seq` lives only in the `id:`
 * field (the EventSource `Last-Event-ID` a client echoes to resume).
 */
function encodeSseEvent(sig: ChangeSignal): Uint8Array {
  const data = JSON.stringify({
    table: sig.table,
    operation: sig.operation,
    rowId: sig.rowId,
    tenantId: sig.tenantId,
  });
  return encoder.encode(`id: ${sig.seq}\nevent: change\ndata: ${data}\n\n`);
}

/** SSE resync frame. The id advances EventSource past an unservable cursor. */
function encodeSseResyncEvent(cursor: number): Uint8Array {
  return encoder.encode(`id: ${cursor}\nevent: resync\ndata: {}\n\n`);
}

/** SSE comment line (used for heartbeats — ignored by EventSource). */
function encodeSseComment(text: string): Uint8Array {
  return encoder.encode(`: ${text}\n\n`);
}

/**
 * Build the SSE body stream for an `_events` connection.
 *
 * `start(controller)`:
 *  a. **Subscribe FIRST**, before catch-up. Subscribing before the catch-up
 *     read closes the gap window: a write landing between subscribe and the
 *     catch-up read is delivered twice (once live, once in the replay) — which
 *     is safe, since the client dedupes by the SSE `id:`/seq.
 *  b. Write the `retry:` reconnection hint.
 *  c. If a cursor was supplied, replay changes after it (paging until
 *     exhausted); on `resyncRequired`, emit `event: resync` at the server's
 *     fresh horizon.
 *  d. Start the heartbeat interval.
 *
 * `cancel()` tears down on disconnect: clears the heartbeat and unsubscribes,
 * so a dropped client never leaks its subscription (which would pin the dead
 * controller and keep the cross-replica listener refcount above 0).
 */
export function buildChangeEventStream(
  db: DatabaseInterface,
  options: ChangeEventStreamOptions,
): ReadableStream<Uint8Array> {
  const { cursor, tenantScope } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_EVENTS_HEARTBEAT_MS;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // (a) Subscribe FIRST, before catch-up — closes the subscribe/catch-up
      // gap window (a write in between is delivered twice; the client dedupes
      // by seq). The tenant filter uses the scope captured at open, never a
      // per-signal re-resolution.
      unsubscribe = subscribeToChangeSignals(db, (sig) => {
        if (closed) return;
        if (!signalVisibleToTenant(sig, tenantScope)) return;
        try {
          controller.enqueue(encodeSseEvent(sig));
        } catch {
          // Controller already closed (client gone before cancel fired) —
          // tear down so we stop trying to write to a dead controller.
          teardown();
        }
      });

      // (b) Reconnection hint.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));

      // (c) Catch-up replay from the cursor, if one was supplied.
      if (cursor != null) {
        try {
          // Catch-up MUST filter by the scope captured at connection open, not
          // re-resolve the tenant via ALS at call time. start() happens to run
          // in-request today, but relying on that is fragile — and it must match
          // the live-signal filter exactly (signalVisibleToTenant): when
          // enforced, `scope.tenantId` (a tenant id → that tenant + global; null
          // → global only); when not enforced, undefined → no tenant filter.
          const catchupTenantId = tenantScope.enforced
            ? tenantScope.tenantId
            : undefined;
          let since = cursor;
          // Page until exhausted (cursor stops advancing / resync).
          for (;;) {
            const page = await getChangesSince(db, {
              since,
              tenantId: catchupTenantId,
            });
            if (page.resyncRequired) {
              const resyncCursor =
                typeof page.resyncCursor === 'number' &&
                Number.isFinite(page.resyncCursor) &&
                page.resyncCursor >= 0
                  ? page.resyncCursor
                  : since;
              controller.enqueue(encodeSseResyncEvent(resyncCursor));
              break;
            }
            for (const change of page.changes) {
              controller.enqueue(
                encodeSseEvent({
                  table: change.table,
                  operation: change.operation,
                  rowId: change.rowId,
                  tenantId: change.tenantId,
                  seq: change.seq,
                }),
              );
            }
            if (closed) break;
            if (page.cursor === since || page.changes.length === 0) {
              break;
            }
            since = page.cursor;
            // NOTE: catch-up enqueues per-page without a hard cap. It is
            // bounded — an over-old cursor hits `resyncRequired` and stops — but
            // a large retention window replayed to a slow client could spike
            // memory. Honor the controller's backpressure signal cheaply: when
            // the internal queue is full (`desiredSize <= 0`), yield between
            // pages so the consumer drains first. Bounded by `closed` (set on
            // cancel/disconnect), so it can't spin on a client that never reads.
            while (
              !closed &&
              controller.desiredSize !== null &&
              controller.desiredSize <= 0
            ) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          }
        } catch (error) {
          logger.warn('_events: cursor catch-up failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // (d) Heartbeat keeps intermediaries from idling the connection out.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseComment('heartbeat'));
        } catch {
          teardown();
        }
      }, heartbeatMs);
      // Do not keep the event loop alive solely for heartbeats.
      (heartbeat as { unref?: () => void }).unref?.();
    },
    cancel() {
      // Client disconnected (abort) — release the subscription + heartbeat.
      teardown();
    },
  });
}

/**
 * Handle a request against the generated `_events` route.
 *
 * Returns 405 for non-GET; 401 when no auth middleware is configured
 * (fail-closed) or the middleware rejects; 503 when the generator has no
 * database; otherwise a 200 `text/event-stream` response whose body is the
 * live signal stream (built by {@link buildChangeEventStream}).
 */
export async function handleEventsRoute(
  req: Request,
  options: EventsRouteOptions,
): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fail-closed (#1540): the signal stream spans every table, so it is never
  // public — an auth middleware must be configured and must pass.
  if (!options.authMiddleware) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const authCheck = options.authMiddleware(
    EVENTS_ROUTE_OBJECT_NAME,
    req.method.toLowerCase(),
  );
  const authResult = await authCheck(req);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (options.db == null) {
    return new Response(
      JSON.stringify({
        error:
          'Live events unavailable: no database configured for the API generator',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const db = await resolveChangesDb(options.db);
  // A raw handle passed straight to the generator may not have gone through
  // framework init; the feed table backs cursor catch-up.
  await ensureChangeFeedTable(db);

  // Cursor: Last-Event-ID (reconnection) takes precedence over ?since=.
  // Default = live-forward only (no catch-up).
  const cursor = parseCursor(authResult);

  // Capture the tenant scope ONCE at connection open — delivery runs outside
  // any tenant ALS context and must filter against this fixed value.
  const tenantScope = resolveDispatchTenantScope();

  return new Response(buildChangeEventStream(db, { cursor, tenantScope }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Resolve the catch-up cursor for a request: `Last-Event-ID` header first
 * (what an auto-reconnecting EventSource sends), then `?since=`. Returns a
 * non-negative integer, or `null` for live-forward only.
 */
function parseCursor(req: Request): number | null {
  const lastEventId = req.headers.get('Last-Event-ID');
  if (lastEventId !== null && lastEventId.trim() !== '') {
    const n = Number(lastEventId);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  const since = new URL(req.url).searchParams.get('since');
  if (since !== null && since.trim() !== '') {
    const n = Number(since);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }

  return null;
}
