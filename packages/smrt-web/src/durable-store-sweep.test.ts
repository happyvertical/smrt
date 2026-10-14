/**
 * Shared-device sweep (#3234): `listDurableNamespaces` enumerates namespaces by
 * name only, and `pruneDurableNamespace` ages out a namespace's queued items
 * without mounting its queue, replaying, or attaching a transport. Real
 * fake-indexeddb backs the stores; the Web Locks manager is the scripted
 * boundary where a test needs one.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DurableStoreKey,
  durableStoreNamespace,
  listDurableNamespaces,
  type OutboxCommand,
  offlineCommandQueue,
  pruneDurableNamespace,
  type SyncStateEvent,
} from './index.js';
import { openDurableOutboxQueue } from './offline/durable-queue.js';
import { outboxLeaderLockName } from './offline/engine.js';
import { openSnapshotStore } from './persistence/snapshot-store.js';

let counter = 0;
function uniqueKey(identityId: string): DurableStoreKey {
  counter += 1;
  return {
    apiBase: '/api/v1',
    tenantId: 'tenant-1',
    identityId,
    manifestHash: `sweep-${counter}-${Math.random().toString(36).slice(2)}`,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13);

/** Seed outbox rows with explicit ages, closing the handle afterwards. */
async function seed(
  namespace: string,
  rows: Array<{ ageMs: number; transport?: string }>,
): Promise<void> {
  const queue = await openDurableOutboxQueue(namespace);
  const now = vi.spyOn(Date, 'now');
  try {
    for (const [index, row] of rows.entries()) {
      now.mockReturnValue(NOW - row.ageMs);
      await queue.enqueue({
        itemId: `item-${index}`,
        object: row.transport ?? 'forms',
        op: 'create',
        id: `row-${index}`,
        payload: { signature: 'data:image/png;base64,AAAA' },
        ...(row.transport === undefined ? {} : { transport: row.transport }),
      });
    }
  } finally {
    now.mockRestore();
    queue.close();
  }
}

async function remaining(namespace: string): Promise<string[]> {
  const queue = await openDurableOutboxQueue(namespace);
  try {
    return (await queue.all()).map((row) => row.itemId);
  } finally {
    queue.close();
  }
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((info) => info.name ?? '');
}

async function waitFor(predicate: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('waitFor: predicate never became true');
}

/** A Web Locks double where `held` names are taken by another replayer. */
function stubLocks(held: Set<string>) {
  const requests: Array<{ name: string; options: unknown }> = [];
  const locks = {
    request: async (
      name: string,
      options: unknown,
      callback: (lock: unknown) => Promise<unknown>,
    ) => {
      requests.push({ name, options });
      return callback(held.has(name) ? null : { name, mode: 'exclusive' });
    },
  };
  vi.stubGlobal('navigator', { locks });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listDurableNamespaces', () => {
  it('returns each smrt-web namespace once, by name, from every durable database', async () => {
    const outbox = durableStoreNamespace(uniqueKey('ana'));
    const persisted = durableStoreNamespace(uniqueKey('bo'));
    await seed(outbox, [{ ageMs: 0 }]);
    // A namespace with both an outbox and a snapshot database lists once.
    (await openSnapshotStore(outbox)).close();
    (await openSnapshotStore(persisted)).close();
    const foreign = indexedDB.open('someone-elses-db');
    await new Promise((r) => {
      foreign.onsuccess = r;
    });
    foreign.result.close();

    const names = await listDurableNamespaces();
    expect(names.filter((name) => name === outbox)).toHaveLength(1);
    expect(names).toContain(persisted);
    expect(names).not.toContain('someone-elses-db');
    expect(names.every((name) => name.startsWith('smrt-web:'))).toBe(true);
    expect(names.some((name) => name.endsWith('::snapshots'))).toBe(false);
    expect([...names].sort()).toEqual(names);
  });
});

