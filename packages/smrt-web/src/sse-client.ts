/**
 * @happyvertical/smrt-web — live-updates subscriber (#1763, CLIENT half).
 *
 * The browser half of live cache invalidation: ONE app-wide subscriber that
 * turns the server's coarse change signals into collection refetches, so a
 * dashboard reflects another session's writes without a manual refresh or
 * aggressive polling. It speaks the two channels the #1763 server half
 * generated:
 *
 * - the push channel — the generated `_events` Server-Sent-Events route
 *   (`packages/core/src/generators/events-route.ts`): NAMED events
 *   `event: change` / `event: resync` whose `data` is `{table, operation,
 *   rowId, tenantId}`, with the cursor `seq` carried ONLY in the SSE `id:`
 *   field (mirrored by the browser to `MessageEvent.lastEventId`). Heartbeats
 *   are `: heartbeat` comment lines EventSource ignores natively.
 * - the pull channel — the generated `_changes` route
 *   (`packages/core/src/generators/changes-route.ts`): `GET {changesUrl}
 *   ?since=&tables=&limit=` → `{changes, cursor, resyncRequired?}`, the full
 *   fallback where SSE is unavailable.
 *
 * ## No row payload, no tenant logic, no authorization here
 *
 * The wire carries only a signal (table + row id + operation), never a row.
 * A signal makes the subscriber INVALIDATE — the refetch re-reads through the
 * authorized collection routes, so authorization and tenant-scoping stay
 * ENTIRELY on the read path, exactly as the server enforces (the `_events`
 * stream is auth-guarded and tenant-scoped at connection open; `_changes` is
 * tenant-scoped per request). This module therefore does NO tenant filtering
 * and needs no identity — it just maps `table → invalidate`.
 *
 * ## One app-wide instance (mirrors createSmrtWebClient)
 *
 * A consumer constructs ONE subscriber and passes it to every
 * {@link liveInvalidation} capability — the same "one shared handle" convention
 * as {@link createSmrtWebClient}. It is NOT auto-derived per collection: one
 * EventSource / one poll loop feeds every registered collection.
 *
 * ## Idempotent invalidation → no client-side dedup
 *
 * Re-invalidating on a replayed change (a reconnect replays the tail from the
 * cursor) is safe: invalidation only schedules a background refetch, and the
 * factory's relationship-derived invalidation is itself idempotent
 * (over-invalidation merely refetches). So the subscriber deliberately does NO
 * seq dedup — a replayed signal STILL fires, which is exactly what guarantees a
 * gap misses no invalidation. `lastSeq` is a resume cursor for the poll
 * fallback, not a dedup filter.
 *
 * Engine boundary: no `@happyvertical/smrt-*` import and no `@tanstack/*`
 * import — URLs and `fetch` arrive as config, and the refetch primitive arrives
 * as the `invalidate` callback each capability wires from `ctx.invalidate()`.
 * smrt-web has no logger dependency, so faults are surfaced via `console.warn`
 * (matching `warnCapability` / core's `deliverLocally` style).
 */

import type { SmrtWebCapability } from './capability.js';

/**
 * The minimal `EventSource` surface the subscriber uses — declared here so a
 * test injects a fake without a real DOM, and so this module compiles without
 * DOM `lib` beyond the ambient global. A real `EventSource` satisfies it
 * structurally.
 */
export interface SmrtWebEventSource {
  /** Native reconnect fires this after (re)connect. */
  onopen: ((this: unknown, ev: unknown) => unknown) | null;
  /**
   * Fires on a stream error. A transient drop leaves `readyState` at OPEN
   * (0→…) and the browser auto-reconnects with `Last-Event-ID`; a fatal error
   * (server 401 / route disabled) leaves it CLOSED.
   */
  onerror: ((this: unknown, ev: unknown) => unknown) | null;
  /**
   * Fires only for UNNAMED (`message`) events. The `_events` frames are NAMED
   * (`change` / `resync`), so this never fires for them — the subscriber uses
   * {@link addEventListener} instead. Present only to satisfy the structural
   * type of a real EventSource.
   */
  onmessage: ((this: unknown, ev: unknown) => unknown) | null;
  /** Register a listener for a NAMED event (`change`, `resync`). */
  addEventListener(
    type: string,
    listener: (ev: { data: string; lastEventId: string }) => void,
  ): void;
  /** Close the stream (stops reconnection). */
  close(): void;
  /** `CONNECTING` (0), `OPEN` (1), or `CLOSED` (2). */
  readonly readyState: number;
}

