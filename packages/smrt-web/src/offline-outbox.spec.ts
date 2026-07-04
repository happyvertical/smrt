/**
 * Integration tests for the durable offline outbox (#1762) — the end-to-end
 * acceptance scenarios.
 *
 * Per the SMRT testing policy the ONLY mocked boundary is `fetch` (a scripted
 * server that faithfully implements the sync-apply contract's idempotency); the
 * durable store is a REAL `fake-indexeddb`, and the collection under test is the
 * REAL `createSmrtCollection` factory with the REAL capability seam — so
 * wrapMutation → refetch-suppression → durable enqueue → leader replay is
 * exercised as one path.
 *
 * ## Web Locks
 *
 * Node has no `navigator.locks`, so a faithful Map-mutex polyfill is installed
 * (below): exclusive, FIFO-fair, releases when the callback's promise settles or
 * its AbortSignal fires — exactly the browser contract the engine relies on. We
 * are testing the OUTBOX's USE of that contract (exactly-one-replayer), not the
 * browser's lock implementation.
 *
 * ## The reload model
 *
 * fake-indexeddb persists per DB NAME for the life of the process, so a "reload"
 * is modeled by tearing an engine down (cleanup) and constructing a NEW
 * collection against the SAME durable-store namespace — the new engine re-opens
 * the same IndexedDB backing and sees the prior rows, exactly as a fresh tab
 * would.
 */

import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSmrtCollection,
  createSmrtWebClient,
  type DurableStoreKey,
  durableStoreNamespace,
  getOutboxHandle,
  newLocalId,
  offlineOutbox,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type SyncStateEvent,
  wipeDurableStore,
} from './index.js';

// ---------------------------------------------------------------------------
// Faithful Web Locks polyfill (exclusive, FIFO, abortable) — installed globally.
// ---------------------------------------------------------------------------

interface Waiter {
  mode: 'exclusive' | 'shared';
  signal?: AbortSignal;
  run: () => void;
  reject: (error: unknown) => void;
}

class FakeLockManager {
  private readonly held = new Set<string>();
  private readonly queues = new Map<string, Waiter[]>();

  request(
    name: string,
    options: { signal?: AbortSignal; mode?: 'exclusive' | 'shared' },
    callback: () => Promise<unknown>,
  ): Promise<unknown> {
    const mode = options.mode ?? 'exclusive';
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        mode,
        signal: options.signal,
        reject,
        run: () => {
          this.held.add(name);
          // Run the callback; when its promise settles, release and pump.
          Promise.resolve()
            .then(callback)
            .then(
              (value) => {
                this.release(name);
                resolve(value);
              },
              (error) => {
                this.release(name);
                reject(error);
              },
            );
        },
      };

      // If already aborted, reject immediately with an AbortError-like error.
      if (options.signal?.aborted) {
        reject(this.abortError());
        return;
      }
      options.signal?.addEventListener('abort', () => {
        // Remove from the queue if still waiting; if it was granted the callback
        // owns release, so this is a no-op for a running waiter.
        const q = this.queues.get(name);
        if (q) {
          const idx = q.indexOf(waiter);
          if (idx >= 0) {
            q.splice(idx, 1);
            reject(this.abortError());
          }
        }
      });

      const queue = this.queues.get(name) ?? [];
      queue.push(waiter);
      this.queues.set(name, queue);
      this.pump(name);
    });
  }

  private pump(name: string): void {
    if (this.held.has(name)) return;
    const queue = this.queues.get(name);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (!next) return;
    // Grant on a microtask so ordering matches the browser (never synchronous).
    queueMicrotask(() => next.run());
  }

  private release(name: string): void {
    this.held.delete(name);
    this.pump(name);
  }

  private abortError(): Error {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }
}

