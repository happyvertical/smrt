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
import {
  type ChangeFeedPage,
  ensureChangeFeedTable,
  getChangesSince,
} from '../change-feed.js';
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
import { resolveDbCacheKey } from '../collection-cache.js';
import {
  type DispatchTenantScope,
  resolveDispatchTenantScope,
} from '../dispatch/tenant-resolver.js';
import {
  holdsWriteQueue,
  runOutsideWriteContext,
} from '../embedded-write-queue.js';
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

/**
 * Chunks the stream buffers ahead of its reader. The connection reads the
 * feed only while the buffer has room, so an unread connection holds at most
 * this many chunks plus one feed page — live writes add nothing to it.
 */
const EVENTS_STREAM_HIGH_WATER_MARK = 64;

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
  sig: Pick<ChangeSignal, 'tenantId'>,
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

/**
 * SSE frame for a signal with no feed sequence: same data, no `id:` line, so
 * the client's resume cursor (`Last-Event-ID`) is left where it was.
 */
function encodeSseUnsequencedEvent(sig: ChangeSignal): Uint8Array {
  const data = JSON.stringify({
    table: sig.table,
    operation: sig.operation,
    rowId: sig.rowId,
    tenantId: sig.tenantId,
  });
  return encoder.encode(`event: change\ndata: ${data}\n\n`);
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
 * Delay before one re-read when a wake-up named a sequence the feed did not
 * yet serve (a signal can be published by a writer whose commit is not yet
 * visible to this reader's connection). After that one retry the outstanding
 * wake-up is re-read on each heartbeat until the feed reaches it — or until a
 * later write moves the feed past it, if the write was rolled back.
 */
const SHORT_READ_RETRY_MS = 250;

/**
 * Identical feed reads in flight, keyed by database scope, cursor and drain
 * mode. Every caught-up connection on a database sits at the same cursor, so
 * one write wakes them all onto the same read: they share its result instead
 * of each issuing it. Entries live only while the read is in flight, so no
 * connection ever receives a stale page.
 */
const inflightFeedReads = new Map<string, Promise<ChangeFeedPage>>();

/**
 * Read one unfiltered feed page after `since`, sharing an identical read that
 * is already in flight. Tenant, table and row filters are applied by each
 * connection afterwards, so the shared page is never narrowed for one reader
 * at another's expense. Credential tables are refused inside
 * `getChangesSince` itself.
 */
function readFeedPage(
  db: DatabaseInterface,
  since: number,
  drain: boolean,
): Promise<ChangeFeedPage> {
  let key: string;
  try {
    key = `${resolveDbCacheKey(db)}\u0000${since}\u0000${drain ? 1 : 0}`;
  } catch {
    return getChangesSince(db, { since, drain });
  }
  const pending = inflightFeedReads.get(key);
  if (pending) return pending;
  const read = getChangesSince(db, { since, drain });
  inflightFeedReads.set(key, read);
  const clear = () => {
    if (inflightFeedReads.get(key) === read) inflightFeedReads.delete(key);
  };
  read.then(clear, clear);
  return read;
}

/**
 * Build the SSE body stream for an `_events` connection.
 *
 * **Delivery invariant.** Every `change` frame with an `id:` is read from the durable feed,
 * in sequence order, starting after the connection's own sent cursor. A live
 * signal is only a wake-up: it tells the connection that the feed has moved,
 * and the connection then reads from its cursor. So the stream never emits a
 * sequence at or below one it already sent, and never emits a sequence while
 * an earlier committed one it may see is still unsent — the `id:` a client
 * resumes from (`Last-Event-ID`) always covers everything before it. Rows
 * the connection may not see still advance its cursor; they are simply not
 * framed.
 *
 * A signal that carries no feed sequence is framed directly, without an
 * `id:` (see `frameUnsequenced`). An idle heartbeat also reads the feed, so a
 * change committed without any signal is still delivered.
 *
 * A read that fails closes the stream. The client reconnects with the last id
 * it actually received and the server replays from there; staying open
 * live-only would let a later id overtake the changes the failed read was
 * meant to deliver.
 *
 * `start(controller)`:
 *  a. **Subscribe first.** Signals published from now on raise the
 *     connection's wanted sequence; nothing is emitted until the starting
 *     cursor is known, and the first read covers everything signalled
 *     meanwhile.
 *  b. Fix the starting cursor: the supplied `cursor`, or — live-forward only
 *     — the feed's current head.
 *  c. Resolve the change-feed table authorization (#3020), if a hook is
 *     registered, and capture it for the life of the connection — exactly
 *     like `tenantScope`, and for the same reason (delivery runs outside this
 *     call's context). Because the starting cursor was fixed before this
 *     await, a write that commits while the hook is pending is still read.
 *  d. Write the `retry:` reconnection hint and the optional manifest frame.
 *  e. Read from the starting cursor until the feed is exhausted (catch-up),
 *     applying the captured tenant scope and table/row authorization; on
 *     `resyncRequired`, emit `event: resync` at the server's fresh horizon
 *     and continue from it.
 *  f. Start the heartbeat interval (skipped while the reader is not
 *     draining).
 *
 * **Bounded buffering.** The connection reads the feed only while the
 * reader has room (`pull()`), and live signals only raise a sequence number,
 * so a connection whose client stops reading holds at most the high-water
 * mark plus one feed page, however many writes happen meanwhile.
 *
 * `cancel()` tears down on disconnect: clears the timers and unsubscribes,
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let capacityWaiter: (() => void) | null = null;
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  // Delivery state (see the delivery invariant above).
  /** Highest sequence delivered or passed over; null until the start is fixed. */
  let sentCursor: number | null = null;
  /** Highest sequence a wake-up has announced. */
  let wantedSeq = 0;
  let pumping = false;
  let pumpRequested = false;
  let pumpExhaustive = false;
  let shortReadRetried = false;

  // Captured table authorization (#3020). `null` = no table hook, or not yet
  // resolved (wake-ups are then not pre-filtered; reads still are, below).
  let allowedTableSet: Set<string> | null = null;
  let denyAllTables = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    wakeCapacityWaiter();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (releaseSubscriberSlot) {
      releaseSubscriberSlot();
      releaseSubscriberSlot = null;
    }
  };

  /** End the stream; the client reconnects from the last id it received. */
  const closeStream = () => {
    if (closed) return;
    teardown();
    try {
      streamController?.close();
    } catch {
      // Already closed or errored by the platform.
    }
  };

  /** End the stream after a failed read; the client resumes from its last id. */
  const failClosed = (error: unknown) => {
    if (closed) return;
    logger.warn(
      '_events: change-feed read failed; closing the stream so the client resumes from its last delivered id',
      { error: error instanceof Error ? error.message : String(error) },
    );
    closeStream();
  };

  /** Tenant scope + captured table allow-list, the synchronous filters. */
  const passesStaticFilters = (entry: {
    table: string;
    tenantId: string | null;
  }): boolean => {
    if (denyAllTables) return false;
    if (!signalVisibleToTenant(entry, tenantScope)) return false;
    if (allowedTableSet && !allowedTableSet.has(entry.table)) return false;
    return true;
  };

  /** True while the reader has room for at least one more chunk. */
  const hasCapacity = (): boolean => {
    const size = streamController?.desiredSize;
    return size === null || size === undefined || size > 0;
  };

  /**
   * Resolve once the reader has room again (`pull()`), or the stream ends.
   * The connection reads the feed only after this, so an unread connection
   * stops reading instead of buffering every live write.
   */
  const waitForCapacity = (): Promise<void> => {
    if (closed || hasCapacity()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      capacityWaiter = resolve;
    });
  };

  function wakeCapacityWaiter(): void {
    const waiter = capacityWaiter;
    capacityWaiter = null;
    waiter?.();
  }

  /**
   * Read forward from `sentCursor`, emitting what this connection may see.
   * `exhaustive` keeps reading until the feed stops advancing (catch-up);
   * otherwise reading stops once the announced sequence is covered.
   */
  const pumpOnce = async (exhaustive: boolean): Promise<void> => {
    for (;;) {
      if (closed || sentCursor === null || streamController === null) return;
      await waitForCapacity();
      if (closed) return;
      const since = sentCursor;
      // Catch-up reads sequence staged entries first (#2649); wake-up reads
      // were triggered by an already-sequenced entry and stay SELECT-only.
      const page = await readFeedPage(db, since, exhaustive);
      if (closed) return;
      if (page.resyncRequired) {
        const resyncCursor =
          typeof page.resyncCursor === 'number' &&
          Number.isFinite(page.resyncCursor) &&
          page.resyncCursor >= 0
            ? page.resyncCursor
            : since;
        streamController.enqueue(encodeSseResyncEvent(resyncCursor));
        sentCursor = resyncCursor;
        if (resyncCursor === since) return;
        continue;
      }
      const candidates = page.changes.filter(
        (change) => change.seq > since && passesStaticFilters(change),
      );
      // Row-level visibility (#3020) — the same filter the `_changes` read
      // path applies; never touches the cursor, so a denied entry is passed
      // over rather than re-read forever.
      const deliverable = await filterVisibleChangeFeedEntries(
        requestContext,
        candidates,
      );
      if (closed) return;
      for (const change of deliverable) {
        streamController.enqueue(
          encodeSseEvent({
            table: change.table,
            operation: change.operation,
            rowId: change.rowId,
            tenantId: change.tenantId,
            seq: change.seq,
          }),
        );
      }
      if (page.cursor <= since) {
        // The feed did not move. A wake-up that named a later sequence came
        // from a write this connection cannot see yet: read once more
        // shortly, then leave it to the next signal or heartbeat.
        if (wantedSeq > since) {
          if (!shortReadRetried) {
            shortReadRetried = true;
            scheduleRetry();
          }
        }
        return;
      }
      sentCursor = page.cursor;
      shortReadRetried = false;
      if (!exhaustive && sentCursor >= wantedSeq) return;
    }
  };

  const schedulePump = (exhaustive = false) => {
    if (exhaustive) pumpExhaustive = true;
    pumpRequested = true;
    if (pumping || closed || sentCursor === null) return;
    pumping = true;
    // Detached from the caller's write context: a wake-up can arrive from a
    // commit callback that still holds the database's write queue, and reads
    // that inherited that hold would stop waiting for later transactions —
    // and could then see their uncommitted feed rows.
    void runOutsideWriteContext(async () => {
      try {
        while (pumpRequested && !closed) {
          pumpRequested = false;
          const runExhaustive = pumpExhaustive;
          pumpExhaustive = false;
          await pumpOnce(runExhaustive);
        }
      } catch (error) {
        failClosed(error);
      } finally {
        pumping = false;
      }
    });
  };

  const scheduleRetry = () => {
    if (retryTimer || closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      schedulePump();
    }, SHORT_READ_RETRY_MS);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  /**
   * A signal that carries no feed sequence (`seq` not a positive integer) —
   * published by a producer that writes no feed row — is framed directly,
   * as before the ordered cursor read existed, but without an `id:` line:
   * an id would move the client's resume cursor to a value the feed never
   * assigned. Best-effort, like any signal: dropped when the reader is not
   * draining, so it can never grow the buffer.
   */
  const frameUnsequenced = (sig: ChangeSignal) => {
    if (!passesStaticFilters(sig)) return;
    const enqueue = () => {
      if (closed || !streamController || !hasCapacity()) return;
      try {
        streamController.enqueue(encodeSseUnsequencedEvent(sig));
      } catch {
        teardown();
      }
    };
    if (!hasChangeFeedEntryVisibilityHook()) {
      enqueue();
      return;
    }
    void isChangeFeedEntryVisible(requestContext, sig).then((visible) => {
      if (visible) enqueue();
    });
  };

  /**
   * A signal that carries a feed sequence is a wake-up only; the frame comes
   * from the ordered feed read, so its id can never overtake an unsent
   * earlier change.
   */
  const onSignal = (sig: ChangeSignal) => {
    if (closed) return;
    if (!Number.isSafeInteger(sig.seq) || sig.seq <= 0) {
      frameUnsequenced(sig);
      return;
    }
    // Pre-filtering is an optimisation only: a change this connection may not
    // see never needs a read of its own — the next visible wake-up's read
    // passes over it.
    if (!passesStaticFilters(sig)) return;
    if (sentCursor !== null && sig.seq <= sentCursor) return;
    if (sig.seq > wantedSeq) wantedSeq = sig.seq;
    schedulePump();
  };

  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        streamController = controller;
        // Every feed read waits in the database's write queue. A stream
        // started from inside a framework write transaction on the same
        // database (which holds that queue until its callback returns) could
        // only be served after the callback finished — so a callback that
        // awaits a frame would wait forever, and every writer queued behind
        // it with it. Refuse instead.
        if (holdsWriteQueue(db)) {
          teardown();
          throw new Error(
            'An _events stream cannot be started inside a framework write ' +
              'transaction on the same database: its feed reads wait for that ' +
              'transaction to finish. Open the stream outside the transaction.',
          );
        }
        // (a) Subscribe first; see the delivery invariant.
        unsubscribe = subscribeToChangeSignals(db, onSignal);
        if (releaseSubscriberSlot) {
          releaseSubscriberSlot();
          releaseSubscriberSlot = null;
        }

        let startCursor = cursor;
        try {
          // (b) Live-forward only: start from the feed's current head (one
          // bounds read via `denyAllTables`, no row scan).
          if (startCursor == null) {
            const head = await getChangesSince(db, {
              since: 0,
              denyAllTables: true,
            });
            startCursor = head.resyncRequired
              ? (head.resyncCursor ?? 0)
              : head.cursor;
          }
          if (closed) return;
          // (c) Table authorization, captured once for the connection.
          if (hasChangeFeedTableAuthorizerHook()) {
            const allowedTables = await resolveAuthorizedChangeFeedTables(
              requestContext,
              undefined,
            );
            // The client may have disconnected while that awaited (#3020 P2);
            // teardown already unsubscribed and released the slot.
            if (closed) return;
            allowedTableSet = allowedTables ? new Set(allowedTables) : null;
            denyAllTables = isChangeFeedDenyAll(allowedTables);
          }
        } catch (error) {
          // A rejected start errors the stream, and cancelling an errored
          // stream never reaches `cancel()` — tear down here or the
          // subscription and any reserved slot stay allocated forever.
          teardown();
          throw error;
        }

        // (d) Reconnection hint and contract advertisement (#1859).
        controller.enqueue(encoder.encode('retry: 3000\n\n'));
        if (manifestHash !== undefined) {
          controller.enqueue(encodeSseManifestEvent(manifestHash));
        }

        // (e) Ordered catch-up from the starting cursor. Wake-ups received so
        // far are covered by the same reads.
        sentCursor = startCursor;
        schedulePump(true);

        // (f) Heartbeat keeps intermediaries from idling the connection out,
        // and re-reads when a wake-up is still outstanding. A reader that is
        // not draining gets no heartbeat — its buffer must not grow.
        if (closed) return;
        heartbeat = setInterval(() => {
          if (closed) return;
          if (hasCapacity()) {
            try {
              controller.enqueue(encodeSseComment('heartbeat'));
            } catch {
              teardown();
              return;
            }
          }
          // A bounded durable read once per interval while idle: a change
          // committed with no signal reaching this process (another replica
          // without a notification channel, a lost notification, a write the
          // framework did not signal) is still delivered. Exhaustive, so it
          // also sequences staged PostgreSQL work, and shared with any
          // identical read in flight.
          if (sentCursor !== null && !pumping) schedulePump(true);
        }, heartbeatMs);
        // Do not keep the event loop alive solely for heartbeats.
        (heartbeat as { unref?: () => void }).unref?.();
      },
      pull() {
        // The reader has room again; resume a read that waited for it.
        wakeCapacityWaiter();
      },
      cancel() {
        // Client disconnected (abort) — release the subscription + timers.
        teardown();
      },
    },
    { highWaterMark: EVENTS_STREAM_HIGH_WATER_MARK },
  );
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
