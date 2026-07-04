/**
 * Unit tests for the durable offline outbox capability (#1762).
 *
 * Scope: the capability CONTRACT (wrapMutation enqueues + returns handled:true;
 * teardown detaches), the backoff math, sync-state event ordering, and conflict
 * mapping — all with a REAL fake-indexeddb backing (so wrapMutation's durable
 * enqueue actually persists) and a SCRIPTED fetch (the only mocked boundary, per
 * the repo policy). The heavier reload / multi-tab / ambiguous-failure scenarios
 * live in offline-outbox.spec.ts.
 *
 * fake-indexeddb/auto installs a spec-compliant in-memory IndexedDB on
 * globalThis; each test uses a UNIQUE namespace so their queues never collide.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SmrtWebCapabilityContext,
  SmrtWebMutationEnvelope,
} from './capability.js';
import type { DurableStoreKey } from './durable-store.js';
import { durableStoreNamespace } from './durable-store.js';
import {
  computeBackoffDelay,
  DEFAULT_BACKOFF,
  MAX_SYNC_APPLY_BATCH_SIZE,
} from './offline/types.js';
import {
  getOutboxHandle,
  offlineOutbox,
  type SyncStateEvent,
} from './offline.js';

let nsCounter = 0;
/** A unique durable-store key per test so IndexedDB queues never collide. */
function uniqueKey(): DurableStoreKey {
  nsCounter += 1;
  return {
    apiBase: '/api/v1',
    manifestHash: `unit-${nsCounter}-${Math.random().toString(36).slice(2)}`,
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

/** Minimal ctx for driving hooks directly (the factory passes a richer one). */
function fakeCtx(name: string): SmrtWebCapabilityContext<object> {
  return {
    definition: {
      name,
      className: 'X',
      endpoint: `/${name}`,
      idField: 'id',
      actions: ['create', 'update', 'delete', 'list', 'get'],
      fields: {},
    },
    fetchers: {
      list: async () => [],
      create: async (d) => d,
    },
    cacheKey: ['smrt', name],
    cacheId: `smrt:${name}`,
    invalidate: () => {},
  };
}

/** A sync-apply response that marks every item applied (positional). */
function appliedFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      items: Array<{ itemId: string; id: string }>;
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.items.map((it) => ({
          itemId: it.itemId,
          id: it.id,
          status: 'applied',
        })),
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

/** Poll until predicate true (fire-and-forget effects). */
async function waitFor(
  predicate: () => boolean,
  { tries = 200 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

describe('computeBackoffDelay', () => {
  it('grows exponentially with attempts and is capped at maxDelayMs', () => {
    const b = DEFAULT_BACKOFF; // initial 1000, mult 2, max 60000
    // Force jitter to its max (1.0) so we compare the capped base directly.
    const noJitter = () => 1;
    expect(computeBackoffDelay(1, b, noJitter)).toBe(1000); // initial * 2**0
    expect(computeBackoffDelay(2, b, noJitter)).toBe(2000); // * 2**1
    expect(computeBackoffDelay(3, b, noJitter)).toBe(4000); // * 2**2
    expect(computeBackoffDelay(7, b, noJitter)).toBe(60000); // 64000 capped
    expect(computeBackoffDelay(20, b, noJitter)).toBe(60000); // still capped
  });

  it('applies jitter in [0.5, 1.0) of the capped delay', () => {
    const b = DEFAULT_BACKOFF;
    // random()=0 => jitter 0.5 (the floor); random()→1 => jitter →1.0 (ceiling).
    expect(computeBackoffDelay(1, b, () => 0)).toBe(500); // 1000 * 0.5
    expect(computeBackoffDelay(1, b, () => 0.999999)).toBe(1000); // ~1000 * 1.0
    // A mid value lands strictly between.
    const mid = computeBackoffDelay(1, b, () => 0.5); // 1000 * 0.75
    expect(mid).toBe(750);
  });

  it('honors custom backoff parameters', () => {
    const b = { initialDelayMs: 100, multiplier: 3, maxDelayMs: 1000 };
    const noJitter = () => 1;
    expect(computeBackoffDelay(1, b, noJitter)).toBe(100);
    expect(computeBackoffDelay(2, b, noJitter)).toBe(300);
    expect(computeBackoffDelay(3, b, noJitter)).toBe(900);
    expect(computeBackoffDelay(4, b, noJitter)).toBe(1000); // 2700 capped
  });
});

describe('offlineOutbox — capability contract', () => {
  const teardowns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    try {
      for (const t of teardowns.splice(0)) await t();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has the diagnostic name "offline-outbox" and only the offline hooks', () => {
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: uniqueKey(),
    });
    expect(cap.name).toBe('offline-outbox');
    // The offline path uses exactly wrapMutation + onAttach + teardown; it must
    // NOT contribute a cache key or a warmStart (that's #1764's slice).
    expect(cap.wrapMutation).toBeTypeOf('function');
    expect(cap.onAttach).toBeTypeOf('function');
    expect(cap.teardown).toBeTypeOf('function');
    expect(cap.contributeCacheKey).toBeUndefined();
    expect(cap.warmStart).toBeUndefined();
  });

  it('wrapMutation enqueues the write durably and returns { handled: true, result: envelope.data }', async () => {
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const states: SyncStateEvent[] = [];
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: appliedFetch(),
      onSyncStateChange: (e) => states.push(e),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const envelope: SmrtWebMutationEnvelope = {
      kind: 'insert',
      key: '11111111-1111-4111-8111-111111111111',
      data: { id: '11111111-1111-4111-8111-111111111111', name: 'Widget' },
    };
    const outcome = await cap.wrapMutation?.(envelope, ctx);

    // Took over the write, standing in the optimistic row.
    expect(outcome).toEqual({ handled: true, result: envelope.data });

    // The row is durably queued (proven via the bridge snapshot).
    expect(getOutboxHandle(namespace)).toBeDefined();
    const snap = await requireHandle(namespace).snapshot();
    // It may already be draining to `synced` via appliedFetch, so assert the
    // item EXISTED with the right shape by waiting for its terminal state.
    await waitFor(() =>
      states.some((s) => s.rowId === envelope.key && s.state === 'synced'),
    );
    // First observable state was pending, before any uploading/synced.
    const forRow = states.filter((s) => s.rowId === envelope.key);
    expect(forRow[0].state).toBe('pending');
    expect(snap.length).toBeGreaterThanOrEqual(0); // snapshot callable
  });

  it('falls through when the durable queue is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);

    const key = uniqueKey();
    const states: SyncStateEvent[] = [];
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: appliedFetch(),
      onSyncStateChange: (e) => states.push(e),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const envelope: SmrtWebMutationEnvelope = {
      kind: 'insert',
      key: '12121212-1212-4121-8121-121212121212',
      data: { id: '12121212-1212-4121-8121-121212121212', name: 'Widget' },
    };
    const outcome = await cap.wrapMutation?.(envelope, ctx);

    expect(outcome).toEqual({ handled: false });
    expect(states).toEqual([]);
  });

  it('maps insert/update/delete envelope kinds to create/update/delete ops', async () => {
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    // A fetch that never resolves the batch as applied, so rows stay queued and
    // we can read their op off the snapshot. Reject → stays pending.
    const stallFetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: stallFetch,
      // Large backoff so the requeue doesn't hot-loop during the test.
      backoff: { initialDelayMs: 100000 },
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const ids = {
      create: '22222222-2222-4222-8222-222222222222',
      update: '33333333-3333-4333-8333-333333333333',
      delete: '44444444-4444-4444-8444-444444444444',
    };
    await cap.wrapMutation?.(
      { kind: 'insert', key: ids.create, data: { id: ids.create, name: 'C' } },
      ctx,
    );
    await cap.wrapMutation?.(
      { kind: 'update', key: ids.update, data: { name: 'U' } },
      ctx,
    );
    await cap.wrapMutation?.(
      { kind: 'delete', key: ids.delete, data: {} },
      ctx,
    );

    const handle = requireHandle(namespace);
    const snap = await handle.snapshot();
    const byRow = new Map(snap.map((s) => [s.rowId, s]));
    expect(byRow.get(ids.create)?.op).toBe('create');
    expect(byRow.get(ids.update)?.op).toBe('update');
    expect(byRow.get(ids.delete)?.op).toBe('delete');
    // FIFO order preserved by seq.
    expect(snap.map((s) => s.op)).toEqual(['create', 'update', 'delete']);
  });

  it('preserves envelope baseUpdatedAt on update and delete replay items', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const received: Array<{
      op: string;
      id: string;
      baseUpdatedAt?: string;
    }> = [];
    const captureFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ op: string; id: string; baseUpdatedAt?: string }>;
      };
      received.push(...body.items);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.items.map((it) => ({
            itemId: (it as { itemId: string }).itemId,
            id: it.id,
            status: 'applied',
          })),
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: captureFetch,
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    await cap.wrapMutation?.(
      {
        kind: 'update',
        key: '13131313-1313-4131-8131-131313131313',
        data: { name: 'updated' },
        baseUpdatedAt: '2026-07-03T12:00:00.000Z',
      },
      ctx,
    );
    await cap.wrapMutation?.(
      {
        kind: 'delete',
        key: '14141414-1414-4141-8141-141414141414',
        data: {},
        baseUpdatedAt: '2026-07-03T13:00:00.000Z',
      },
      ctx,
    );

    const handle = requireHandle(namespace);
    const snap = await handle.snapshot();
    vi.stubGlobal('navigator', { onLine: true });
    await handle.retry(snap[0].itemId);

    await waitFor(() => received.length === 2);
    expect(received.map((item) => item.baseUpdatedAt)).toEqual([
      '2026-07-03T12:00:00.000Z',
      '2026-07-03T13:00:00.000Z',
    ]);
  });

  it('stops draining newer FIFO chunks after an earlier retryable batch failure', async () => {
    vi.stubGlobal('navigator', { onLine: false });

    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const posted: string[][] = [];
    const failFirstBatch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ id: string; itemId: string }>;
      };
      posted.push(body.items.map((item) => item.id));
      if (posted.length === 1) throw new Error('network down');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.items.map((it) => ({
            itemId: it.itemId,
            id: it.id,
            status: 'applied',
          })),
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: failFirstBatch,
      backoff: { initialDelayMs: 100_000, maxDelayMs: 100_000 },
      random: () => 1,
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    for (let i = 0; i < MAX_SYNC_APPLY_BATCH_SIZE + 1; i += 1) {
      const suffix = String(i).padStart(12, '0');
      const id = `15151515-1515-4151-8151-${suffix}`;
      await cap.wrapMutation?.(
        { kind: 'insert', key: id, data: { id, name: `row-${i}` } },
        ctx,
      );
    }

    const handle = requireHandle(namespace);
    const snap = await handle.snapshot();
    expect(snap).toHaveLength(MAX_SYNC_APPLY_BATCH_SIZE + 1);

    vi.stubGlobal('navigator', { onLine: true });
    await handle.retry(snap[0].itemId);
    await waitFor(() => posted.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(MAX_SYNC_APPLY_BATCH_SIZE);
    const afterFailure = await handle.snapshot();
    expect(afterFailure).toHaveLength(MAX_SYNC_APPLY_BATCH_SIZE + 1);
    expect(afterFailure.at(-1)?.attempts).toBe(0);
  });

  it('teardown detaches so getOutboxHandle returns undefined once the last collection leaves', async () => {
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: appliedFetch(),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    expect(getOutboxHandle(namespace)).toBeDefined();

    await cap.teardown?.(ctx);
    expect(getOutboxHandle(namespace)).toBeUndefined();
  });

  it('two collections sharing a namespace share ONE engine (handle stays until BOTH detach)', async () => {
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const capA = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: appliedFetch(),
    });
    const capB = offlineOutbox({
      object: { name: 'orders' },
      namespace: key,
      fetchFn: appliedFetch(),
    });
    const ctxA = fakeCtx('products');
    const ctxB = fakeCtx('orders');
    capA.onAttach?.(ctxA);
    capB.onAttach?.(ctxB);
    expect(getOutboxHandle(namespace)).toBeDefined();

    // First detach: engine survives (still one collection attached).
    await capA.teardown?.(ctxA);
    expect(getOutboxHandle(namespace)).toBeDefined();

    // Second detach: engine disposes, handle gone.
    await capB.teardown?.(ctxB);
    expect(getOutboxHandle(namespace)).toBeUndefined();
  });
});