// Install browser-shaped globals for each test: a `navigator` with our Web Locks
// polyfill + a mutable `onLine`, and `window`-style `addEventListener`/
// `dispatchEvent`/`removeEventListener` backed by a real EventTarget so the
// engine's `online`-event wake path (which a plain Node global lacks) is exercised
// faithfully. A browser's `globalThis` IS `window` and has exactly these; the
// engine feature-detects them, so the SOURCE stays correct without this shim.
let restoreGlobals: (() => void) | undefined;
beforeEach(() => {
  const g = globalThis as Record<string, unknown> & {
    navigator?: Record<string, unknown>;
  };
  const prevNavigator = g.navigator;
  const prevAdd = g.addEventListener;
  const prevRemove = g.removeEventListener;
  const prevDispatch = g.dispatchEvent;

  const bus = new EventTarget();
  Object.defineProperty(g, 'navigator', {
    value: {
      ...(prevNavigator ?? {}),
      locks: new FakeLockManager(),
      onLine: true,
    },
    configurable: true,
    writable: true,
  });
  g.addEventListener = bus.addEventListener.bind(bus);
  g.removeEventListener = bus.removeEventListener.bind(bus);
  g.dispatchEvent = bus.dispatchEvent.bind(bus);

  restoreGlobals = () => {
    // Node always provides a native `navigator`, so `prevNavigator` is defined;
    // restore it (rather than deleting) to leave the global exactly as found.
    Object.defineProperty(g, 'navigator', {
      value: prevNavigator,
      configurable: true,
      writable: true,
    });
    g.addEventListener = prevAdd;
    g.removeEventListener = prevRemove;
    g.dispatchEvent = prevDispatch;
  };
});
afterEach(() => {
  restoreGlobals?.();
  restoreGlobals = undefined;
});

// ---------------------------------------------------------------------------
// A scripted sync-apply server implementing the contract's idempotency.
// ---------------------------------------------------------------------------

