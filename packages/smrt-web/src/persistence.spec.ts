/**
 * Integration tests for the durable persistence capability (#1764) — the
 * end-to-end acceptance scenarios.
 *
 * Per the SMRT testing policy the ONLY mocked boundary is the network (a
 * scripted list fetcher); the durable store is a REAL `fake-indexeddb`, and the
 * collection under test is the REAL `createSmrtCollection` factory with the REAL
 * capability seam — so warmStart → seed → revalidate and the write-back
 * subscription persist path are exercised as one flow.
 *
 * ## The reload model (same as offline-outbox.spec.ts)
 *
 * fake-indexeddb persists per DB NAME for the life of the process, so a "reload"
 * is modeled by tearing a collection down (cleanup) and constructing a NEW one
 * against the SAME durable-store namespace — the new capability re-opens the
 * same IndexedDB backing and sees the prior snapshot, exactly as a fresh tab
 * would. A manifest-hash change is modeled by reconstructing against a namespace
 * whose `manifestHash` differs, which lands on a DIFFERENT database.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';
import type { DurableResource } from './durable-store.js';
import {
  createSmrtCollection,
  type DurableStoreKey,
  durableStoreNamespace,
  newLocalId,
  persistCollection,
  registerDurableResource,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  wipeDurableStore,
} from './index.js';

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

/**
 * A scripted list/create fetcher over a mutable backing store, counting calls so
 * a test can prove warmStart suppressed the first list() and that a later
 * revalidation observably fetched.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0 };
  return {
    calls,
    setServerRows(rows: Array<Record<string, unknown>>) {
      serverRows.length = 0;
      serverRows.push(...rows);
    },
    fetchers: {
      list: async () => {
        calls.list += 1;
        return serverRows.map((row) => ({ ...row }));
      },
      create: async (data: Record<string, unknown>) => {
        calls.create += 1;
        const created = { ...data, id: `server-${serverRows.length + 1}` };
        serverRows.push(created);
        return { ...created };
      },
    },
  };
}

let keyCounter = 0;
/** A unique base durable-store key per test so IndexedDB dbs never collide. */
function uniqueBaseKey(): Omit<DurableStoreKey, 'manifestHash'> {
  keyCounter += 1;
  return { apiBase: `/api/v1/test-${keyCounter}` };
}

