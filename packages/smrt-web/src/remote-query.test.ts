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