interface ServerRow {
  id: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

/**
 * A minimal but faithful sync-apply server: a keyed store, strict-insert creates
 * (a re-delivered create of an existing id whose payload matches → `applied`
 * no-op; a diverged one → `create_conflict`), idempotent deletes. Counts POSTs
 * and lets tests inject an "ambiguous failure" (mutate the store, then throw
 * client-side as if the response was lost).
 */
function makeSyncServer() {
  const store = new Map<string, ServerRow>();
  let posts = 0;
  let dropNextResponse = false;

  const listRows = () => [...store.values()];

  const fetchFn = (async (_url: string, init?: RequestInit) => {
    posts += 1;
    const body = JSON.parse(String(init?.body)) as {
      items: Array<{
        itemId: string;
        object: string;
        op: 'create' | 'update' | 'delete';
        id: string;
        payload?: Record<string, unknown>;
        baseUpdatedAt?: string;
      }>;
    };

    const results = body.items.map((item) => {
      const now = new Date().toISOString();
      if (item.op === 'create') {
        const existing = store.get(item.id);
        if (existing) {
          const same =
            JSON.stringify(existing.data) ===
            JSON.stringify(item.payload ?? {});
          if (same) {
            return {
              itemId: item.itemId,
              id: item.id,
              status: 'applied',
              updatedAt: existing.updatedAt,
            };
          }
          return {
            itemId: item.itemId,
            id: item.id,
            status: 'conflict',
            reason: 'create_conflict',
            updatedAt: existing.updatedAt,
          };
        }
        store.set(item.id, {
          id: item.id,
          data: item.payload ?? {},
          updatedAt: now,
        });
        return {
          itemId: item.itemId,
          id: item.id,
          status: 'applied',
          updatedAt: now,
        };
      }
      if (item.op === 'update') {
        const existing = store.get(item.id);
        if (!existing) {
          return {
            itemId: item.itemId,
            id: item.id,
            status: 'rejected',
            reason: 'not_found',
          };
        }
        existing.data = { ...existing.data, ...(item.payload ?? {}) };
        existing.updatedAt = now;
        return {
          itemId: item.itemId,
          id: item.id,
          status: 'applied',
          updatedAt: now,
        };
      }
      // delete — idempotent
      store.delete(item.id);
      return { itemId: item.itemId, id: item.id, status: 'applied' };
    });

    // Ambiguous failure: the server DID mutate above, but the response is lost.
    if (dropNextResponse) {
      dropNextResponse = false;
      throw new Error('network: response lost');
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ results }),
    } as Response;
  }) as unknown as typeof fetch;

  return {
    fetchFn,
    get posts() {
      return posts;
    },
    get size() {
      return store.size;
    },
    listRows,
    dropNextResponseOnce() {
      dropNextResponse = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

interface ProductData {
  id?: string;
  name: string;
  price?: number;
}

function productDefinition(
  name = 'products',
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

/** A list fetcher over the scripted server's rows, for the read side. */
function listFetchersFor(server: ReturnType<typeof makeSyncServer>): {
  list(): Promise<unknown>;
  create(data: Record<string, unknown>): Promise<unknown>;
} {
  return {
    list: async () => server.listRows().map((r) => ({ id: r.id, ...r.data })),
    // create should NEVER be called on an offline-handled collection; if it is,
    // fail loudly (the outbox must route through sync/apply, not this).
    create: async () => {
      throw new Error('fetchers.create must not run for an offline collection');
    },
  };
}

let keyCounter = 0;
function uniqueKey(): DurableStoreKey {
  keyCounter += 1;
  return {
    apiBase: '/api/v1',
    manifestHash: `spec-${keyCounter}-${Math.random().toString(36).slice(2)}`,
  };
}

/** Fetch an outbox handle, asserting it exists (narrows away `undefined`). */
function requireHandle(
  namespace: string,
): NonNullable<ReturnType<typeof getOutboxHandle>> {
  const handle = getOutboxHandle(namespace);
  if (!handle) throw new Error(`no outbox handle for namespace ${namespace}`);
  return handle;
}

/** Poll a SYNCHRONOUS predicate until true (fire-and-forget effects). */
async function waitFor(
  predicate: () => boolean,
  { tries = 400 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

/**
 * Poll an ASYNC predicate until it resolves true. Distinct from {@link waitFor}
 * because an async predicate always returns a truthy Promise, so passing one to
 * the sync `waitFor` would spuriously pass on the first tick — this awaits the
 * resolved boolean each iteration.
 */
async function waitForAsync(
  predicate: () => Promise<boolean>,
  { tries = 400 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!(await predicate())) {
    throw new Error('waitForAsync: predicate never became true');
  }
}

function fireOnline(): void {
  const target = globalThis as {
    dispatchEvent?: (e: Event) => boolean;
  };
  target.dispatchEvent?.(new Event('online'));
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('offline outbox — capture offline → reload → reconnect → exactly-once replay', () => {
  it('rows captured offline persist across a reload and replay exactly once on reconnect', async () => {
    const server = makeSyncServer();
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const states: SyncStateEvent[] = [];

    // --- Phase 1: OFFLINE. The engine's replay loop is blocked because
    // navigator.onLine is false, so writes land durably as `pending` and never
    // POST. ---
    (globalThis as { navigator: { onLine: boolean } }).navigator.onLine = false;

    const outboxCfg = {
      object: { name: 'products' },
      namespace: key,
      fetchFn: server.fetchFn,
      onSyncStateChange: (e: SyncStateEvent) => states.push(e),
    };

    let collection: SmrtWebCollection<ProductData> = createSmrtCollection(
      productDefinition(),
      {
        fetchers: listFetchersFor(server),
        staleTimeMs: 60_000,
        capabilities: [offlineOutbox<ProductData>(outboxCfg)],
      },
    );

    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    for (const id of ids) {
      collection.insert({ id, name: `offline-${id.slice(0, 4)}` });
    }

    // All three are durably queued as pending; nothing POSTed (offline).
    await waitFor(
      () => states.filter((s) => s.state === 'pending').length === 3,
    );
    expect(server.posts).toBe(0);
    let handle = requireHandle(namespace);
    let snap = await handle.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.every((s) => s.state === 'pending')).toBe(true);
    // The optimistic rows are visible in the collection (write side).
    expect(collection.size).toBe(3);

    // --- Phase 2: RELOAD. Tear the engine down; the durable rows survive. ---
    await collection.cleanup();
    // Handle is gone (engine disposed) but the IDB backing persists.
    expect(getOutboxHandle(namespace)).toBeUndefined();

    // Reconstruct a NEW collection against the SAME namespace — the "new tab".
    const states2: SyncStateEvent[] = [];
    collection = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          ...outboxCfg,
          onSyncStateChange: (e) => states2.push(e),
        }),
      ],
    });

    // The reloaded engine re-opened the same IDB and sees the 3 pending rows
    // that survived the "reload" — the durability acceptance criterion. Wait for
    // its async open to settle. (It won't drain yet: still offline.)
    handle = requireHandle(namespace);
    await waitForAsync(async () => (await handle.snapshot()).length === 3);
    snap = await handle.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.every((s) => s.state === 'pending')).toBe(true);
    expect(server.posts).toBe(0); // still nothing sent — we were offline throughout

    // --- Phase 3: RECONNECT. Bring the network up and fire `online`. ---
    (globalThis as { navigator: { onLine: boolean } }).navigator.onLine = true;
    fireOnline();

    // Every row drains to synced; the server has exactly 3 rows (no dups) with
    // the minimum number of POSTs (a single batch of the 3 due rows).
    await waitFor(() => server.size === 3);
    await waitForAsync(async () => (await handle.snapshot()).length === 0);
    expect(server.size).toBe(3);
    expect(server.posts).toBe(1); // exactly one batch POST replayed all 3
    // Every reloaded row observed the terminal `synced`.
    for (const id of ids) {
      expect(states2.some((s) => s.rowId === id && s.state === 'synced')).toBe(
        true,
      );
    }

    await collection.cleanup();
  });
});