/** EventSource.CLOSED — a fatal, non-reconnecting state. */
const EVENT_SOURCE_CLOSED = 2;

/** Factory that constructs an {@link SmrtWebEventSource} for a URL. */
export type SmrtWebEventSourceFactory = (
  url: string,
  init: { withCredentials: boolean },
) => SmrtWebEventSource;

/** Configuration for {@link createSmrtWebEventSubscriber}. */
export interface SmrtWebEventSubscriberConfig {
  /** Absolute or same-origin URL of the generated `_events` SSE route. */
  eventsUrl: string;
  /** Absolute or same-origin URL of the generated `_changes` route (fallback). */
  changesUrl: string;
  /** `fetch` implementation for the polling fallback. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Factory for the EventSource. Defaults to `new globalThis.EventSource(url,
   * { withCredentials })`, guarded by a `typeof` check — when EventSource is
   * absent (or the factory yields nothing) the subscriber starts on the polling
   * fallback instead.
   */
  eventSourceFactory?: SmrtWebEventSourceFactory;
  /** Poll interval for the `_changes` fallback (ms). Default 5000. */
  pollIntervalMs?: number;
  /** `withCredentials` for the EventSource (cookie auth). Default true. */
  withCredentials?: boolean;
}

/** Which transport a subscriber is currently using. */
export type SmrtWebSubscriberTransport = 'sse' | 'polling' | 'idle';

/**
 * The ONE app-wide live-updates subscriber. Construct once (see
 * {@link createSmrtWebEventSubscriber}) and pass it to every
 * {@link liveInvalidation} capability.
 */
export interface SmrtWebEventSubscriber {
  /**
   * The live transport: `'sse'` while the EventSource is the source of truth,
   * `'polling'` when running (or downgraded to) the `_changes` fallback,
   * `'idle'` before any transport starts.
   */
  readonly transport: SmrtWebSubscriberTransport;
  /**
   * Register an invalidator for a physical table. Returns an unregister
   * function. Multiple invalidators may share a table (two live collections);
   * a `change` for that table fires them all.
   */
  registerTable(table: string, invalidate: () => void): () => void;
  /** Invalidate every registered table (a `resync` / `resyncRequired`). */
  invalidateAll(): void;
  /** Tear down the live transport and drop all registrations. */
  close(): void;
}

/**
 * Default EventSource factory: `new globalThis.EventSource(url, init)` when the
 * global exists, else `undefined` so the caller falls back to polling.
 */
function defaultEventSourceFactory(
  url: string,
  init: { withCredentials: boolean },
): SmrtWebEventSource | undefined {
  const EventSourceCtor = (
    globalThis as { EventSource?: new (u: string, i?: unknown) => unknown }
  ).EventSource;
  if (typeof EventSourceCtor !== 'function') return undefined;
  return new EventSourceCtor(url, init) as unknown as SmrtWebEventSource;
}

/**
 * One entry of a `_changes` page (mirrors core's `ChangeFeedEntry`) — the only
 * fields the subscriber reads. Declared locally so this module keeps its
 * zero-`@happyvertical/smrt-*`-import boundary.
 */
interface ChangeEntryLike {
  table: string;
  seq?: number;
}

/** A `_changes` page (mirrors core's `ChangeFeedPage`). */
interface ChangesPageLike {
  changes: ChangeEntryLike[];
  cursor: number;
  resyncRequired?: boolean;
}

/**
 * Create the app-wide live-updates subscriber. Feature-detects ONCE at
 * construction: an available EventSource connects the SSE stream; otherwise it
 * starts the `_changes` poll loop. A fatal SSE error later downgrades to
 * polling for the rest of the subscriber's life (no flap-back).
 */
