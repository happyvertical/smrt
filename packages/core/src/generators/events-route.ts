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
 * - **Cross-origin is opt-in** (#1861): `rest.ts` now wraps `_events` in its
 *   CORS layer. With the fail-closed default it stays same-origin only, but
 *   when the generator is configured with `enableCors`, an `allowedOrigins`
 *   allowlist, and `allowCredentials: true`, an allow-listed cross-origin
 *   browser client can subscribe with a credentialed `EventSource`
 *   (`withCredentials: true`) — the response echoes the specific origin (never
 *   `*`) plus `Access-Control-Allow-Credentials: true`, so its cookies reach
 *   the same fail-closed auth guard. The CORS layer only lets the cookie
 *   through; it never authorizes — the auth middleware + captured tenant scope
 *   are unchanged, so the read posture holds identically across origins.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ensureChangeFeedTable, getChangesSince } from '../change-feed.js';
import {
  type ChangeFeedRequestContext,
  filterVisibleChangeFeedEntries,
  hasChangeFeedEntryVisibilityHook,
  hasChangeFeedTableAuthorizerHook,
  isChangeFeedDenyAll,
  isChangeFeedEntryVisible,
  resolveAuthorizedChangeFeedTables,
} from '../change-feed-authz.js';
import {
  type ChangeSignal,
  changeSignalSubscriberCount,
  subscribeToChangeSignals,
  tryReserveChangeSignalSubscriberSlot,
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
  /**
   * The build's web-collection shape digest (#1764). When supplied, the stream
   * emits it in a connection-open `manifest` event so long-lived tabs can latch
   * `updateAvailable.contract` on reconnect (#1859).
   */
  manifestHash?: string;
  /**
   * Per-process cap on active `_events` subscribers (#1860). Defaults to
   * {@link DEFAULT_EVENTS_MAX_SUBSCRIBERS}; new over-cap connections receive a
   * retryable 503 and existing subscribers are left untouched. Set to 0 for no
   * cap.
   */
  maxSubscribers?: number;
}

/**
 * Pseudo object name passed to the auth middleware for the events route, so
 * middlewares can recognize and specially authorize it (mirrors `_changes`).
 */
export const EVENTS_ROUTE_OBJECT_NAME = '_events';

/** Default heartbeat interval (ms). Overridable via stream options. */
export const DEFAULT_EVENTS_HEARTBEAT_MS = 15000;

/** Default per-process `_events` subscriber cap (#1860). */
export const DEFAULT_EVENTS_MAX_SUBSCRIBERS = 1000;

/** Retry hint for over-cap `_events` connections (#1860). */
export const DEFAULT_EVENTS_RETRY_AFTER_SECONDS = 5;

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
  /**
   * Optional server manifest hash emitted once at connection open as
   * `event: manifest`. The hash carries no tenant/user data.
   */
  manifestHash?: string;
  /**
   * Reservation claimed at the route boundary before the streaming response was
   * returned. Released when the stream subscribes, or during teardown if the
   * stream never reaches `start()`.
   */
  releaseSubscriberSlot?: () => void;
  /**
   * Request `locals` (SvelteKit) and the authenticated `request`, forwarded
   * to the consumer-supplied change-feed authorization hooks (#3020) —
   * `authorizeChangeFeed` and `isChangeFeedEntryVisible`, see
   * `change-feed-authz.ts`. Resolved and captured ONCE at connection open,
   * exactly like `tenantScope`: delivery runs from a different async context
   * (the writer's `afterSave`, possibly another request or replica) with no
   * per-signal opportunity to re-derive it. The REST generator has no
   * `locals`, so it passes `locals: undefined` and the
   * `authMiddleware`-processed `Request` as `request` — a REST-hosting
   * consumer identifies the principal from `request`.
   */
  locals?: unknown;
  request?: Request;
}

/**
 * Normalize an `_events` subscriber cap.
 *
 * `0` means unlimited rather than reject-all, matching common limit semantics.
 * Invalid values fall back to the default operational cap.
 */
export function normalizeEventsMaxSubscribers(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_EVENTS_MAX_SUBSCRIBERS;
  if (value === 0) return null;
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_EVENTS_MAX_SUBSCRIBERS;
  }
  return Math.floor(value);
}

/** True when opening a new `_events` stream would exceed the configured cap. */
export function changeEventSubscribersAtCapacity(
  db: DatabaseInterface,
  maxSubscribers?: number,
): boolean {
  const normalizedMaxSubscribers =
    normalizeEventsMaxSubscribers(maxSubscribers);
  return (
    normalizedMaxSubscribers !== null &&
    changeSignalSubscriberCount(db) >= normalizedMaxSubscribers
  );
}

/**
 * Atomically claim one `_events` subscriber slot at the route boundary.
 * Returns null when the configured cap is already reached.
 */