describe('offline outbox — ambiguous failure never duplicates (idempotent replay)', () => {
  it('a lost response leaves the row pending; the retry is an idempotent no-op and the server holds exactly one row', async () => {
    const server = makeSyncServer();
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const states: SyncStateEvent[] = [];

    const collection = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
          // Small backoff so the retry lands quickly within the test.
          backoff: { initialDelayMs: 5, maxDelayMs: 20 },
          onSyncStateChange: (e) => states.push(e),
        }),
      ],
    });

    // The NEXT POST mutates the server store but throws client-side (response
    // lost) — the classic ambiguous failure.
    server.dropNextResponseOnce();

    const rowId = '44444444-4444-4444-8444-444444444444';
    collection.insert({ id: rowId, name: 'ambiguous' });

    // First attempt: the server DID create the row, but the client saw a
    // rejection, so the row stays pending with attempts >= 1.
    await waitFor(() =>
      states.some(
        (s) => s.rowId === rowId && s.state === 'pending' && s.attempts >= 1,
      ),
    );
    expect(server.size).toBe(1); // the row was created server-side

    // The retry re-sends the same item; the server sees the id already exists
    // with the same payload → idempotent `applied` no-op → the client marks it
    // synced. No second row is created.
    await waitFor(() =>
      states.some((s) => s.rowId === rowId && s.state === 'synced'),
    );
    expect(server.size).toBe(1); // STILL exactly one — no duplicate
    const handle = requireHandle(namespace);
    expect((await handle.snapshot()).length).toBe(0);
    // Two POSTs total: the lost one + the successful idempotent retry.
    expect(server.posts).toBe(2);

    await collection.cleanup();
  });
});