describe('pruneDurableNamespace', () => {
  it('removes only items older than the cutoff and returns counts, not contents', async () => {
    const namespace = durableStoreNamespace(uniqueKey('ana'));
    await seed(namespace, [
      { ageMs: 10 * DAY },
      { ageMs: 1 * DAY },
      { ageMs: 8 * DAY, transport: 'safety_forms' },
    ]);

    const result = await pruneDurableNamespace(namespace, {
      olderThan: new Date(NOW - 7 * DAY),
    });

    expect(result).toEqual({ removed: 2, skipped: 0 });
    expect(await remaining(namespace)).toEqual(['item-1']);
  });

  it('accepts epoch milliseconds and leaves other namespaces untouched', async () => {
    const ana = durableStoreNamespace(uniqueKey('ana'));
    const bo = durableStoreNamespace(uniqueKey('bo'));
    await seed(ana, [{ ageMs: 10 * DAY }]);
    await seed(bo, [{ ageMs: 10 * DAY }]);

    await expect(
      pruneDurableNamespace(ana, { olderThan: NOW - 7 * DAY }),
    ).resolves.toEqual({ removed: 1, skipped: 0 });
    expect(await remaining(ana)).toEqual([]);
    expect(await remaining(bo)).toEqual(['item-0']);
  });

  it('never creates a database for an unknown namespace', async () => {
    const namespace = durableStoreNamespace(uniqueKey('ghost'));
    await expect(
      pruneDurableNamespace(namespace, { olderThan: NOW }),
    ).resolves.toEqual({ removed: 0, skipped: 0 });
    expect(await databaseNames()).not.toContain(namespace);
  });

  it('rejects a non-namespace string and an invalid cutoff', async () => {
    const namespace = durableStoreNamespace(uniqueKey('ana'));
    await expect(
      pruneDurableNamespace('someone-elses-db', { olderThan: NOW }),
    ).rejects.toThrow(TypeError);
    await expect(
      pruneDurableNamespace(`${namespace}::snapshots`, { olderThan: NOW }),
    ).rejects.toThrow(TypeError);
    await expect(
      pruneDurableNamespace(namespace, { olderThan: Number.NaN }),
    ).rejects.toThrow(TypeError);
    await expect(
      pruneDurableNamespace(namespace, {
        olderThan: new Date('not a date'),
      }),
    ).rejects.toThrow(TypeError);
  });

  it('skips a route whose leader lock a live replayer holds, and prunes the idle ones', async () => {
    const namespace = durableStoreNamespace(uniqueKey('ana'));
    await seed(namespace, [
      { ageMs: 10 * DAY },
      { ageMs: 10 * DAY, transport: 'safety_forms' },
      { ageMs: 10 * DAY, transport: 'safety_forms' },
    ]);
    const requests = stubLocks(
      new Set([outboxLeaderLockName(namespace, 'transport:safety_forms')]),
    );

    const result = await pruneDurableNamespace(namespace, { olderThan: NOW });

    expect(result).toEqual({ removed: 1, skipped: 2 });
    expect(await remaining(namespace)).toEqual(['item-1', 'item-2']);
    expect(requests).toEqual([
      {
        name: `smrt-web-outbox-leader:${namespace}`,
        options: { mode: 'exclusive', ifAvailable: true },
      },
      {
        name: `smrt-web-outbox-leader:${namespace}:transport:safety_forms`,
        options: { mode: 'exclusive', ifAvailable: true },
      },
    ]);
  });

  it("sweeps a signed-out person's queue on a shared device without replaying it", async () => {
    // Person A queues a safety form offline; its replay fails and stays queued.
    const keyA = uniqueKey('person-a');
    const transportA = vi.fn(async (_command: OutboxCommand) => {
      throw new Error('offline');
    });
    const states: SyncStateEvent[] = [];
    const queueA = offlineCommandQueue({
      name: 'safety_forms',
      namespace: keyA,
      backoff: { initialDelayMs: 100_000, maxDelayMs: 100_000 },
      random: () => 1,
      transport: transportA,
      onSyncStateChange: (event) => states.push(event),
    });
    const itemId = await queueA.enqueue({ payload: { photo: 'blob' } });
    expect(itemId).toBeTypeOf('string');
    await waitFor(() => states.some((s) => s.state === 'pending' && s.error));
    const namespaceA = durableStoreNamespace(keyA);

    // While A's queue is still mounted here, it holds its route's leader
    // lock, so a prune refuses to delete from under it.
    await expect(
      pruneDurableNamespace(namespaceA, { olderThan: Date.now() + DAY }),
    ).resolves.toEqual({ removed: 0, skipped: 1 });

    // A signs out; B signs in on the same browser and sweeps.
    await queueA.dispose();
    const callsBeforeSweep = transportA.mock.calls.length;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    expect(await listDurableNamespaces()).toContain(namespaceA);
    await expect(
      pruneDurableNamespace(namespaceA, { olderThan: Date.now() + DAY }),
    ).resolves.toEqual({ removed: 1, skipped: 0 });

    expect(transportA).toHaveBeenCalledTimes(callsBeforeSweep);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await remaining(namespaceA)).toEqual([]);
  });

  it('without Web Locks, refuses a namespace whose queue this page has mounted', async () => {
    vi.stubGlobal('navigator', {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = uniqueKey('person-a');
    const namespace = durableStoreNamespace(key);
    await seed(namespace, [{ ageMs: 10 * DAY }]);
    const queue = offlineCommandQueue({
      name: 'safety_forms',
      namespace: key,
      transport: async () => ({ status: 'applied' }),
    });
    try {
      await expect(
        pruneDurableNamespace(namespace, { olderThan: NOW }),
      ).resolves.toEqual({ removed: 0, skipped: 1 });
    } finally {
      await queue.dispose();
      vi.mocked(console.warn).mockRestore();
    }
    await expect(
      pruneDurableNamespace(namespace, { olderThan: NOW }),
    ).resolves.toEqual({ removed: 1, skipped: 0 });
  });
});
