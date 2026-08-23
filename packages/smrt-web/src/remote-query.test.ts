import { describe, expect, it, vi } from 'vitest';
import {
  createSmrtCollection,
  createSmrtWebQuery,
  type SmrtWebCollectionDefinition,
  type SmrtWebDataQueryRequest,
} from './index.js';

interface Row {
  id?: string;
  name: string;
}

const definition: SmrtWebCollectionDefinition<Row> = {
  name: 'remote-products',
  className: 'Product',
  endpoint: '/products',
  idField: 'id',
  actions: ['list'],
  fields: { name: { type: 'text' } },
};
const request: SmrtWebDataQueryRequest = {
  version: 1,
  requestId: 'request-1',
  mode: 'rows',
  page: { kind: 'offset', offset: 0, limit: 10 },
};

function envelope(received: SmrtWebDataQueryRequest, name: string) {
  return {
    version: 1,
    requestId: received.requestId,
    queryFingerprint: 'dq1_products',
    identityField: 'id',
    rows: [{ id: name, name }],
    page: { kind: 'offset', offset: 0, limit: 10, hasMore: false },
    total: { kind: 'exact', value: 1 },
    freshness: { state: 'fresh' },
    warnings: [],
    truncated: false,
  };
}

describe('remote query controller', () => {
  it('loads one page without hydrating the base collection and exposes table state', async () => {
    let listCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: {
        list: async () => {
          listCalls += 1;
          return [];
        },
        create: async () => ({}),
      },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, 'Ada'),
    });

    await query.execute(request);
    expect(listCalls).toBe(0);
    expect(query.state.rows).toEqual([{ id: 'Ada', name: 'Ada' }]);
    expect(query.state.page?.kind).toBe('offset');
    expect(query.state.total).toEqual({ kind: 'exact', value: 1 });
    query.dispose();
    await collection.cleanup();
  });

  it('suppresses an older visible response and never exposes its error', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        call += 1;
        if (call === 1) await first;
        return envelope(received, call === 1 ? 'old' : 'new');
      },
    });
    const older = query.execute(request).catch(() => undefined);
    const newerRequest = {
      ...request,
      requestId: 'request-2',
      page: { kind: 'offset' as const, offset: 10, limit: 10 },
    };
    await query.execute(newerRequest);
    releaseFirst();
    await older;
    expect(query.state.rows).toEqual([{ id: 'new', name: 'new' }]);
    expect(query.state.error).toBeNull();
    query.dispose();
    await collection.cleanup();
  });

  it('starts a new same-key visible request after aborting its predecessor', async () => {
    const calls: string[] = [];
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received, options) => {
        calls.push(received.requestId);
        if (calls.length === 1) {
          return await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        }
        return envelope(received, 'replacement');
      },
    });
    const predecessor = query.execute(request).catch(() => undefined);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const successor = query.execute({ ...request, requestId: 'same-key-2' });
    await successor;
    await predecessor;
    expect(calls).toEqual(['request-1', 'same-key-2']);
    expect(query.state.rows[0]?.name).toBe('replacement');
    query.dispose();
    await collection.cleanup();
  });

  it('keeps the forced successor in the in-flight map until it settles', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return envelope(received, `flight-${calls}`);
      },
    });
    const predecessor = query.execute(request, { mode: 'background' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const successor = query.execute(request, {
      mode: 'background',
      force: true,
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    releases[0]?.();
    await predecessor;
    const deduped = query.execute(request, { mode: 'background' });
    expect(calls).toBe(2);
    releases[1]?.();
    await Promise.all([successor, deduped]);
    query.dispose();
    await collection.cleanup();
  });

  it('prefetches into the keyed cache without changing visible state, then refreshes coherently', async () => {
    let value = 'prefetched';
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, value),
    });
    await query.execute(request, { mode: 'prefetch' });
    expect(query.state.rows).toEqual([]);
    await query.execute(request);
    expect(query.state.rows[0]?.name).toBe('prefetched');
    value = 'fresh';
    await query.refresh();
    expect(query.state.rows[0]?.name).toBe('fresh');
    query.dispose();
    await collection.cleanup();
  });

  it('subscribes to the exact query and applies matching live pages', async () => {
    let onResult: ((value: unknown) => void) | undefined;
    let unsubscribed = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, 'initial'),
      subscribe: (received, callback) => {
        expect(received.page).toEqual(request.page);
        onResult = callback;
        return {
          unsubscribe: () => {
            unsubscribed = true;
          },
        };
      },
    });
    await query.execute(request);
    const live = query.subscribeLive();
    onResult?.(envelope(request, 'live'));
    await vi.waitFor(() => expect(query.state.rows[0]?.name).toBe('live'));
    live?.unsubscribe();
    expect(unsubscribed).toBe(true);
    query.dispose();
    await collection.cleanup();
  });

  it('refetches before fallback reconnect, resubscribes, and ignores old callbacks', async () => {
    const callbacks: Array<(value: unknown) => void> = [];
    let queryCalls = 0;
    let subscriptions = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        queryCalls += 1;
        return envelope(received, queryCalls === 1 ? 'initial' : 'resynced');
      },
      subscribe: (_received, callback) => {
        subscriptions += 1;
        callbacks.push(callback);
        return { unsubscribe: () => undefined };
      },
    });
    await query.execute(request);
    const live = query.subscribeLive();
    const oldCallback = callbacks[0];
    live?.reconnect();
    await vi.waitFor(() => expect(subscriptions).toBe(2));
    expect(queryCalls).toBe(2);
    oldCallback?.(envelope(request, 'late-old'));
    await Promise.resolve();
    expect(query.state.rows[0]?.name).toBe('initial');
    callbacks[1]?.(envelope(request, 'reconnected'));
    await vi.waitFor(() =>
      expect(query.state.rows[0]?.name).toBe('reconnected'),
    );
    live?.unsubscribe();
    callbacks[1]?.(envelope(request, 'late-unsubscribed'));
    await Promise.resolve();
    expect(query.state.rows[0]?.name).toBe('reconnected');
    query.dispose();
    callbacks[1]?.(envelope(request, 'late-disposed'));
    await Promise.resolve();
    expect(query.state.rows[0]?.name).toBe('reconnected');
    await collection.cleanup();
  });

  it('marks invalidated data stale and retains rows when the next request is offline', async () => {
    let offline = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        if (offline) throw new TypeError('offline');
        return envelope(received, 'cached');
      },
    });
    await query.execute(request);
    query.invalidate();
    expect(query.state.stale).toBe(true);
    offline = true;
    await expect(query.refresh()).rejects.toThrow('offline');
    expect(query.state.rows[0]?.name).toBe('cached');
    expect(query.state.stale).toBe(true);
    expect(query.state.error).toBeInstanceOf(TypeError);
    query.dispose();
    await collection.cleanup();
  });

  it('passes deadline cancellation through without surfacing an abort as a query error', async () => {
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (_received, options) => {
        if (options?.signal?.aborted) throw options.signal.reason;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });
    await expect(
      query.execute(request, { deadlineMs: 0 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.error).toBeNull();
    query.dispose();
    await collection.cleanup();
  });
});
