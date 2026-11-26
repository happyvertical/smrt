/**
 * How the offline outbox treats sync-apply outcomes a server reports per item
 * (#5195):
 *
 * - `rate_limited` is retryable: the item goes back to `pending` and counts an
 *   attempt, like `write_failed`.
 * - A reason the engine does not know is terminal for that item.
 *
 * Real fake-indexeddb backs the durable queue; `fetch` is the scripted
 * boundary.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmrtWebCapabilityContext } from './capability.js';
import type { DurableStoreKey } from './durable-store.js';
import { durableStoreNamespace } from './durable-store.js';
import {
  getOutboxHandle,
  offlineOutbox,
  type SyncStateEvent,
} from './offline.js';

let nsCounter = 0;
function uniqueKey(): DurableStoreKey {
  nsCounter += 1;
  return {
    apiBase: '/api/v1',
    manifestHash: `outcomes-${nsCounter}-${Math.random().toString(36).slice(2)}`,
  };
}

function fakeCtx(name: string): SmrtWebCapabilityContext<object> {
  return {
    definition: {
      name,
      objectRef: '@test/smrt-web:X',
      className: 'X',
      endpoint: `/${name}`,
      idField: 'id',
      actions: ['create', 'update', 'delete', 'list', 'get'],
      fields: {},
    },
    fetchers: { list: async () => [], create: async (d) => d },
    cacheKey: ['smrt', name],
    cacheId: `smrt:${name}`,
    invalidate: () => {},
  };
}

async function waitFor(predicate: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

/** A sync-apply fetch that answers each item with the reason scripted for its row. */
function scriptedFetch(
  outcomes: Record<string, { status: string; reason?: string }>,
  posts: string[][],
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      items: Array<{ itemId: string; id: string }>;
    };
    posts.push(body.items.map((item) => item.id));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.items.map((item) => ({
          itemId: item.itemId,
          id: item.id,
          ...(outcomes[item.id] ?? { status: 'applied' }),
        })),
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('offline outbox sync outcomes', () => {
  const teardowns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const teardown of teardowns.splice(0)) await teardown();
    vi.unstubAllGlobals();
  });

  it('a throttled item is rejected as retryable, and an unknown reason is terminal', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const key = uniqueKey();
    const namespace = durableStoreNamespace(key);
    const throttled = '51955195-0001-4000-8000-000000000001';
    const unknown = '51955195-0002-4000-8000-000000000002';
    const posts: string[][] = [];
    const states: SyncStateEvent[] = [];
    const cap = offlineOutbox({
      object: { name: 'products' },
      namespace: key,
      fetchFn: scriptedFetch(
        {
          [throttled]: { status: 'rejected', reason: 'rate_limited' },
          [unknown]: { status: 'rejected', reason: 'some_future_reason' },
        },
        posts,
      ),
      backoff: { initialDelayMs: 100_000, maxDelayMs: 100_000 },
      random: () => 1,
      onSyncStateChange: (event) => states.push(event),
    });
    const ctx = fakeCtx('products');
    cap.onAttach?.(ctx);
    teardowns.push(async () => {
      await cap.teardown?.(ctx);
    });
    for (const id of [throttled, unknown]) {
      await cap.wrapMutation?.(
        { kind: 'insert', key: id, data: { id, name: id } },
        ctx,
      );
    }
    const handle = getOutboxHandle(namespace);
    if (!handle) throw new Error('no outbox handle');
    const queued = await handle.snapshot();
    vi.stubGlobal('navigator', { onLine: true });
    await handle.retry(queued[0].itemId);
    await waitFor(() => posts.length === 1);
    await waitFor(() =>
      states.some(
        (event) => event.rowId === unknown && event.state === 'failed',
      ),
    );

    const after = await handle.snapshot();
    expect(after.map((row) => row.rowId)).toEqual([throttled]);
    expect(after[0]).toMatchObject({ attempts: 1 });
    expect(
      states
        .filter((event) => event.rowId === throttled)
        .map((event) => event.state),
    ).toContain('pending');
    expect(
      states.find(
        (event) => event.rowId === unknown && event.state === 'failed',
      )?.error,
    ).toBe('sync some_future_reason');
  });
});
