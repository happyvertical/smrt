/**
 * `persistDataSurface` (#3021) — the data-surface twin of `persistCollection`,
 * over real fake-indexeddb.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DurableStoreKey,
  durableStoreNamespace,
  wipeDurableStore,
} from './durable-store.js';
import { openSnapshotStore } from './persistence/snapshot-store.js';
import {
  type PersistedDataSurface,
  persistDataSurface,
} from './persistence.js';

let counter = 0;
function key(identityId = 'employee-1'): DurableStoreKey {
  counter += 1;
  return {
    apiBase: '/api',
    tenantId: 'tenant-1',
    identityId,
    manifestHash: `surface-${counter}`,
  };
}

const identity = { surfaceId: 'my-punches', kind: 'list' as const };

const open: PersistedDataSurface[] = [];
function surface(
  config: Parameters<typeof persistDataSurface>[0],
): PersistedDataSurface<{ id: string; at: string }> {
  const s = persistDataSurface<{ id: string; at: string }>(config);
  open.push(s as PersistedDataSurface);
  return s;
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.dispose();
  vi.unstubAllGlobals();
});

describe('persistDataSurface', () => {
  it('round-trips rows across a remount and the last save wins', async () => {
    const k = key();
    const first = surface({ namespace: k, identity, debounceMs: 5 });
    expect(await first.load()).toBeUndefined();
    first.save([{ id: 'p1', at: '08:00' }]);
    first.save([
      { id: 'p1', at: '08:00' },
      { id: 'p2', at: '12:00' },
    ]);
    await first.dispose();

    const second = surface({ namespace: k, identity });
    expect(await second.load()).toEqual([
      { id: 'p1', at: '08:00' },
      { id: 'p2', at: '12:00' },
    ]);
  });

  it('dispose flushes a pending debounced save', async () => {
    const k = key();
    const first = surface({ namespace: k, identity, debounceMs: 60_000 });
    first.save([{ id: 'p1', at: '08:00' }]);
    await first.dispose();
    expect(await surface({ namespace: k, identity }).load()).toEqual([
      { id: 'p1', at: '08:00' },
    ]);
  });

  it('segregates by principal and by surface identity', async () => {
    const mine = key('employee-1');
    const s = surface({ namespace: mine, identity, debounceMs: 0 });
    s.save([{ id: 'p1', at: '08:00' }]);
    await s.flush();

    const otherPrincipal = { ...mine, identityId: 'employee-2' };
    expect(
      await surface({ namespace: otherPrincipal, identity }).load(),
    ).toBeUndefined();
    expect(
      await surface({
        namespace: mine,
        identity: { ...identity, subject: { type: 'Employee', id: 'e9' } },
      }).load(),
    ).toBeUndefined();
  });

  it('never collides with a persisted collection of the same name', async () => {
    const k = key();
    const s = surface({
      namespace: k,
      identity: { surfaceId: 'products', kind: 'table' },
      debounceMs: 0,
    });
    s.save([{ id: 'p1', at: '08:00' }]);
    await s.flush();
    const store = await openSnapshotStore(durableStoreNamespace(k));
    try {
      expect(await store.load('products')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('is cleared by wipeDurableStore', async () => {
    const k = key();
    const s = surface({ namespace: k, identity, debounceMs: 0 });
    s.save([{ id: 'p1', at: '08:00' }]);
    await s.flush();
    await wipeDurableStore(durableStoreNamespace(k));
    expect(await s.load()).toBeUndefined();
  });

  it('a wipe makes existing handles inert, including a save pending at the wipe', async () => {
    const k = key();
    const s = surface({ namespace: k, identity, debounceMs: 60_000 });
    await s.load(); // store open and registered
    s.save([{ id: 'p1', at: '08:00' }]);
    await wipeDurableStore(durableStoreNamespace(k));
    await s.flush();
    s.save([{ id: 'p2', at: '09:00' }]);
    await s.dispose();
    expect(await surface({ namespace: k, identity }).load()).toBeUndefined();
  });

  it('a handle created after a wipe persists, and a second wipe still clears it', async () => {
    const k = key();
    const ns = durableStoreNamespace(k);
    // Keep the shared store open across both wipes, as a mounted app would.
    const holder = surface({
      namespace: k,
      identity: { ...identity, surfaceId: 'other' },
    });
    await holder.load();
    await wipeDurableStore(ns);

    const s = surface({ namespace: k, identity, debounceMs: 60_000 });
    s.save([{ id: 'p2', at: '09:00' }]);
    await s.flush();
    expect(await s.load()).toEqual([{ id: 'p2', at: '09:00' }]);

    s.save([{ id: 'p3', at: '10:00' }]); // pending across the second wipe
    await wipeDurableStore(ns);
    await s.dispose();
    expect(await surface({ namespace: k, identity }).load()).toBeUndefined();
  });

  it('a wipe issued right after a post-wipe acquire still clears its save', async () => {
    const k = key();
    const ns = durableStoreNamespace(k);
    const holder = surface({
      namespace: k,
      identity: { ...identity, surfaceId: 'other' },
    });
    await holder.load();
    await wipeDurableStore(ns);

    const s = surface({ namespace: k, identity, debounceMs: 60_000 });
    s.save([{ id: 'p2', at: '09:00' }]);
    await wipeDurableStore(ns); // no intervening await for registration
    await s.dispose();
    expect(await surface({ namespace: k, identity }).load()).toBeUndefined();
  });

  it('a wipe issued before the store opens still clears it and makes the handle inert', async () => {
    const k = key();
    const first = surface({ namespace: k, identity, debounceMs: 0 });
    first.save([{ id: 'p1', at: '08:00' }]);
    await first.dispose();

    const s = surface({ namespace: k, identity, debounceMs: 0 });
    await wipeDurableStore(durableStoreNamespace(k)); // before any await on s
    s.save([{ id: 'p2', at: '09:00' }]);
    await s.flush();
    expect(await s.load()).toBeUndefined();
    await s.dispose();
    expect(await surface({ namespace: k, identity }).load()).toBeUndefined();
  });

  it('rejects an identity without a surfaceId', () => {
    expect(() =>
      persistDataSurface({
        namespace: key(),
        identity: { surfaceId: '', kind: 'list' },
      }),
    ).toThrow(TypeError);
  });

  it('degrades to non-persistent without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = surface({ namespace: key(), identity, debounceMs: 0 });
    s.save([{ id: 'p1', at: '08:00' }]);
    await s.flush();
    expect(await s.load()).toBeUndefined();
  });
});
