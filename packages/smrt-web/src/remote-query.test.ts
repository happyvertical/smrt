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

  it('shares equivalent query keys and rebinds a cached result to the current request id', async () => {
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return envelope(received, 'cached');
      },
    });
    const first: SmrtWebDataQueryRequest = {
      ...request,
      filter: {
        kind: 'condition',
        field: 'name',
        operator: 'eq',
        value: 'Ada',
      },
    };
    const equivalent: SmrtWebDataQueryRequest = {
      mode: 'rows',
      filter: {
        value: 'Ada',
        operator: 'eq',
        field: 'name',
        kind: 'condition',
      },
      page: { limit: 10, offset: 0, kind: 'offset' },
      requestId: 'request-2',
      version: 1,
    };

    await query.execute(first);
    const cached = await query.execute(equivalent);

    expect(calls).toBe(1);
    expect(cached.requestId).toBe('request-2');
    expect(query.state.result?.requestId).toBe('request-2');
    query.dispose();
    await collection.cleanup();
  });

  it('does not apply a cancelled fresh-cache read', async () => {
    const caller = new AbortController();
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, 'cached'),
    });

    await query.execute(request);
    caller.abort();
    await expect(
      query.execute(
        { ...request, requestId: 'request-2' },
        { signal: caller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(query.request?.requestId).toBe('request-1');
    expect(query.state.result?.requestId).toBe('request-1');
    query.dispose();
    await collection.cleanup();
  });

  it('rebinds an in-flight shared result to each caller request id', async () => {
    let resolveQuery!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveQuery = resolve;
          void received;
        });
      },
    });

    const first = query.execute(request, { mode: 'background' });
    const second = query.execute(
      { ...request, requestId: 'request-2' },
      { mode: 'background' },
    );
    resolveQuery(envelope(request, 'shared'));

    expect(calls).toBe(1);
    await expect(first).resolves.toMatchObject({ requestId: 'request-1' });
    await expect(second).resolves.toMatchObject({ requestId: 'request-2' });
    query.dispose();
    await collection.cleanup();
  });

  it('keeps shared transport alive when its initiating caller cancels', async () => {
    const caller = new AbortController();
    let resolveQuery!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveQuery = resolve;
          void received;
        });
      },
    });

    const first = query.execute(request, {
      mode: 'background',
      signal: caller.signal,
    });
    const second = query.execute(
      { ...request, requestId: 'request-2' },
      { mode: 'background' },
    );
    caller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    resolveQuery(envelope(request, 'shared'));
    await expect(second).resolves.toMatchObject({
      requestId: 'request-2',
    });
    expect(calls).toBe(1);
    query.dispose();
    await collection.cleanup();
  });

  it('applies a joining caller deadline without cancelling shared transport', async () => {
    let resolveQuery!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveQuery = resolve;
          void received;
        });
      },
    });

    const first = query.execute(request, { mode: 'background' });
    const joining = query.execute(
      { ...request, requestId: 'request-2' },
      { mode: 'background', deadlineMs: 1 },
    );

    await expect(joining).rejects.toMatchObject({ name: 'AbortError' });
    resolveQuery(envelope(request, 'shared'));
    await expect(first).resolves.toMatchObject({ requestId: 'request-1' });
    expect(calls).toBe(1);
    query.dispose();
    await collection.cleanup();
  });

  it('releases visible refresh state when a background successor wins the cache', async () => {
    let resolveRefresh!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'initial');
        if (calls === 2) {
          return await new Promise<ReturnType<typeof envelope>>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return envelope(received, 'background');
      },
    });

    await query.execute(request);
    const refresh = query.refresh();
    await vi.waitFor(() => expect(calls).toBe(2));
    await query.execute(request, { mode: 'background', force: true });
    resolveRefresh(envelope(request, 'older-refresh'));
    await refresh;

    expect(query.state.rows[0]?.name).toBe('initial');
    expect(query.state.loading).toBe(false);
    expect(query.state.refreshing).toBe(false);
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

  it("does not let an earlier caller's abort cancel its visible successor", async () => {
    const callerA = new AbortController();
    const calls: string[] = [];
    let resolveB!: (result: unknown) => void;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received, options) => {
        calls.push(received.requestId);
        if (received.requestId === 'request-1') {
          return await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        }
        return await new Promise((resolve) => {
          resolveB = resolve;
        });
      },
    });
    const first = query
      .execute(request, { signal: callerA.signal })
      .catch(() => undefined);
    await vi.waitFor(() => expect(calls).toEqual(['request-1']));
    const second = query.execute({ ...request, requestId: 'request-2' });
    await vi.waitFor(() => expect(calls).toEqual(['request-1', 'request-2']));
    callerA.abort();
    resolveB(envelope({ ...request, requestId: 'request-2' }, 'successor'));
    await second;
    await first;
    expect(query.state.rows[0]?.name).toBe('successor');
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

  it('keeps an older forced flight from overwriting a newer cached result', async () => {
    const releases: Array<() => void> = [];
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        const name = calls === 1 ? 'A' : 'B';
        return await new Promise((resolve) => {
          releases.push(() => resolve(envelope(received, name)));
        });
      },
    });
    const first = query.execute(request, { mode: 'background' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = query.execute(request, {
      mode: 'background',
      force: true,
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    releases[1]?.();
    await second;
    releases[0]?.();
    await first;

    await query.execute(request);
    expect(calls).toBe(2);
    expect(query.state.rows[0]?.name).toBe('B');
    query.dispose();
    await collection.cleanup();
  });

  it('retains an older result when its forced successor aborts', async () => {
    const caller = new AbortController();
    let resolveA!: (result: unknown) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received, options) => {
        calls += 1;
        if (calls === 1) {
          return await new Promise((resolve) => {
            resolveA = resolve;
          });
        }
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });
    const first = query.execute(request, { mode: 'background' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = query.execute(request, {
      mode: 'background',
      force: true,
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(calls).toBe(2));
    caller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    resolveA(envelope(request, 'A'));
    await first;

    await query.execute(request);
    expect(calls).toBe(2);
    expect(query.state.rows[0]?.name).toBe('A');
    query.dispose();
    await collection.cleanup();
  });

  it('keeps a live result newer than an older forced flight', async () => {
    let resolveOld!: (result: unknown) => void;
    let onLive: ((value: unknown) => void) | undefined;
    let queryCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        queryCalls += 1;
        if (queryCalls === 1) return envelope(received, 'initial');
        return await new Promise((resolve) => {
          resolveOld = resolve;
        });
      },
      subscribe: (_received, callback) => {
        onLive = callback;
        return { unsubscribe: () => undefined };
      },
    });
    await query.execute(request);
    query.subscribeLive();
    const oldFlight = query.execute(request, {
      mode: 'background',
      force: true,
    });
    await vi.waitFor(() => expect(queryCalls).toBe(2));
    onLive?.(envelope(request, 'live'));
    await vi.waitFor(() => expect(query.state.rows[0]?.name).toBe('live'));
    resolveOld(envelope(request, 'old'));
    await oldFlight;

    await query.execute(request);
    expect(queryCalls).toBe(2);
    expect(query.state.rows[0]?.name).toBe('live');
    query.dispose();
    await collection.cleanup();
  });

  it('does not let a current visible refresh overwrite a newer live result', async () => {
    let resolveRefresh!: (result: unknown) => void;
    let onLive: ((value: unknown) => void) | undefined;
    let queryCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        queryCalls += 1;
        if (queryCalls === 1) return envelope(received, 'initial');
        return await new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      },
      subscribe: (_received, callback) => {
        onLive = callback;
        return { unsubscribe: () => undefined };
      },
    });

    await query.execute(request);
    query.subscribeLive();
    const refresh = query.refresh();
    await vi.waitFor(() => expect(queryCalls).toBe(2));
    onLive?.(envelope(request, 'live'));
    await vi.waitFor(() => expect(query.state.rows[0]?.name).toBe('live'));
    resolveRefresh(envelope(request, 'stale-refresh'));
    await refresh;

    expect(query.state.rows[0]?.name).toBe('live');
    query.dispose();
    await collection.cleanup();
  });

  it('does not surface an obsolete live validation error on a newer request', async () => {
    let onLive: ((value: unknown) => void) | undefined;
    let resolveNew!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'initial');
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveNew = resolve;
        });
      },
      subscribe: (_received, callback) => {
        onLive = callback;
        return { unsubscribe: () => undefined };
      },
    });
    const nextRequest = {
      ...request,
      requestId: 'request-2',
      page: { kind: 'offset' as const, offset: 10, limit: 10 },
    };

    await query.execute(request);
    query.subscribeLive();
    onLive?.({ invalid: true });
    const newer = query.execute(nextRequest);
    await Promise.resolve();
    await Promise.resolve();

    expect(query.state.error).toBeNull();
    resolveNew(envelope(nextRequest, 'newer'));
    await newer;
    expect(query.state.rows[0]?.name).toBe('newer');
    query.dispose();
    await collection.cleanup();
  });

  it('does not let a pending flight repopulate cache after dispose', async () => {
    let resolvePending!: (result: unknown) => void;
    let queryCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        queryCalls += 1;
        if (queryCalls === 1) return envelope(received, 'initial');
        if (queryCalls === 2) {
          return await new Promise((resolve) => {
            resolvePending = resolve;
          });
        }
        return envelope(received, 'after-dispose');
      },
    });
    await query.execute(request);
    const pending = query.refresh();
    await vi.waitFor(() => expect(queryCalls).toBe(2));
    query.dispose();
    resolvePending(envelope(request, 'disposed-flight'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.rows[0]?.name).toBe('initial');

    await expect(query.execute(request)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      query.execute(request, { mode: 'background' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.request).toBeUndefined();
    expect(queryCalls).toBe(2);
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

  it('rebinds a same-key live update to the current request id', async () => {
    let onResult: ((value: unknown) => void) | undefined;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, 'initial'),
      subscribe: (_received, callback) => {
        onResult = callback;
        return { unsubscribe: () => undefined };
      },
    });
    const newerRequest = { ...request, requestId: 'request-2' };

    await query.execute(request);
    query.subscribeLive();
    await query.execute(newerRequest);
    onResult?.(envelope(request, 'live'));

    await vi.waitFor(() => expect(query.state.rows[0]?.name).toBe('live'));
    expect(query.state.result?.requestId).toBe('request-2');
    query.dispose();
    await collection.cleanup();
  });

  it('replaces an active live subscription for a different visible query', async () => {
    const subscriptions: Array<{
      request: SmrtWebDataQueryRequest;
      callback: (value: unknown) => void;
    }> = [];
    let unsubscribed = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => envelope(received, 'initial'),
      subscribe: (received, callback) => {
        subscriptions.push({ request: received, callback });
        return {
          unsubscribe: () => {
            unsubscribed += 1;
          },
        };
      },
    });
    const nextRequest = {
      ...request,
      requestId: 'request-2',
      page: { kind: 'offset' as const, offset: 10, limit: 10 },
    };

    await query.execute(request);
    query.subscribeLive();
    await query.execute(nextRequest);

    expect(unsubscribed).toBe(1);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.request).toEqual(nextRequest);
    subscriptions[0]?.callback(envelope(request, 'old-live'));
    subscriptions[1]?.callback(envelope(nextRequest, 'new-live'));

    await vi.waitFor(() => expect(query.state.rows[0]?.name).toBe('new-live'));
    query.dispose();
    await collection.cleanup();
  });

  it('keeps live updates after rapid visible query changes', async () => {
    const subscriptions: Array<{
      request: SmrtWebDataQueryRequest;
      callback: (value: unknown) => void;
    }> = [];
    let calls = 0;
    let unsubscribed = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received, options) => {
        calls += 1;
        if (calls === 2) {
          return await new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        }
        return envelope(received, calls === 1 ? 'initial' : 'latest');
      },
      subscribe: (received, callback) => {
        subscriptions.push({ request: received, callback });
        return {
          unsubscribe: () => {
            unsubscribed += 1;
          },
        };
      },
    });
    const intermediateRequest = {
      ...request,
      requestId: 'request-2',
      page: { kind: 'offset' as const, offset: 10, limit: 10 },
    };
    const latestRequest = {
      ...request,
      requestId: 'request-3',
      page: { kind: 'offset' as const, offset: 20, limit: 10 },
    };

    await query.execute(request);
    query.subscribeLive();
    const intermediate = query
      .execute(intermediateRequest)
      .catch(() => undefined);
    await vi.waitFor(() => expect(calls).toBe(2));
    await query.execute(latestRequest);
    await intermediate;

    expect(unsubscribed).toBe(1);
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.request).toEqual(latestRequest);
    subscriptions[1]?.callback(envelope(latestRequest, 'latest-live'));
    await vi.waitFor(() =>
      expect(query.state.rows[0]?.name).toBe('latest-live'),
    );
    query.dispose();
    await collection.cleanup();
  });

  it('lets the original live handle cancel a pending query rebind', async () => {
    const subscriptions: SmrtWebDataQueryRequest[] = [];
    let resolveQuery!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    let unsubscribed = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'initial');
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveQuery = resolve;
        });
      },
      subscribe: (received) => {
        subscriptions.push(received);
        return {
          unsubscribe: () => {
            unsubscribed += 1;
          },
        };
      },
    });
    const nextRequest = {
      ...request,
      requestId: 'request-2',
      page: { kind: 'offset' as const, offset: 10, limit: 10 },
    };

    await query.execute(request);
    const live = query.subscribeLive();
    const next = query.execute(nextRequest);
    await vi.waitFor(() => expect(calls).toBe(2));
    live?.unsubscribe();
    resolveQuery(envelope(nextRequest, 'next'));
    await next;

    expect(unsubscribed).toBe(1);
    expect(subscriptions).toEqual([request]);
    query.dispose();
    await collection.cleanup();
  });

  it('disconnects a transport only once during repeated reconnects', async () => {
    const callbacks: Array<(value: unknown) => void> = [];
    let calls = 0;
    let unsubscribeCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return envelope(received, calls === 1 ? 'initial' : 'reconnected');
      },
      subscribe: (_received, callback) => {
        callbacks.push(callback);
        let closed = false;
        return {
          unsubscribe: () => {
            if (closed) throw new Error('subscription closed twice');
            closed = true;
            unsubscribeCalls += 1;
          },
        };
      },
    });

    await query.execute(request);
    const live = query.subscribeLive();
    live?.reconnect();
    live?.reconnect();
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));

    expect(unsubscribeCalls).toBe(1);
    query.dispose();
    await collection.cleanup();
  });

  it('does not let a delayed live update overtake a newer explicit fetch', async () => {
    let onResult: ((value: unknown) => void) | undefined;
    let resolveLive!: (result: ReturnType<typeof envelope>) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return envelope(received, calls === 1 ? 'initial' : 'explicit');
      },
      subscribe: (_received, callback) => {
        onResult = callback;
        return { unsubscribe: () => undefined };
      },
    });
    const pendingLive = new Promise<ReturnType<typeof envelope>>((resolve) => {
      resolveLive = resolve;
    });

    await query.execute(request);
    query.subscribeLive();
    onResult?.(pendingLive);
    await query.execute(
      { ...request, requestId: 'request-2' },
      { force: true },
    );
    resolveLive(envelope(request, 'stale-live'));
    await Promise.resolve();
    await Promise.resolve();

    expect(query.state.rows[0]?.name).toBe('explicit');
    query.dispose();
    await collection.cleanup();
  });

  it('does not surface an older invalid live update after a newer fetch succeeds', async () => {
    let onResult: ((value: unknown) => void) | undefined;
    let resolveInvalid!: (value: unknown) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        return envelope(received, calls === 1 ? 'initial' : 'explicit');
      },
      subscribe: (_received, callback) => {
        onResult = callback;
        return { unsubscribe: () => undefined };
      },
    });
    const invalidLive = new Promise<unknown>((resolve) => {
      resolveInvalid = resolve;
    });

    await query.execute(request);
    query.subscribeLive();
    onResult?.(invalidLive);
    await query.execute(
      { ...request, requestId: 'request-2' },
      { force: true },
    );
    resolveInvalid({ invalid: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(query.state.rows[0]?.name).toBe('explicit');
    expect(query.state.error).toBeNull();
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
    oldCallback?.(envelope(request, 'late-before-reconnect'));
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

  it('coalesces overlapping reconnects into one replacement subscription', async () => {
    const callbacks: Array<(value: unknown) => void> = [];
    let resolveRefresh!: (result: ReturnType<typeof envelope>) => void;
    let queryCalls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        queryCalls += 1;
        if (queryCalls === 1) return envelope(received, 'initial');
        return await new Promise<ReturnType<typeof envelope>>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      subscribe: (_received, callback) => {
        callbacks.push(callback);
        return { unsubscribe: () => undefined };
      },
    });

    await query.execute(request);
    const live = query.subscribeLive();
    live?.reconnect();
    live?.reconnect();
    await vi.waitFor(() => expect(queryCalls).toBe(2));
    resolveRefresh(envelope(request, 'reconnect'));
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));

    callbacks[1]?.(envelope(request, 'reconnected'));
    await vi.waitFor(() =>
      expect(query.state.rows[0]?.name).toBe('reconnected'),
    );
    live?.unsubscribe();
    query.dispose();
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

  it('does not let a pre-invalidation refresh restore a fresh cache entry', async () => {
    let resolveRefresh!: (result: unknown) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'initial');
        if (calls === 2) {
          return await new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return envelope(received, 'after-invalidation');
      },
    });

    await query.execute(request);
    const refresh = query.refresh();
    await vi.waitFor(() => expect(calls).toBe(2));
    query.invalidate();
    resolveRefresh(envelope(request, 'stale-refresh'));
    await refresh;

    expect(query.state.rows[0]?.name).toBe('initial');
    expect(query.state.stale).toBe(true);
    await query.execute(request);
    expect(calls).toBe(3);
    expect(query.state.rows[0]?.name).toBe('after-invalidation');
    query.dispose();
    await collection.cleanup();
  });

  it('aborts non-visible work when disposed', async () => {
    let started = false;
    let aborted = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (_received, options) => {
        started = true;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    });
    const pending = query.execute(request, { mode: 'background' });
    await vi.waitFor(() => expect(started).toBe(true));
    query.dispose();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
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
    expect(query.state.loading).toBe(false);
    expect(query.state.refreshing).toBe(false);
    expect(query.state.error).toBeNull();
    query.dispose();
    await collection.cleanup();
  });

  it('treats a transport custom error after abort as cancellation', async () => {
    const caller = new AbortController();
    let started = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (_received, options) => {
        started = true;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('transport cancellation')),
            { once: true },
          );
        });
      },
    });
    const pending = query.execute(request, { signal: caller.signal });
    await vi.waitFor(() => expect(started).toBe(true));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.error).toBeNull();
    expect(query.state.loading).toBe(false);
    expect(query.state.refreshing).toBe(false);
    query.dispose();
    await collection.cleanup();
  });

  it('normalizes an arbitrary caller abort reason', async () => {
    const caller = new AbortController();
    let started = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (_received, options) => {
        started = true;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });
    const pending = query.execute(request, { signal: caller.signal });
    await vi.waitFor(() => expect(started).toBe(true));
    caller.abort('caller reason');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.error).toBeNull();
    expect(query.state.loading).toBe(false);
    expect(query.state.refreshing).toBe(false);
    query.dispose();
    await collection.cleanup();
  });

  it('clears refreshing after the current refresh is cancelled', async () => {
    const caller = new AbortController();
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received, options) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'cached');
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    });
    await query.execute(request);
    const pending = query.refresh({ signal: caller.signal });
    await vi.waitFor(() => expect(query.state.refreshing).toBe(true));
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.rows[0]?.name).toBe('cached');
    expect(query.state.loading).toBe(false);
    expect(query.state.refreshing).toBe(false);
    expect(query.state.stale).toBe(true);
    expect(query.state.error).toBeNull();
    query.dispose();
    await collection.cleanup();
  });

  it('rejects a delayed transport result after its signal is aborted', async () => {
    const caller = new AbortController();
    let release!: (result: unknown) => void;
    let calls = 0;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const query = createSmrtWebQuery(collection, {
      query: async (received) => {
        calls += 1;
        if (calls > 1) return envelope(received, 'cancelled');
        return await new Promise<unknown>((resolve) => {
          release = resolve;
        });
      },
    });
    const pending = query.execute(request, { signal: caller.signal });
    caller.abort();
    release(envelope(request, 'cancelled'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(query.state.rows).toEqual([]);

    await query.execute(request);
    expect(calls).toBe(2);
    expect(query.state.rows[0]?.name).toBe('cancelled');
    query.dispose();
    await collection.cleanup();
  });
});