export function createSmrtWebEventSubscriber(
  config: SmrtWebEventSubscriberConfig,
): SmrtWebEventSubscriber {
  const {
    eventsUrl,
    changesUrl,
    fetchFn = (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    eventSourceFactory = defaultEventSourceFactory,
    pollIntervalMs = 5000,
    withCredentials = true,
  } = config;

  // table → set of invalidators. A Set so a collection registers/unregisters
  // without positional bookkeeping and two collections coexist under one table.
  const tableInvalidators = new Map<string, Set<() => void>>();

  // The resume cursor: the highest seq observed (SSE) or the last `_changes`
  // cursor (polling). NOT a dedup filter — invalidation is idempotent.
  let lastSeq: number | null = null;

  let transport: SmrtWebSubscriberTransport = 'idle';
  let eventSource: SmrtWebEventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  /**
   * Report a fault without a logger dep (smrt-web is TanStack-only) — a
   * swallowed diagnostic in the package's fail-loud-in-the-console style.
   */
  const warn = (message: string, error?: unknown): void => {
    // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); live-subscriber faults surface via console.warn by design (#1763)
    console.warn(`[smrt-web] live subscriber: ${message}`, error);
  };

  /**
   * Fire one set of invalidators, each in its OWN try/catch (snapshot first so
   * an invalidator that unregisters mid-delivery can't mutate the set) — one
   * throwing invalidator never blocks its siblings.
   */
  const fireAll = (invalidators: Set<() => void> | undefined): void => {
    if (!invalidators || invalidators.size === 0) return;
    for (const invalidate of [...invalidators]) {
      try {
        invalidate();
      } catch (error) {
        warn('an invalidator threw; ignoring', error);
      }
    }
  };

  /** Invalidate every collection registered for `table`. */
  const invalidateTable = (table: string): void => {
    fireAll(tableInvalidators.get(table));
  };

  /** Invalidate every registered collection across every table. */
  const invalidateAll = (): void => {
    for (const invalidators of tableInvalidators.values()) {
      fireAll(invalidators);
    }
  };

  /**
   * Parse a `change` frame's `data` DEFENSIVELY: malformed JSON (or a payload
   * with no string `table`) is logged and dropped — NEVER thrown back into the
   * EventSource message loop (a throw there would break subsequent delivery).
   */
  const onChange = (ev: { data: string; lastEventId: string }): void => {
    if (closed) return;
    let table: string | undefined;
    try {
      const parsed = JSON.parse(ev.data) as { table?: unknown };
      if (typeof parsed.table === 'string') table = parsed.table;
    } catch (error) {
      warn('dropping malformed change frame', error);
      return;
    }
    if (table === undefined) {
      warn('dropping change frame with no table', ev.data);
      return;
    }
    // The browser mirrors the SSE `id:` field to lastEventId; keep it as the
    // resume cursor (used only by the poll fallback), guarding a non-numeric id.
    const seq = Number(ev.lastEventId);
    if (Number.isFinite(seq)) lastSeq = seq;
    invalidateTable(table);
  };

  /** A `resync` frame: the server's cursor is stale — invalidate everything. */
  const onResync = (): void => {
    if (closed) return;
    invalidateAll();
  };

  /**
   * Poll `_changes` once from the resume cursor. `resyncRequired` (HTTP 200,
   * does NOT advance the server cursor) invalidates everything and RESETS the
   * cursor to `null` so the next poll restarts at `since=0` — otherwise it would
   * loop forever re-requesting the same stale `since`. Otherwise each change
   * invalidates its table and the cursor advances to the page cursor. A fetch
   * rejection is caught+logged; the interval keeps ticking (self-heals) — a
   * path distinct from `resyncRequired`.
   */
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      const since = lastSeq ?? 0;
      const url = `${changesUrl}?since=${since}`;
      const response = await fetchFn(url, { credentials: 'include' });
      if (closed) return;
      const page = (await response.json()) as ChangesPageLike;
      if (closed) return;
      if (page.resyncRequired) {
        invalidateAll();
        lastSeq = null;
        return;
      }
      for (const change of page.changes ?? []) {
        if (typeof change.table === 'string') invalidateTable(change.table);
      }
      if (typeof page.cursor === 'number') lastSeq = page.cursor;
    } catch (error) {
      // A rejection (network down) or a bad body — logged; the interval keeps
      // ticking so the next poll self-heals.
      warn('poll failed; will retry on the next interval', error);
    }
  };

  /** Start the `_changes` poll loop — the full fallback / downgrade target. */
  const startPolling = (): void => {
    if (closed || transport === 'polling') return;
    transport = 'polling';
    pollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    // Don't keep the event loop alive solely for polling (Node/test parity).
    (pollTimer as { unref?: () => void }).unref?.();
  };

  /**
   * Connect the SSE stream. The frames are NAMED events, so `change`/`resync`
   * are wired via `addEventListener` — `onmessage` would NEVER fire for them.
   * A transient `onerror` needs no code (EventSource auto-reconnects with
   * Last-Event-ID); a FATAL error (readyState CLOSED — server 401 / route
   * disabled) downgrades to polling once and stays there.
   */
  const connectSse = (source: SmrtWebEventSource): void => {
    transport = 'sse';
    eventSource = source;
    source.addEventListener('change', onChange);
    source.addEventListener('resync', onResync);
    source.onerror = () => {
      if (closed) return;
      // Only a fatal (CLOSED) error means SSE is unavailable for good — fall
      // back to polling. A transient drop (still CONNECTING/OPEN) is handled
      // natively by the browser's reconnect; do nothing.
      if (source.readyState === EVENT_SOURCE_CLOSED) {
        // Close the dead source and stop listening to it, then downgrade. No
        // flap-back: once polling, we never re-attempt SSE.
        try {
          source.close();
        } catch {
          // ignore — already dead
        }
        eventSource = null;
        startPolling();
      }
    };
  };

  // Feature-detect ONCE. An EventSource we can construct → SSE; otherwise (or
  // if the factory yields nothing) → polling.
  const initialSource = eventSourceFactory(eventsUrl, { withCredentials });
  if (initialSource) {
    connectSse(initialSource);
  } else {
    startPolling();
  }

  return {
    get transport() {
      return transport;
    },
    registerTable(table, invalidate) {
      let set = tableInvalidators.get(table);
      if (!set) {
        set = new Set<() => void>();
        tableInvalidators.set(table, set);
      }
      set.add(invalidate);
      return () => {
        const current = tableInvalidators.get(table);
        if (!current) return;
        current.delete(invalidate);
        if (current.size === 0) tableInvalidators.delete(table);
      };
    },
    invalidateAll,
    close() {
      if (closed) return;
      closed = true;
      if (eventSource) {
        try {
          eventSource.close();
        } catch {
          // ignore — best-effort teardown
        }
        eventSource = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      tableInvalidators.clear();
      transport = 'idle';
    },
  };
}