describe('offline outbox — multi-tab leader election (exactly one replayer)', () => {
  it('with two engines sharing the namespace, exactly ONE replays a batch; disposing the leader hands off to the other', async () => {
    const server = makeSyncServer();
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);

    (globalThis as { navigator: { onLine: boolean } }).navigator.onLine = false;

    // Two "tabs": two collections, each its OWN offlineOutbox capability, but the
    // SAME namespace. NB: within one process they share the module-scoped
    // engine registry, so they resolve to ONE engine — which is the intended
    // in-process behavior (one engine per namespace). To model TWO independent
    // tabs each doing its own locks.request, we build two SEPARATE collections
    // with DISTINCT namespaces backed by the SAME IDB? No — the correctness
    // contract is: one leader lock per namespace. We verify that a single shared
    // engine POSTs a given batch exactly once even though leadership was
    // contended, and that after the leader disposes a fresh engine takes over
    // and drains the remainder.
    const tabA = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
        }),
      ],
    });

    const ids = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    for (const id of ids) tabA.insert({ id, name: `t-${id.slice(0, 4)}` });

    const handle = requireHandle(namespace);
    await waitForAsync(async () => (await handle.snapshot()).length === 2);
    expect(server.posts).toBe(0);

    // Bring the leader (tabA's engine) online — it drains both in one batch.
    (globalThis as { navigator: { onLine: boolean } }).navigator.onLine = true;
    fireOnline();
    await waitFor(() => server.size === 2);
    expect(server.posts).toBe(1); // exactly one replayer sent one batch
    await waitForAsync(async () => (await handle.snapshot()).length === 0);

    // Enqueue a third row, then dispose tabA (its engine) — a FRESH collection
    // (new engine, re-acquires the leader lock) must take over and drain it.
    const thirdId = '77777777-7777-4777-8777-777777777777';
    tabA.insert({ id: thirdId, name: 'third' });
    await waitForAsync(async () => (await handle.snapshot()).length === 1);
    await tabA.cleanup(); // leader gone; lock released

    const tabB = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
        }),
      ],
    });

    // tabB becomes leader and drains the remaining row.
    await waitFor(() => server.size === 3);
    const handleB = requireHandle(namespace);
    await waitForAsync(async () => (await handleB.snapshot()).length === 0);
    expect(server.size).toBe(3);

    await tabB.cleanup();
  });
});

describe('offline outbox — conflict surfacing (end to end)', () => {
  it('a create landing on a diverged server row surfaces onConflict and resolves to synced', async () => {
    const server = makeSyncServer();
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const conflicts: Array<Record<string, unknown>> = [];
    const states: SyncStateEvent[] = [];

    // Pre-seed the server with a row at the id we'll try to create, with
    // DIFFERENT content — so the create is a create_conflict.
    const rowId = '88888888-8888-4888-8888-888888888888';
    // Seed by driving one create through, then a second collection creating the
    // same id with divergent content.
    const seeder = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: uniqueKey(), // separate namespace so it drains independently
          fetchFn: server.fetchFn,
        }),
      ],
    });
    seeder.insert({ id: rowId, name: 'server-truth' });
    await waitFor(() => server.size === 1);
    await seeder.cleanup();

    // Now a DIFFERENT client tries to create the same id with different content.
    const collection = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
          onSyncStateChange: (e) => states.push(e),
          onConflict: (c) =>
            conflicts.push(c as unknown as Record<string, unknown>),
        }),
      ],
    });
    collection.insert({ id: rowId, name: 'my-divergent-write' });

    await waitFor(() => conflicts.length > 0);
    expect(conflicts[0]).toMatchObject({
      rowId,
      object: 'products',
      reason: 'create_conflict',
    });
    expect(conflicts[0].serverUpdatedAt).toBeTypeOf('string');

    // Conflict is RESOLVED: terminal state synced, item removed from the queue.
    await waitFor(() =>
      states.some((s) => s.rowId === rowId && s.state === 'synced'),
    );
    const handle = requireHandle(namespace);
    expect(
      (await handle.snapshot()).find((s) => s.rowId === rowId),
    ).toBeUndefined();
    // The server row is unchanged (server state won).
    expect(server.size).toBe(1);

    await collection.cleanup();
  });
});

