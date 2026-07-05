/**
 * Unit tests for the persistence capability's DEGRADE path (#1764).
 *
 * These deliberately run WITHOUT a working IndexedDB (the global is removed for
 * the test) to prove the "IndexedDB unavailable → behave as non-persistent, warn
 * once, never throw" posture — matching the outbox's probe posture. The happy
 * path (real fake-indexeddb, real engine) lives in persistence.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSmrtCollection,
  type DurableStoreKey,
  newLocalId,
  persistCollection,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
} from './index.js';

interface ProductData {
  id?: string;
  name: string;
}

function productDefinition(): SmrtWebCollectionDefinition<ProductData> {
  return {
    name: 'products',
    className: 'Product',
    endpoint: '/products',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { name: { type: 'text', required: true } },
  };
}

const namespace: DurableStoreKey = {
  apiBase: '/api/v1/degrade',
  manifestHash: 'shape00000000000',
};

// Remove IndexedDB for these tests, restoring whatever was there after. Setting
// it to `undefined` is enough: the capability's probe reads `globalThis.indexedDB`
// and treats any falsy value as "unavailable", so it degrades to non-persistent.
let savedIndexedDb: unknown;
beforeEach(() => {
  savedIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
  (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
});
afterEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = savedIndexedDb;
  vi.restoreAllMocks();
});

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

describe('persistCollection (#1764) — IndexedDB unavailable degrade', () => {
  it('warm-starts to nothing and fetches normally when IndexedDB is absent, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let listCalls = 0;
    const collection = track(
      createSmrtCollection(productDefinition(), {
        fetchers: {
          list: async () => {
            listCalls += 1;
            return [{ id: 'p1', name: 'Widget' }];
          },
          create: async (d) => ({ ...d, id: 'server-1' }),
        },
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({ collection: 'products', namespace }),
        ],
      }),
    );
    const sub = collection.subscribeChanges(() => {});
    // Construction + preload must not throw even though IndexedDB is gone.
    await expect(collection.preload()).resolves.toBeUndefined();
    // No durable snapshot → the normal fetch ran and served the rows.
    expect(listCalls).toBe(1);
    expect(collection.get('p1')?.name).toBe('Widget');
    // A mutation still works (non-persistent, but the collection is fully live):
    // the optimistic row is visible synchronously and the write settles without
    // rejecting (the create fetcher ran normally).
    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'Gadget' });
    expect(collection.has(localId)).toBe(true);
    await expect(tx.isPersisted.promise).resolves.toBeDefined();
    // The degrade was announced via console.warn (once).
    expect(warn).toHaveBeenCalled();
    sub.unsubscribe();
  });

  it('a collection with the capability is still byte-compatible: no error path leaks', async () => {
    const collection = track(
      createSmrtCollection(productDefinition(), {
        fetchers: {
          list: async () => [],
          create: async (d) => d,
        },
        staleTimeMs: 60_000,
        capabilities: [
          persistCollection({ collection: 'products', namespace }),
        ],
      }),
    );
    await expect(collection.preload()).resolves.toBeUndefined();
    // cleanup() must also resolve cleanly with no store to close.
    await expect(collection.cleanup()).resolves.toBeUndefined();
    tracked.length = 0; // already cleaned up
  });
});
