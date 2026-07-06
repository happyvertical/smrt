/**
 * Live-updates subscriber tests for smrt-web (#1763, CLIENT half).
 *
 * Per the repo mocking policy ONLY the network boundary is mocked — here the
 * two transports the subscriber speaks: a fake {@link SmrtWebEventSource} the
 * test drives (dispatch a `change`/`resync`, simulate an error/close) injected
 * via `eventSourceFactory`, and a scripted `fetch` for the polling fallback.
 * The client-data engine collection, its query cache, transactions, and live
 * state are all REAL — the `liveInvalidation` capability is wired into an
 * actual `createSmrtCollection` so an incoming signal drives a real refetch.
 *
 * A `change` signal for a table stands in for "another client wrote that row"
 * (the two-client scenario): the subscriber never carries the payload, so a
 * signal is all a second session's write produces on this side. Effects are
 * fire-and-forget (invalidation schedules a background refetch), so a settled
 * effect is observed with a microtask `waitFor`, never a fixed sleep — except
 * the polling tests, which drive time explicitly with vitest fake timers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmrtWebCapabilityContext } from './capability.js';
import {
  createSmrtCollection,
  createSmrtWebClient,
  createSmrtWebEventSubscriber,
  liveInvalidation,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type SmrtWebEventSource,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ProductData {
  id?: string;
  name: string;
}

function productDefinition(
  name: string,
): SmrtWebCollectionDefinition<ProductData> {
  return {
    name,
    className: 'Product',
    endpoint: `/${name}`,
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { name: { type: 'text', required: true } },
  };
}

/**
 * A scripted stand-in for `createClient('/api/v1').products`. Resolves the way
 * the generated fetchers do (JSON payloads, never rejects on HTTP errors) and
 * counts `list()` so an invalidation-driven refetch is observable.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0, update: 0, delete: 0 };

  const fetchers: SmrtCrudFetchers = {
    list: async () => {
      calls.list += 1;
      return serverRows.map((row) => ({ ...row }));
    },
    create: async (data) => {
      calls.create += 1;
      const created = { ...data, id: `server-${serverRows.length + 1}` };
      serverRows.push(created);
      return { ...created };
    },
    update: async (id, data) => {
      calls.update += 1;
      return { ...data, id };
    },
    delete: async () => {
      calls.delete += 1;
      return true;
    },
  };

  return {
    fetchers,
    calls,
    pushServerRow(row: Record<string, unknown>) {
      serverRows.push(row);
    },
  };
}

/**
 * The minimal EventSource ReadyState constants (the DOM enum) so a fake can
 * report CONNECTING/OPEN/CLOSED without a real DOM.
 */
const READY = { CONNECTING: 0, OPEN: 1, CLOSED: 2 } as const;

/**
 * A fake {@link SmrtWebEventSource} the test fully drives. `dispatch()` fires a
 * named-event listener (mirroring `es.addEventListener('change'|'resync', …)`);
 * `simulateError()` fires `onerror` at the current readyState so a test can
 * distinguish a transient drop (readyState OPEN → auto-reconnect) from a fatal
 * close (readyState CLOSED → the subscriber's downgrade-to-polling path).
 */
class FakeEventSource implements SmrtWebEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState: number = READY.CONNECTING;
  closed = false;

  onopen: ((this: unknown, ev: unknown) => unknown) | null = null;
  onerror: ((this: unknown, ev: unknown) => unknown) | null = null;
  onmessage: ((this: unknown, ev: unknown) => unknown) | null = null;

  private readonly listeners = new Map<
    string,
    Set<(ev: { data: string; lastEventId: string }) => void>
  >();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (ev: { data: string; lastEventId: string }) => void,
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = READY.CLOSED;
  }

  /** Move to OPEN and fire onopen, as a real EventSource does on connect. */
  open(): void {
    this.readyState = READY.OPEN;
    this.onopen?.call(this, {});
  }

  /** Deliver a named event to its registered listeners. */
  dispatch(
    type: string,
    payload: { data: string; lastEventId?: string },
  ): void {
    const ev = { data: payload.data, lastEventId: payload.lastEventId ?? '' };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(ev);
    }
  }

  /**
   * Fire onerror at a chosen readyState. `fatal: true` mirrors a server 401 /
   * route-disabled (EventSource sets readyState CLOSED and stops reconnecting);
   * the default is a transient drop (readyState stays as-is — the browser
   * auto-reconnects with Last-Event-ID, no client code involved).
   */
  simulateError({ fatal = false }: { fatal?: boolean } = {}): void {
    if (fatal) this.readyState = READY.CLOSED;
    this.onerror?.call(this, {});
  }
}