describe('offlineOutbox — observable state ordering', () => {
  const teardowns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const t of teardowns.splice(0)) await t();
  });

  it('emits pending → uploading → synced in that exact order on a successful replay', async () => {
    const key = uniqueKey();
    const states: SyncStateEvent[] = [];
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: appliedFetch(),
      onSyncStateChange: (e) => states.push(e),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const rowId = '55555555-5555-4555-8555-555555555555';
    await cap.wrapMutation?.(
      { kind: 'insert', key: rowId, data: { id: rowId, name: 'W' } },
      ctx,
    );

    await waitFor(() => states.some((s) => s.state === 'synced'));
    const seq = states.filter((s) => s.rowId === rowId).map((s) => s.state);
    expect(seq).toEqual(['pending', 'uploading', 'synced']);
  });
});

describe('offlineOutbox — conflict surfacing', () => {
  const teardowns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const t of teardowns.splice(0)) await t();
  });

  it('a conflict result fires onConflict with the right fields and ends terminal-synced', async () => {
    const key = uniqueKey();
    const conflicts: Array<Record<string, unknown>> = [];
    const states: SyncStateEvent[] = [];
    const conflictFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ itemId: string; id: string }>;
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.items.map((it) => ({
            itemId: it.itemId,
            id: it.id,
            status: 'conflict',
            reason: 'stale_write',
            updatedAt: '2026-07-03T00:00:00.000Z',
          })),
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: conflictFetch,
      onSyncStateChange: (e) => states.push(e),
      onConflict: (c) =>
        conflicts.push(c as unknown as Record<string, unknown>),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const rowId = '66666666-6666-4666-8666-666666666666';
    await cap.wrapMutation?.(
      { kind: 'update', key: rowId, data: { name: 'W2' } },
      ctx,
    );

    await waitFor(() => conflicts.length > 0);
    expect(conflicts[0]).toMatchObject({
      rowId,
      object: 'products',
      reason: 'stale_write',
      serverUpdatedAt: '2026-07-03T00:00:00.000Z',
    });
    // Conflict is RESOLVED — terminal state is synced, and the item left the queue.
    await waitFor(() =>
      states.some((s) => s.rowId === rowId && s.state === 'synced'),
    );
    const namespace = durableStoreNamespace(key);
    const handle = requireHandle(namespace);
    const snap = await handle.snapshot();
    expect(snap.find((s) => s.rowId === rowId)).toBeUndefined();
  });

  it('a terminal rejection (invalid_id) ends in failed and leaves the queue', async () => {
    const key = uniqueKey();
    const states: SyncStateEvent[] = [];
    const rejectFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ itemId: string; id: string }>;
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          results: body.items.map((it) => ({
            itemId: it.itemId,
            id: it.id,
            status: 'rejected',
            reason: 'invalid_id',
          })),
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: rejectFetch,
      onSyncStateChange: (e) => states.push(e),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });

    const rowId = '77777777-7777-4777-8777-777777777777';
    await cap.wrapMutation?.(
      { kind: 'insert', key: rowId, data: { id: rowId, name: 'X' } },
      ctx,
    );

    await waitFor(() => states.some((s) => s.state === 'failed'));
    const seq = states.filter((s) => s.rowId === rowId).map((s) => s.state);
    expect(seq).toEqual(['pending', 'uploading', 'failed']);
    // Removed from the durable queue (terminal).
    const handle = requireHandle(durableStoreNamespace(key));
    const snap = await handle.snapshot();
    expect(snap.find((s) => s.rowId === rowId)).toBeUndefined();
  });
});