/** Configuration for the {@link liveInvalidation} capability. */
export interface LiveInvalidationConfig {
  /** The one app-wide subscriber from {@link createSmrtWebEventSubscriber}. */
  subscriber: Pick<
    SmrtWebEventSubscriber,
    'registerTable' | 'invalidateAll' | 'transport'
  >;
  /**
   * The PHYSICAL table name this collection reads. EXPLICIT because a
   * `SmrtWebCollectionDefinition` has no physical-table field and STI children
   * share one base table — the subscriber keys signals by physical table, so a
   * guess would mis-route invalidations.
   */
  tableName: string;
}

/**
 * A thin per-collection capability that subscribes THIS collection to live
 * signals for its `tableName`. On attach it registers `ctx.invalidate` (the
 * factory's relationship-derived refetch primitive) with the shared subscriber;
 * on teardown it unregisters. All transport, reconnection, and fan-out live in
 * the {@link createSmrtWebEventSubscriber}; this capability is just the wire
 * between one collection and that one subscriber.
 */
export function liveInvalidation<TData extends object = object>(
  config: LiveInvalidationConfig,
): SmrtWebCapability<TData> {
  const { subscriber, tableName } = config;
  let unregister: (() => void) | undefined;
  return {
    name: 'live-invalidation',
    onAttach(ctx) {
      unregister = subscriber.registerTable(tableName, () => ctx.invalidate());
    },
    teardown() {
      unregister?.();
      unregister = undefined;
    },
  };
}