/** The freshest FakeEventSource the subscriber constructed. */
function latestEventSource(): FakeEventSource {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('no FakeEventSource constructed');
  return es;
}

async function waitFor(
  predicate: () => boolean,
  { tries = 50 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

const CHANGE = (
  table: string,
  seq: number,
  extra: Record<string, unknown> = {},
) => ({
  data: JSON.stringify({
    table,
    operation: 'update',
    rowId: 'r1',
    tenantId: null,
    ...extra,
  }),
  lastEventId: String(seq),
});

const MANIFEST = (manifestHash: string) => ({
  data: JSON.stringify({ manifestHash }),
  lastEventId: '',
});

function makeUpdateStateProbe() {
  let contractSignals = 0;
  return {
    state: {
      notifyContractUpdated() {
        contractSignals += 1;
      },
    },
    get contractSignals() {
      return contractSignals;
    },
  };
}

function searchParamsOf(url: string): URLSearchParams {
  return new URL(url, 'http://smrt.local').searchParams;
}

// ---------------------------------------------------------------------------
// Test-managed lifecycle
// ---------------------------------------------------------------------------

const tracked: SmrtWebCollection<object>[] = [];
const track = <T extends object>(c: SmrtWebCollection<T>) => {
  tracked.push(c as unknown as SmrtWebCollection<object>);
  return c;
};
const subscribers: Array<{ close(): void }> = [];
const trackSub = <S extends { close(): void }>(s: S) => {
  subscribers.push(s);
  return s;
};

afterEach(async () => {
  await Promise.all(tracked.map((c) => c.cleanup()));
  tracked.length = 0;
  for (const sub of subscribers) sub.close();
  subscribers.length = 0;
  FakeEventSource.instances.length = 0;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// (1) A change signal drives the registered collection's refetch
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — SSE change signal → collection refetch', () => {
  it('a change for table X refetches the collection registered for X (two-client scenario)', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/api/v1/_events',
        changesUrl: '/api/v1/_changes',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    expect(subscriber.transport).toBe('sse');

    const collection = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    // Keep the collection "active" so an invalidation actually refetches.
    const sub = collection.subscribeChanges(() => {});
    await collection.preload();
    expect(scripted.calls.list).toBe(1);

    // A second session wrote a products row — the server pushes a signal (no
    // payload). Simulate the row already being on the server so the refetch
    // observably picks it up.
    scripted.pushServerRow({ id: 'p2', name: 'from-other-client' });
    latestEventSource().dispatch('change', CHANGE('products', 1));

    await waitFor(() => scripted.calls.list >= 2);
    await waitFor(() => collection.has('p2'));
    expect(collection.get('p2')?.name).toBe('from-other-client');

    sub.unsubscribe();
  });

  it('builds the EventSource against eventsUrl with withCredentials by default', () => {
    trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/api/v1/_events',
        changesUrl: '/api/v1/_changes',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    const es = latestEventSource();
    expect(es.url).toBe('/api/v1/_events');
    expect(es.withCredentials).toBe(true);
  });

  it('latches contract update when the server manifest hash differs (#1859)', () => {
    const update = makeUpdateStateProbe();
    trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/api/v1/_events',
        changesUrl: '/api/v1/_changes',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
        manifestHash: 'client-hash',
        updateState: update.state,
      }),
    );

    const es = latestEventSource();
    es.dispatch('manifest', MANIFEST('client-hash'));
    expect(update.contractSignals).toBe(0);

    es.dispatch('manifest', MANIFEST('server-hash'));
    expect(update.contractSignals).toBe(1);

    // The subscriber never clears the sticky signal, and later old-replica
    // frames do not flap it off during a rolling deploy.
    es.dispatch('manifest', MANIFEST('client-hash'));
    expect(update.contractSignals).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (2) A signal invalidates ONLY the signalled table
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — per-table invalidation scoping', () => {
  it('a signal for X invalidates X collections but NOT an unrelated table', async () => {
    const client = createSmrtWebClient();
    const productsBackend = makeScriptedFetchers([
      { id: 'p1', name: 'Widget' },
    ]);
    const ordersBackend = makeScriptedFetchers([{ id: 'o1', name: 'Order' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );

    const products = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: productsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const orders = track(
      createSmrtCollection(productDefinition('orders'), {
        fetchers: ordersBackend.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'orders' })],
      }),
    );
    const psub = products.subscribeChanges(() => {});
    const osub = orders.subscribeChanges(() => {});
    await Promise.all([products.preload(), orders.preload()]);
    expect(productsBackend.calls.list).toBe(1);
    expect(ordersBackend.calls.list).toBe(1);

    latestEventSource().dispatch('change', CHANGE('products', 1));

    await waitFor(() => productsBackend.calls.list >= 2);
    // Give any (erroneous) orders refetch time to fire, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(productsBackend.calls.list).toBeGreaterThanOrEqual(2);
    expect(ordersBackend.calls.list).toBe(1);

    psub.unsubscribe();
    osub.unsubscribe();
  });

  it('two collections registered for the SAME table both refetch on one signal', async () => {
    const backendA = makeScriptedFetchers([{ id: 'p1', name: 'A' }]);
    const backendB = makeScriptedFetchers([{ id: 'p1', name: 'B' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );

    const a = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: backendA.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const b = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: backendB.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const asub = a.subscribeChanges(() => {});
    const bsub = b.subscribeChanges(() => {});
    await Promise.all([a.preload(), b.preload()]);

    latestEventSource().dispatch('change', CHANGE('products', 1));

    await waitFor(() => backendA.calls.list >= 2 && backendB.calls.list >= 2);
    expect(backendA.calls.list).toBeGreaterThanOrEqual(2);
    expect(backendB.calls.list).toBeGreaterThanOrEqual(2);

    asub.unsubscribe();
    bsub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// (3) Reconnect / catch-up: replayed change still invalidates; resync → all
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — reconnect catch-up + resync', () => {
  it('a REPLAYED change (seq already seen) STILL invalidates — idempotent, not dropped', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    const collection = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const sub = collection.subscribeChanges(() => {});
    await collection.preload();

    const es = latestEventSource();
    // Live change at seq 5.
    es.dispatch('change', CHANGE('products', 5));
    await waitFor(() => scripted.calls.list >= 2);

    // Reconnect replays seq 5 (already seen) — the subscriber must NOT dedupe it
    // away; re-invalidating on a replay is safe (idempotent) and is what keeps a
    // gap from being silently missed. It fires again.
    es.dispatch('change', CHANGE('products', 5));
    await waitFor(() => scripted.calls.list >= 3);
    expect(scripted.calls.list).toBeGreaterThanOrEqual(3);

    // A brand-new seq after the gap also invalidates.
    es.dispatch('change', CHANGE('products', 6));
    await waitFor(() => scripted.calls.list >= 4);
    expect(scripted.calls.list).toBeGreaterThanOrEqual(4);

    sub.unsubscribe();
  });

  it('a resync event invalidates every registered table (cursor stale)', async () => {
    const productsBackend = makeScriptedFetchers([
      { id: 'p1', name: 'Widget' },
    ]);
    const ordersBackend = makeScriptedFetchers([{ id: 'o1', name: 'Order' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    const products = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: productsBackend.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const orders = track(
      createSmrtCollection(productDefinition('orders'), {
        fetchers: ordersBackend.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'orders' })],
      }),
    );
    const psub = products.subscribeChanges(() => {});
    const osub = orders.subscribeChanges(() => {});
    await Promise.all([products.preload(), orders.preload()]);

    latestEventSource().dispatch('resync', { data: '{}' });

    await waitFor(
      () => productsBackend.calls.list >= 2 && ordersBackend.calls.list >= 2,
    );
    expect(productsBackend.calls.list).toBeGreaterThanOrEqual(2);
    expect(ordersBackend.calls.list).toBeGreaterThanOrEqual(2);

    psub.unsubscribe();
    osub.unsubscribe();
  });

  it('a malformed change payload is dropped (logged), never thrown into the ES loop, and later signals still work', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    const collection = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [liveInvalidation({ subscriber, tableName: 'products' })],
      }),
    );
    const sub = collection.subscribeChanges(() => {});
    await collection.preload();

    const es = latestEventSource();
    // Malformed JSON must not throw out of the listener (that would break the
    // EventSource message loop) — it is caught + logged + dropped.
    expect(() =>
      es.dispatch('change', { data: 'not json{', lastEventId: '7' }),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    // A well-formed change after the bad one still invalidates.
    es.dispatch('change', CHANGE('products', 8));
    await waitFor(() => scripted.calls.list >= 2);
    expect(scripted.calls.list).toBeGreaterThanOrEqual(2);

    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// (4) Polling fallback (no EventSource) over the _changes route
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — polling fallback', () => {
  it('with no EventSource available it polls _changes and invalidates per change, advancing since=cursor', async () => {
    vi.useFakeTimers();
    try {
      // Scripted _changes fetch: first poll returns one products change +
      // cursor 12; every later poll returns an empty page echoing since.
      const pollUrls: string[] = [];
      const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        pollUrls.push(url);
        if (pollUrls.length === 1) {
          return new Response(
            JSON.stringify({
              changes: [
                {
                  seq: 12,
                  table: 'products',
                  rowId: 'r1',
                  operation: 'update',
                  tenantId: null,
                  timestamp: 't',
                },
              ],
              cursor: 12,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const since = new URL(url, 'http://x').searchParams.get('since');
        return new Response(
          JSON.stringify({ changes: [], cursor: Number(since) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/api/v1/_events',
          changesUrl: '/api/v1/_changes?mode=live',
          // Force the polling branch: no EventSource can be constructed.
          eventSourceFactory: () => undefined,
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 5000,
        }),
      );
      expect(subscriber.transport).toBe('polling');

      const collection = track(
        createSmrtCollection(productDefinition('products'), {
          fetchers: scripted.fetchers,
          staleTimeMs: 60_000,
          capabilities: [
            liveInvalidation({ subscriber, tableName: 'products' }),
          ],
        }),
      );
      const sub = collection.subscribeChanges(() => {});
      await collection.preload();
      expect(scripted.calls.list).toBe(1);

      // First poll tick: fetch a page, invalidate products.
      await vi.advanceTimersByTimeAsync(5000);
      expect(pollUrls[0]).toContain('/api/v1/_changes');
      // First poll uses since=0 (no cursor yet).
      expect(searchParamsOf(pollUrls[0]).get('since')).toBe('0');
      expect(searchParamsOf(pollUrls[0]).get('mode')).toBe('live');
      expect(searchParamsOf(pollUrls[0]).get('tables')).toBe('products');
      await waitFor(() => scripted.calls.list >= 2);

      // Next poll advances since to the returned cursor (12).
      await vi.advanceTimersByTimeAsync(5000);
      expect(searchParamsOf(pollUrls[1]).get('since')).toBe('12');

      sub.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips polling with no registered tables and sends the current table filter when registered', async () => {
    vi.useFakeTimers();
    try {
      const pollUrls: string[] = [];
      const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        pollUrls.push(String(input));
        const since = searchParamsOf(String(input)).get('since');
        return new Response(
          JSON.stringify({ changes: [], cursor: Number(since) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c?scope=tenant',
          eventSourceFactory: () => undefined,
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      expect(subscriber.transport).toBe('polling');

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).not.toHaveBeenCalled();

      const unregisterProducts = subscriber.registerTable('products', () => {});
      const unregisterOrders = subscriber.registerTable('orders', () => {});

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const params = searchParamsOf(pollUrls[0]);
      expect(params.get('scope')).toBe('tenant');
      expect(params.get('since')).toBe('0');
      expect(params.get('tables')).toBe('orders,products');

      unregisterProducts();
      unregisterOrders();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resyncRequired invalidates all + resumes polling from resyncCursor', async () => {
    vi.useFakeTimers();
    try {
      const pollUrls: string[] = [];
      const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        pollUrls.push(url);
        // Poll 1: advance the cursor to 30 with a change.
        if (pollUrls.length === 1) {
          return new Response(
            JSON.stringify({
              changes: [
                {
                  seq: 30,
                  table: 'products',
                  rowId: 'r1',
                  operation: 'update',
                  tenantId: null,
                  timestamp: 't',
                },
              ],
              cursor: 30,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Poll 2 (since=30): the server signals resyncRequired (HTTP 200) and
        // keeps cursor echoing since, but includes a fresh resyncCursor.
        if (pollUrls.length === 2) {
          return new Response(
            JSON.stringify({
              changes: [],
              cursor: 30,
              resyncRequired: true,
              resyncCursor: 120,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const since = new URL(url, 'http://x').searchParams.get('since');
        return new Response(
          JSON.stringify({ changes: [], cursor: Number(since) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c',
          eventSourceFactory: () => undefined,
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      const collection = track(
        createSmrtCollection(productDefinition('products'), {
          fetchers: scripted.fetchers,
          staleTimeMs: 60_000,
          capabilities: [
            liveInvalidation({ subscriber, tableName: 'products' }),
          ],
        }),
      );
      const sub = collection.subscribeChanges(() => {});
      await collection.preload();

      // Poll 1: since=0, cursor advances to 30.
      await vi.advanceTimersByTimeAsync(1000);
      expect(searchParamsOf(pollUrls[0]).get('since')).toBe('0');
      await waitFor(() => scripted.calls.list >= 2);

      // Poll 2: since=30, server says resyncRequired → invalidateAll +
      // advance to the current horizon.
      await vi.advanceTimersByTimeAsync(1000);
      expect(searchParamsOf(pollUrls[1]).get('since')).toBe('30');
      await waitFor(() => scripted.calls.list >= 3);

      // Poll 3: cursor resumes from resyncCursor, rather than looping on the
      // rejected cursor or going back to a pruned since=0.
      await vi.advanceTimersByTimeAsync(1000);
      expect(searchParamsOf(pollUrls[2]).get('since')).toBe('120');

      sub.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fetch REJECTION is caught+logged and the interval keeps ticking (self-heals)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let attempt = 0;
      const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
        attempt += 1;
        if (attempt === 1) throw new Error('network down');
        const since = new URL(String(input), 'http://x').searchParams.get(
          'since',
        );
        return new Response(
          JSON.stringify({ changes: [], cursor: Number(since) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c',
          eventSourceFactory: () => undefined,
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      expect(subscriber.transport).toBe('polling');
      const unregister = subscriber.registerTable('products', () => {});

      // First tick rejects — must be caught (no unhandled rejection), logged.
      await vi.advanceTimersByTimeAsync(1000);
      expect(warnSpy).toHaveBeenCalled();

      // The interval keeps ticking: the second poll runs (proves self-heal).
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// (4b) Runtime downgrade: fatal SSE error → polling (no flap-back)
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — runtime downgrade on fatal SSE error', () => {
  it('a transient error (readyState OPEN) does NOT downgrade — EventSource auto-reconnects', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ changes: [], cursor: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c',
          eventSourceFactory: (url, init) => new FakeEventSource(url, init),
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      expect(subscriber.transport).toBe('sse');

      const es = latestEventSource();
      es.open();
      // Transient drop: readyState stays OPEN. The browser reconnects natively;
      // the subscriber must NOT start polling.
      es.simulateError({ fatal: false });
      expect(subscriber.transport).toBe('sse');
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fatal error (readyState CLOSED) downgrades to polling and stays there (no flap-back)', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            changes: [],
            cursor: Number(
              new URL(String(input), 'http://x').searchParams.get('since'),
            ),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    try {
      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c',
          eventSourceFactory: (url, init) => new FakeEventSource(url, init),
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      expect(subscriber.transport).toBe('sse');
      const unregister = subscriber.registerTable('products', () => {});

      const es = latestEventSource();
      es.open();
      // Fatal: server 401 / route disabled → readyState CLOSED, ES gives up.
      es.simulateError({ fatal: true });
      // The subscriber falls back to polling — the "SSE unavailable" runtime case.
      expect(subscriber.transport).toBe('polling');
      // The dead EventSource was closed.
      expect(es.closed).toBe(true);

      // Polling is now live.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalled();
      unregister();

      // A further error must NOT flap back to SSE — it stays polling for life.
      es.simulateError({ fatal: true });
      expect(subscriber.transport).toBe('polling');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a resync event id as the polling cursor after fatal SSE downgrade', async () => {
    vi.useFakeTimers();
    const pollUrls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      pollUrls.push(String(input));
      const since = searchParamsOf(String(input)).get('since');
      return new Response(
        JSON.stringify({ changes: [], cursor: Number(since) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    try {
      const subscriber = trackSub(
        createSmrtWebEventSubscriber({
          eventsUrl: '/e',
          changesUrl: '/c',
          eventSourceFactory: (url, init) => new FakeEventSource(url, init),
          fetchFn: fetchFn as unknown as typeof fetch,
          pollIntervalMs: 1000,
        }),
      );
      const invalidate = vi.fn();
      const unregister = subscriber.registerTable('products', invalidate);

      const es = latestEventSource();
      es.open();
      es.dispatch('resync', { data: '{}', lastEventId: '42' });
      expect(invalidate).toHaveBeenCalledTimes(1);

      es.simulateError({ fatal: true });
      expect(subscriber.transport).toBe('polling');

      await vi.advanceTimersByTimeAsync(1000);
      expect(searchParamsOf(pollUrls[0]).get('since')).toBe('42');
      unregister();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// (5) liveInvalidation capability unit
// ---------------------------------------------------------------------------

describe('liveInvalidation — capability wiring', () => {
  it('onAttach registers the table; teardown unregisters exactly once', () => {
    const registered: Array<{ table: string }> = [];
    let unregisterCalls = 0;
    // A stand-in subscriber recording register/unregister — this test asserts
    // the capability's wiring in isolation, without a real EventSource.
    const fakeSubscriber = {
      transport: 'idle' as const,
      registerTable(table: string, _invalidate: () => void) {
        registered.push({ table });
        return () => {
          unregisterCalls += 1;
        };
      },
      invalidateAll() {},
      close() {},
    };

    const capability = liveInvalidation({
      subscriber: fakeSubscriber,
      tableName: 'widgets',
    });

    const ctx = {
      invalidate: () => {},
    } as unknown as SmrtWebCapabilityContext<object>;

    expect(registered).toHaveLength(0);
    capability.onAttach?.(ctx);
    expect(registered).toEqual([{ table: 'widgets' }]);

    capability.teardown?.(ctx);
    expect(unregisterCalls).toBe(1);
    // A defensive second teardown does not throw and does not double-unregister
    // (the capability drops its handle after the first call).
    capability.teardown?.(ctx);
    expect(unregisterCalls).toBe(1);
  });

  it('the registered invalidate calls ctx.invalidate (the refetch primitive)', () => {
    let invalidateCalls = 0;
    let capturedInvalidate: (() => void) | undefined;
    const fakeSubscriber = {
      transport: 'idle' as const,
      registerTable(_table: string, invalidate: () => void) {
        capturedInvalidate = invalidate;
        return () => {};
      },
      invalidateAll() {},
      close() {},
    };

    const capability = liveInvalidation({
      subscriber: fakeSubscriber,
      tableName: 'widgets',
    });
    const ctx = {
      invalidate: () => {
        invalidateCalls += 1;
      },
    } as unknown as SmrtWebCapabilityContext<object>;

    capability.onAttach?.(ctx);
    capturedInvalidate?.();
    expect(invalidateCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (6) Error isolation — one throwing invalidator does not block a sibling
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — invalidator error isolation', () => {
  it('one throwing invalidator does not block a sibling registered for the same table', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );

    let goodCalls = 0;
    subscriber.registerTable('products', () => {
      throw new Error('bad invalidator');
    });
    subscriber.registerTable('products', () => {
      goodCalls += 1;
    });

    // One signal for products fires both — the throwing one is caught+logged,
    // the sibling still runs.
    latestEventSource().dispatch('change', CHANGE('products', 1));
    expect(goodCalls).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('invalidateAll isolates a throwing invalidator across tables', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );

    let goodCalls = 0;
    subscriber.registerTable('products', () => {
      throw new Error('bad');
    });
    subscriber.registerTable('orders', () => {
      goodCalls += 1;
    });

    subscriber.invalidateAll();
    expect(goodCalls).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('unregister stops a table invalidator from firing on later signals', () => {
    const subscriber = trackSub(
      createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: (url, init) => new FakeEventSource(url, init),
      }),
    );
    let calls = 0;
    const unregister = subscriber.registerTable('products', () => {
      calls += 1;
    });

    const es = latestEventSource();
    es.dispatch('change', CHANGE('products', 1));
    expect(calls).toBe(1);

    unregister();
    es.dispatch('change', CHANGE('products', 2));
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (7) close() tears down transport + clears registrations
// ---------------------------------------------------------------------------

describe('createSmrtWebEventSubscriber — close()', () => {
  it('close() closes the EventSource and stops further signals from invalidating', () => {
    const subscriber = createSmrtWebEventSubscriber({
      eventsUrl: '/e',
      changesUrl: '/c',
      eventSourceFactory: (url, init) => new FakeEventSource(url, init),
    });
    let calls = 0;
    subscriber.registerTable('products', () => {
      calls += 1;
    });
    const es = latestEventSource();

    subscriber.close();
    expect(es.closed).toBe(true);

    // Registrations cleared: a late signal to the (now-closed) source does not
    // invalidate.
    es.dispatch('change', CHANGE('products', 1));
    expect(calls).toBe(0);
  });

  it('close() clears the polling interval so no further polls fire', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(
        async (input: RequestInfo | URL) =>
          new Response(
            JSON.stringify({
              changes: [],
              cursor: Number(
                new URL(String(input), 'http://x').searchParams.get('since'),
              ),
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );
      const subscriber = createSmrtWebEventSubscriber({
        eventsUrl: '/e',
        changesUrl: '/c',
        eventSourceFactory: () => undefined,
        fetchFn: fetchFn as unknown as typeof fetch,
        pollIntervalMs: 1000,
      });
      expect(subscriber.transport).toBe('polling');
      const unregister = subscriber.registerTable('products', () => {});

      await vi.advanceTimersByTimeAsync(1000);
      const callsBeforeClose = fetchFn.mock.calls.length;
      expect(callsBeforeClose).toBeGreaterThanOrEqual(1);
      unregister();

      subscriber.close();
      await vi.advanceTimersByTimeAsync(5000);
      // No further polls after close().
      expect(fetchFn.mock.calls.length).toBe(callsBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