async function waitFor(
  predicate: () => boolean,
  { tries = 60 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

const tracked: SmrtWebCollection<object>[] = [];
function track<T extends object>(
  c: SmrtWebCollection<T>,
): SmrtWebCollection<T> {
  tracked.push(c as unknown as SmrtWebCollection<object>);
  return c;
}
afterEach(async () => {
  await Promise.all(tracked.map((c) => c.cleanup()));
  tracked.length = 0;
});

describe('persistCollection (#1764) — warm-start then revalidate', () => {
  it('persists rows on write, then a reloaded collection warm-starts from them (no first list()) and revalidates in the background', async () => {
    const base = uniqueBaseKey();
    const namespace: DurableStoreKey = {
      ...base,
      manifestHash: 'shapeA0000000000',
    };

    // First session: seed from server, then the write-back persists the rows.
    const first = makeScriptedFetchers([
      { id: 'p1', name: 'Widget' },
      { id: 'p2', name: 'Gadget' },
    ]);
    const sessionOne = track(
      createSmrtCollection(productDefinition(), {
        fetchers: first.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace,
            debounceMs: 0,
          }),
        ],
      }),
    );
    // Keep it live so the write-back subscription observes the loaded rows.
    const sub = sessionOne.subscribeChanges(() => {});
    await sessionOne.preload();
    expect(first.calls.list).toBe(1); // nothing on disk yet → fetched
    // The engine loaded 2 rows; wait for the debounced (0ms) write-back to flush.
    await waitFor(() => sessionOne.size === 2);
    // Give the flush a couple of ticks to commit to IndexedDB.
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.unsubscribe();
    await sessionOne.cleanup();

    // Second session (reload): a NEW collection on the SAME namespace warm-starts
    // from the persisted snapshot and RENDERS STALE INSTANTLY, then revalidates
    // in the background. staleTime 0 means the warm seed is immediately stale so
    // a background revalidation is scheduled; a DEFERRED fetch lets us observe
    // the stale render BEFORE the fresh rows land.
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let listCalls = 0;
    const freshRows = [
      { id: 'p1', name: 'Widget-fresh' },
      { id: 'p2', name: 'Gadget' },
      { id: 'p3', name: 'NewOne' },
    ];
    const sessionTwo = track(
      createSmrtCollection(productDefinition(), {
        fetchers: {
          list: async () => {
            listCalls += 1;
            await fetchGate; // hold the revalidation open
            return freshRows.map((r) => ({ ...r }));
          },
          create: async (d) => d,
        },
        staleTimeMs: 0,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const sub2 = sessionTwo.subscribeChanges(() => {});
    await sessionTwo.preload();

    // Warm-start seeded the persisted rows: the STALE render is present now,
    // before the (still-blocked) revalidation resolves — the instant-paint AC.
    expect(sessionTwo.get('p1')?.name).toBe('Widget');
    expect(sessionTwo.size).toBe(2);

    // A background revalidation is in flight (staleTime 0 → the seed is stale).
    await waitFor(() => listCalls >= 1);

    // Release it: the fresh server rows replace the stale ones — the SWR half.
    releaseFetch?.();
    await waitFor(() => sessionTwo.get('p1')?.name === 'Widget-fresh');
    await waitFor(() => sessionTwo.has('p3'));
    expect(sessionTwo.get('p3')?.name).toBe('NewOne');
    sub2.unsubscribe();
  });
});

describe('persistCollection (#1764) — manifest-hash change drops caches', () => {
  it('a different manifestHash lands on a fresh namespace: no snapshot found, empty warmStart, fresh fetch, no stale-schema rows', async () => {
    const base = uniqueBaseKey();
    const nsA: DurableStoreKey = { ...base, manifestHash: 'hashAAAAAAAAAAAA' };
    const nsB: DurableStoreKey = { ...base, manifestHash: 'hashBBBBBBBBBBBB' };

    // Persist under hashA.
    const s1 = makeScriptedFetchers([{ id: 'p1', name: 'OldSchema' }]);
    const underA = track(
      createSmrtCollection(productDefinition(), {
        fetchers: s1.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace: nsA,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const subA = underA.subscribeChanges(() => {});
    await underA.preload();
    await waitFor(() => underA.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    subA.unsubscribe();
    await underA.cleanup();

    // Reconstruct under hashB (a contract-changing deploy). The persisted
    // snapshot is in the hashA database and simply isn't found → warmStart
    // returns empty → a fresh fetch runs, and NONE of the old-schema rows hydrate
    // before it. This IS the "drop persisted caches on a manifest-hash change" AC.
    const s2 = makeScriptedFetchers([{ id: 'p9', name: 'NewSchema' }]);
    const underB = track(
      createSmrtCollection(productDefinition(), {
        fetchers: s2.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace: nsB,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const subB = underB.subscribeChanges(() => {});
    await underB.preload();

    // A fresh fetch ran (no warm seed suppressed it) and no stale row is present.
    expect(s2.calls.list).toBe(1);
    expect(underB.has('p1')).toBe(false); // the old-schema row never hydrated
    expect(underB.get('p9')?.name).toBe('NewSchema');
    subB.unsubscribe();
  });
});

describe('persistCollection (#1764) — namespace segregation', () => {
  it("two identities on one device never read each other's persisted rows", async () => {
    keyCounter += 1;
    const apiBase = `/api/v1/seg-${keyCounter}`;
    const alice: DurableStoreKey = {
      apiBase,
      identityId: 'alice',
      manifestHash: 'shape00000000000',
    };
    const bob: DurableStoreKey = {
      apiBase,
      identityId: 'bob',
      manifestHash: 'shape00000000000',
    };
    // Distinct namespaces (different identity) → distinct IndexedDB databases.
    expect(durableStoreNamespace(alice)).not.toBe(durableStoreNamespace(bob));

    // Alice persists her rows.
    const aliceServer = makeScriptedFetchers([
      { id: 'a1', name: 'AliceSecret' },
    ]);
    const aliceColl = track(
      createSmrtCollection(productDefinition(), {
        fetchers: aliceServer.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace: alice,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const aliceSub = aliceColl.subscribeChanges(() => {});
    await aliceColl.preload();
    await waitFor(() => aliceColl.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    aliceSub.unsubscribe();
    await aliceColl.cleanup();

    // Bob's collection warm-starts from HIS namespace — Alice's row is not there,
    // so his first read fetches fresh and never shows AliceSecret.
    const bobServer = makeScriptedFetchers([{ id: 'b1', name: 'BobData' }]);
    const bobColl = track(
      createSmrtCollection(productDefinition(), {
        fetchers: bobServer.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace: bob,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const bobSub = bobColl.subscribeChanges(() => {});
    await bobColl.preload();

    expect(bobServer.calls.list).toBe(1); // no warm seed from Alice
    expect(bobColl.has('a1')).toBe(false);
    expect(bobColl.get('b1')?.name).toBe('BobData');
    bobSub.unsubscribe();
  });
});

describe('persistCollection (#1764) — logout wipe clears persistence AND outbox', () => {
  it('one wipeDurableStore clears the persisted snapshot AND a co-registered outbox resource under the shared namespace', async () => {
    const namespace: DurableStoreKey = {
      ...uniqueBaseKey(),
      manifestHash: 'shape00000000000',
    };
    const ns = durableStoreNamespace(namespace);

    // Persist a collection's rows.
    const server = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const coll = track(
      createSmrtCollection(productDefinition(), {
        fetchers: server.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const sub = coll.subscribeChanges(() => {});
    await coll.preload();
    await waitFor(() => coll.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Co-register an outbox STUB under the SAME namespace (mirrors #1762 sharing
    // the namespace). One wipe must clear both.
    let outboxCleared = false;
    const outboxStub: DurableResource = {
      kind: 'outbox',
      clear: async () => {
        outboxCleared = true;
      },
    };
    registerDurableResource(ns, outboxStub);

    // Logout: wipe the shared namespace.
    await wipeDurableStore(ns);

    // The outbox stub was cleared by the same call...
    expect(outboxCleared).toBe(true);

    // ...and the persisted snapshot is gone: a reloaded collection on the SAME
    // namespace finds nothing and fetches fresh (would have warm-started to size
    // 1 if the snapshot had survived).
    sub.unsubscribe();
    await coll.cleanup();

    const afterWipe = makeScriptedFetchers([{ id: 'p2', name: 'PostWipe' }]);
    const reopened = track(
      createSmrtCollection(productDefinition(), {
        fetchers: afterWipe.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const sub2 = reopened.subscribeChanges(() => {});
    await reopened.preload();
    expect(afterWipe.calls.list).toBe(1); // snapshot wiped → fresh fetch
    expect(reopened.has('p1')).toBe(false);
    sub2.unsubscribe();
  });
});

describe('persistCollection (#1764) — opt-in per model', () => {
  it('a collection with NO persistence capability writes nothing to disk (byte-for-byte non-persistent)', async () => {
    const namespace: DurableStoreKey = {
      ...uniqueBaseKey(),
      manifestHash: 'shape00000000000',
    };

    // A collection with NO capabilities — it must not persist.
    const server = makeScriptedFetchers([{ id: 'p1', name: 'Ephemeral' }]);
    const plain = track(
      createSmrtCollection(productDefinition(), {
        fetchers: server.fetchers,
        staleTimeMs: 60_000,
        // no capabilities
      }),
    );
    const sub = plain.subscribeChanges(() => {});
    await plain.preload();
    await waitFor(() => plain.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.unsubscribe();
    await plain.cleanup();

    // Now a PERSISTED collection on the same namespace warm-starts: it must find
    // NOTHING (the plain collection wrote no snapshot) and fetch fresh.
    const server2 = makeScriptedFetchers([{ id: 'p1', name: 'FromServer' }]);
    const persisted = track(
      createSmrtCollection(productDefinition(), {
        fetchers: server2.fetchers,
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({
            collection: 'products',
            namespace,
            debounceMs: 0,
          }),
        ],
      }),
    );
    const sub2 = persisted.subscribeChanges(() => {});
    await persisted.preload();
    expect(server2.calls.list).toBe(1); // no snapshot from the non-persistent run
    expect(persisted.get('p1')?.name).toBe('FromServer');
    sub2.unsubscribe();
  });
});