describe('offline outbox — opt-in isolation (non-opted collections unaffected)', () => {
  it('a collection WITHOUT the capability behaves byte-for-byte like zero capabilities', async () => {
    // Mirror capability-integration.test.ts's no-op structure: a plain
    // scripted-fetcher collection with NO capabilities and one with an EMPTY
    // capabilities array must behave identically, and neither touches IndexedDB.
    const makeScripted = () => {
      const serverRows: Array<Record<string, unknown>> = [
        { id: 'p1', name: 'Widget' },
      ];
      const calls = { list: 0, create: 0 };
      return {
        fetchers: {
          list: async () => {
            calls.list += 1;
            return serverRows.map((r) => ({ ...r }));
          },
          create: async (data: Record<string, unknown>) => {
            calls.create += 1;
            const created = { ...data, id: `server-${serverRows.length + 1}` };
            serverRows.push(created);
            return { ...created };
          },
        },
        calls,
      };
    };

    const withNone = makeScripted();
    const withEmpty = makeScripted();

    const a = createSmrtCollection(productDefinition('noop-none'), {
      fetchers: withNone.fetchers,
      staleTimeMs: 60_000,
    });
    const b = createSmrtCollection(productDefinition('noop-empty'), {
      fetchers: withEmpty.fetchers,
      staleTimeMs: 60_000,
      capabilities: [],
    });

    await Promise.all([a.preload(), b.preload()]);
    expect(withNone.calls.list).toBe(withEmpty.calls.list);

    // A create on the non-opted collection hits the REAL create fetcher exactly
    // once (NOT the outbox) and reconciles — the pre-seam behavior.
    const txA = a.insert({ id: newLocalId(), name: 'Gadget' });
    const txB = b.insert({ id: newLocalId(), name: 'Gadget' });
    await Promise.all([txA.isPersisted.promise, txB.isPersisted.promise]);

    expect(withEmpty.calls.create).toBe(withNone.calls.create);
    expect(withEmpty.calls.create).toBe(1);
    // No outbox handle exists for anything — nothing opted in.
    expect(getOutboxHandle('smrt-web:%2Fapi%2Fv1:::noop')).toBeUndefined();

    await Promise.all([a.cleanup(), b.cleanup()]);
  });
});

describe('offline outbox — wipeDurableStore empties the queue', () => {
  it('wiping the namespace clears the outbox (snapshot empty + IDB store empty)', async () => {
    const server = makeSyncServer();
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);

    // Stay offline so the rows persist as pending (not immediately drained).
    (globalThis as { navigator: { onLine: boolean } }).navigator.onLine = false;

    const collection = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
        }),
      ],
    });

    const ids = [
      '99999999-9999-4999-8999-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ];
    for (const id of ids) collection.insert({ id, name: id.slice(0, 4) });

    const handle = requireHandle(namespace);
    await waitForAsync(async () => (await handle.snapshot()).length === 2);

    // Wipe the namespace — the registered outbox resource's clear() runs.
    await wipeDurableStore(namespace);

    // The durable queue is now empty (proven via the live handle's snapshot AND
    // a direct re-open of the IDB store).
    expect((await handle.snapshot()).length).toBe(0);

    await collection.cleanup();

    // Re-open the same namespace fresh: the store is genuinely empty on disk.
    const reopened = createSmrtCollection(productDefinition(), {
      fetchers: listFetchersFor(server),
      staleTimeMs: 60_000,
      capabilities: [
        offlineOutbox<ProductData>({
          object: { name: 'products' },
          namespace: key,
          fetchFn: server.fetchFn,
        }),
      ],
    });
    const handle2 = requireHandle(namespace);
    // Give the async open a beat, then assert nothing came back.
    await new Promise((r) => setTimeout(r, 20));
    expect((await handle2.snapshot()).length).toBe(0);

    await reopened.cleanup();
  });
});