export function tryReserveChangeEventSubscriberSlot(
  db: DatabaseInterface,
  maxSubscribers?: number,
): (() => void) | null {
  return tryReserveChangeSignalSubscriberSlot(
    db,
    normalizeEventsMaxSubscribers(maxSubscribers),
  );
}

/** Retryable over-cap response shared by REST and generated SvelteKit routes. */
export function eventStreamCapacityExceededResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'Live events unavailable: subscriber capacity reached',
    }),
    {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(DEFAULT_EVENTS_RETRY_AFTER_SECONDS),
      },
    },
  );
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

/** SSE manifest frame emitted at connection open for live contract detection. */
function encodeSseManifestEvent(manifestHash: string): Uint8Array {
  return encoder.encode(
    `event: manifest\ndata: ${JSON.stringify({ manifestHash })}\n\n`,
  );
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
 *  0. Resolve the change-feed table authorization (#3020), if a hook is
 *     registered, and capture it for the life of the connection — exactly
 *     like `tenantScope`, and for the same reason (delivery runs outside this
 *     call's context). Skipped entirely (no `await`) when no table
 *     authorizer is registered, so the default connection setup stays
 *     synchronous up to the subscribe call below. When a hook IS registered
 *     and the connection has no explicit catch-up `cursor` (live-forward-only),
 *     the feed's current head is captured BEFORE this await as a gap-fill
 *     cursor: `unsubscribe` below only sees signals published after it
 *     attaches, so a write that commits (and signals) while the authorizer is
 *     pending would otherwise be lost forever, not merely delayed — a
 *     supplied `cursor` doesn't need this because its own catch-up phase (c)
 *     already starts from a value captured before this same await.
 *  a. **Subscribe FIRST**, before catch-up. Subscribing before the catch-up
 *     read closes the gap window: a write landing between subscribe and the
 *     catch-up read is delivered twice (once live, once in the replay) — which
 *     is safe, since the client dedupes by the SSE `id:`/seq. Each live signal
 *     is additionally checked against the captured table authorization and,
 *     if registered, the row-level `isChangeFeedEntryVisible` hook — denied
 *     signals are silently dropped, never enqueued.
 *  b. Write the `retry:` reconnection hint.
 *  c. If a cursor was supplied, OR step 0 captured a gap-fill cursor, replay
 *     changes after it (paging until exhausted, applying the same table/row
 *     authorization as live delivery); on `resyncRequired`, emit
 *     `event: resync` at the server's fresh horizon.
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
  const { cursor, tenantScope, manifestHash, locals, request } = options;
  const requestContext: ChangeFeedRequestContext = { locals, request };
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_EVENTS_HEARTBEAT_MS;

  let unsubscribe: (() => void) | null = null;
  let releaseSubscriberSlot = options.releaseSubscriberSlot ?? null;
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
    if (releaseSubscriberSlot) {
      releaseSubscriberSlot();
      releaseSubscriberSlot = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // (0) Table authorization (#3020), captured once for the connection's
      // lifetime — mirrors `tenantScope`. `undefined` (no hook registered)
      // keeps every downstream check a no-op; the `await` only runs when a
      // hook is actually registered, so the unconfigured default reaches the
      // subscribe call below with no yield in between.
      let allowedTables: string[] | undefined;
      // Gap-fill catch-up cursor (#3020 follow-up): in live-forward-only mode
      // (`cursor === null`) there is no explicit catch-up phase below to
      // recover a write that commits — and signals — while the table
      // authorizer is awaited. `unsubscribe` below only sees signals
      // published AFTER it attaches, so anything published during this await
      // is otherwise lost forever, not merely delayed. Capture the feed's
      // current head BEFORE the await (a single indexed MIN/MAX bounds
      // query, via `denyAllTables` so it never touches the row-selecting
      // path) so that once the allow-list resolves we can replay exactly the
      // entries appended in that window — same mechanism the explicit-cursor
      // path already gets for free, since its catch-up starts from a cursor
      // captured before this same await. A non-null `cursor` needs no
      // separate capture: its own catch-up phase already starts from that
      // pre-await value.
      let gapFillCursor: number | null = null;
      if (hasChangeFeedTableAuthorizerHook()) {
        if (cursor == null) {
          // A rejected head query errors the stream, and cancelling an
          // errored stream never reaches `cancel()` — release the reserved
          // subscriber slot here or it stays allocated forever.
          let headPage: Awaited<ReturnType<typeof getChangesSince>>;
          try {
            headPage = await getChangesSince(db, {
              since: 0,
              denyAllTables: true,
            });
          } catch (error) {
            teardown();
            throw error;
          }
          gapFillCursor = headPage.resyncRequired
            ? (headPage.resyncCursor ?? 0)
            : headPage.cursor;
        }
        allowedTables = await resolveAuthorizedChangeFeedTables(
          requestContext,
          undefined,
        );
        // The client may have disconnected while that awaited (#3020 P2):
        // `cancel()` runs `teardown()` before any subscription exists,
        // releasing the reserved slot but leaving `unsubscribe` null since
        // there is nothing to unsubscribe yet. Subscribing below anyway
        // would register a listener that no later `teardown()` call could
        // ever remove — `closed` is already `true`, so `teardown()`
        // short-circuits — permanently leaking a `change-signals` local
        // listener (inflating `changeSignalSubscriberCount` forever) and
        // then throwing on the very next `controller.enqueue` against an
        // already-closed controller. Bail out here instead: the slot was
        // already released by that earlier `teardown()`, so nothing further
        // needs releasing.
        if (closed) return;
      }
      const allowedTableSet = allowedTables ? new Set(allowedTables) : null;
      // Same deny-all distinction `readAuthorized` makes (#3020 P1): an
      // explicit empty allow-list must deny the catch-up read via
      // `getChangesSince`'s `denyAllTables` option, never an empty `tables`
      // array (which means "no filter") or a synthesized sentinel name.
      const catchupDenyAllTables = isChangeFeedDenyAll(allowedTables);
      const rowVisibilityActive = hasChangeFeedEntryVisibilityHook();
      // Serializes the (possibly async) row-visibility check so signals are
      // still delivered in arrival order; unused — and never allocated a
      // microtask — when no row hook is registered (see the enqueue fast path
      // below), preserving the documented synchronous per-listener delivery.
      let deliveryQueue: Promise<void> = Promise.resolve();

      // (a) Subscribe FIRST, before catch-up — closes the subscribe/catch-up
      // gap window (a write in between is delivered twice; the client dedupes
      // by seq). The tenant filter uses the scope captured at open, never a
      // per-signal re-resolution; table authorization is the same captured
      // value.
      unsubscribe = subscribeToChangeSignals(db, (sig) => {
        if (closed) return;
        if (!signalVisibleToTenant(sig, tenantScope)) return;
        if (allowedTableSet && !allowedTableSet.has(sig.table)) return;
        if (!rowVisibilityActive) {
          try {
            controller.enqueue(encodeSseEvent(sig));
          } catch {
            // Controller already closed (client gone before cancel fired) —
            // tear down so we stop trying to write to a dead controller.
            teardown();
          }
          return;
        }
        deliveryQueue = deliveryQueue.then(async () => {
          if (closed) return;
          if (!(await isChangeFeedEntryVisible(requestContext, sig))) return;
          try {
            controller.enqueue(encodeSseEvent(sig));
          } catch {
            teardown();
          }
        });
      });
      if (releaseSubscriberSlot) {
        releaseSubscriberSlot();
        releaseSubscriberSlot = null;
      }

      // (b) Reconnection hint.
      controller.enqueue(encoder.encode('retry: 3000\n\n'));
      // Advertise the server contract at connection open (#1859). A reconnect
      // naturally replays this frame, letting a long-lived tab learn about a
      // shape-only API deploy without a full page load.
      if (manifestHash !== undefined) {
        controller.enqueue(encodeSseManifestEvent(manifestHash));
      }

      // (c) Catch-up replay from the cursor, if one was supplied — or from
      // the gap-fill cursor captured before the authorizer await (above),
      // which replays only what was appended during that await so a
      // live-forward-only connection never silently drops it.
      const catchupCursor = cursor ?? gapFillCursor;
      if (catchupCursor != null) {
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
          let since = catchupCursor;
          // Page until exhausted (cursor stops advancing / resync).
          for (;;) {
            const page = await getChangesSince(db, {
              since,
              tenantId: catchupTenantId,
              // Same captured table authorization as live delivery (#3020).
              tables: catchupDenyAllTables ? undefined : allowedTables,
              denyAllTables: catchupDenyAllTables,
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
            // Row-level visibility (#3020) — filters the replayed page the
            // same way the read `_changes` path does, never touching
            // `page.cursor` below so the client still advances past a denied
            // entry instead of re-requesting it forever.
            const visibleChanges = await filterVisibleChangeFeedEntries(
              requestContext,
              page.changes,
            );
            for (const change of visibleChanges) {
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
  const releaseSubscriberSlot = tryReserveChangeEventSubscriberSlot(
    db,
    options.maxSubscribers,
  );
  if (!releaseSubscriberSlot) {
    return eventStreamCapacityExceededResponse();
  }

  // Cursor: Last-Event-ID (reconnection) takes precedence over ?since=.
  // Default = live-forward only (no catch-up).
  const cursor = parseCursor(authResult);

  // Capture the tenant scope ONCE at connection open — delivery runs outside
  // any tenant ALS context and must filter against this fixed value.
  const tenantScope = resolveDispatchTenantScope();

  return new Response(
    buildChangeEventStream(db, {
      cursor,
      tenantScope,
      manifestHash: options.manifestHash,
      releaseSubscriberSlot,
      // REST has no `locals`; the authorization hooks (#3020) identify the
      // principal from the authMiddleware-processed request instead.
      locals: undefined,
      request: authResult,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
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
