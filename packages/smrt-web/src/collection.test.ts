/**
 * Behavior tests for the smrt-web collection factory (#1761).
 *
 * Per the repo mocking policy only the external boundary is mocked: the
 * generated REST client fetchers (thin fetch wrappers). Everything else — the
 * client-data engine collection, transactions, live state — is real.
 */

import { describe, expect, it } from 'vitest';
import {
  createSmrtCollection,
  createSmrtWebClient,
  getEngineCollection,
  newLocalId,
  type SmrtCrudFetchers,
  type SmrtWebCollectionDefinition,
  SmrtWebRequestError,
  unwrapItemResult,
  unwrapListResult,
} from './index.js';

interface ProductData {
  id?: string;
  name: string;
  price?: number;
  inStock?: boolean;
}

function productDefinition(
  name: string,
): SmrtWebCollectionDefinition<ProductData> {
  // Mirrors what @happyvertical/smrt-virt-web emits for the products package.
  return {
    name,
    className: 'Product',
    endpoint: `/${name}`,
    idField: 'id',
    actions: ['create', 'get', 'list', 'update'],
    fields: {
      name: { type: 'text', required: true },
      price: { type: 'decimal' },
      inStock: { type: 'boolean' },
    },
  };
}

/**
 * A scripted stand-in for `createClient('/api/v1').products`: resolves like the
 * generated fetchers do (JSON payloads, never rejects on HTTP errors) and
 * counts calls so caching behavior is observable.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0 };
  let failNextCreate: string | null = null;
  let gateListResolve: (() => void) | null = null;

  const fetchers: SmrtCrudFetchers = {
    list: async () => {
      calls.list += 1;
      if (gateListResolve) {
        await new Promise<void>((resolve) => {
          gateListResolve = resolve;
        });
      }
      return serverRows.map((row) => ({ ...row }));
    },
    create: async (data) => {
      calls.create += 1;
      if (failNextCreate) {
        const error = failNextCreate;
        failNextCreate = null;
        // Generated REST routes return `{ error }` bodies on failure and the
        // generated client resolves them (fetch only rejects on network
        // errors) — this is exactly the shape smrt-web must translate into a
        // rollback.
        return { error };
      }
      const created = {
        ...data,
        id: `server-${serverRows.length + 1}`,
      };
      serverRows.push(created);
      return { ...created };
    },
  };

  return {
    fetchers,
    calls,
    failCreateWith(message: string) {
      failNextCreate = message;
    },
    /** Hold the next list() open until released — for concurrency assertions. */
    gateNextList() {
      gateListResolve = () => {};
    },
    releaseList() {
      const resolve = gateListResolve;
      gateListResolve = null;
      resolve?.();
    },
  };
}

describe('createSmrtCollection', () => {
  it('loads rows through the generated fetchers and serves repeat reads from cache within the staleness window', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    const collection = createSmrtCollection(productDefinition('products-swr'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });

    await collection.preload();
    // Note: the engine decorates rows with virtual props ($key, $origin, ...),
    // so assertions match the DTO subset rather than deep equality.
    expect(collection.toArray).toMatchObject([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    expect(scripted.calls.list).toBe(1);

    // Simulate leaving and re-entering a page: drop the subscriber, then read
    // again within the staleness window — no extra network call.
    const subscription = collection.subscribeChanges(() => {});
    subscription.unsubscribe();
    const again = collection.subscribeChanges(() => {});
    expect(collection.toArray).toHaveLength(1);
    again.unsubscribe();
    expect(scripted.calls.list).toBe(1);

    await collection.cleanup();
  });

  it('coalesces N concurrent identical reads into a single network request', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    scripted.gateNextList();
    const collection = createSmrtCollection(
      productDefinition('products-dedup'),
      { fetchers: scripted.fetchers, staleTimeMs: 60_000 },
    );

    // Fire five concurrent preloads while the first list() is held open.
    const reads = Promise.all(
      Array.from({ length: 5 }, () => collection.preload()),
    );
    // All five share the single in-flight request.
    expect(scripted.calls.list).toBe(1);
    scripted.releaseList();
    await reads;
    expect(scripted.calls.list).toBe(1);
    expect(collection.size).toBe(1);

    await collection.cleanup();
  });

  it('revalidates after the collection is restarted once data is stale', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(
      productDefinition('products-revalidate'),
      { fetchers: scripted.fetchers, staleTimeMs: 0 },
    );

    await collection.preload();
    expect(scripted.calls.list).toBe(1);

    // Full lifecycle drop (what gc after navigation does), then a new
    // subscriber: staleTime 0 means the restart must revalidate.
    await collection.cleanup();
    await collection.preload();
    expect(scripted.calls.list).toBe(2);

    await collection.cleanup();
  });

  it('applies an optimistic create instantly and reconciles with the server row', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(
      productDefinition('products-create'),
      { fetchers: scripted.fetchers, staleTimeMs: 60_000 },
    );
    await collection.preload();

    const localId = newLocalId();
    const tx = collection.insert({
      id: localId,
      name: 'Gadget',
      price: 19.99,
    });

    // Optimistic row is visible synchronously, before any network response.
    expect(collection.has(localId)).toBe(true);
    expect(collection.size).toBe(2);

    await tx.isPersisted.promise;

    // The create persisted through the generated client (temp id stripped), and
    // the post-persist refetch swapped in the server-assigned row.
    expect(scripted.calls.create).toBe(1);
    expect(collection.has(localId)).toBe(false);
    const names = collection.toArray.map((row) => row.name).sort();
    expect(names).toEqual(['Gadget', 'Widget']);
    const created = collection.toArray.find((row) => row.name === 'Gadget');
    expect(created?.id).toBe('server-2');

    await collection.cleanup();
  });

  it('rolls the optimistic row back when the server rejects the create', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(
      productDefinition('products-rollback'),
      { fetchers: scripted.fetchers, staleTimeMs: 60_000 },
    );
    await collection.preload();

    scripted.failCreateWith('Validation failed: name is reserved');

    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'FAIL Gadget' });
    expect(collection.has(localId)).toBe(true);

    await expect(tx.isPersisted.promise).rejects.toThrow(
      'Validation failed: name is reserved',
    );

    // Optimistic state rolled back: the row is gone, server state intact.
    expect(collection.has(localId)).toBe(false);
    expect(collection.toArray).toMatchObject([{ id: 'p1', name: 'Widget' }]);
    expect(collection.size).toBe(1);

    await collection.cleanup();
  });

  it('accepts a shared client handle without leaking the engine', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const client = createSmrtWebClient();
    const collection = createSmrtCollection(
      productDefinition('products-shared'),
      { fetchers: scripted.fetchers, client, staleTimeMs: 60_000 },
    );

    await collection.preload();
    expect(collection.size).toBe(1);

    await collection.cleanup();
  });

  it('exposes plain DTO rows with no engine virtual props ($key/$origin/...)', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    const collection = createSmrtCollection(productDefinition('products-dto'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });
    await collection.preload();

    const [row] = collection.toArray;
    // Exact equality (not toMatchObject): the row must be a plain DTO — no
    // $synced/$origin/$key/$collectionId that would leak through spread/JSON.
    expect(row).toEqual({ id: 'p1', name: 'Widget', price: 9.99 });
    expect(Object.keys(row).some((k) => k.startsWith('$'))).toBe(false);
    expect(JSON.stringify(row)).not.toContain('$');
    // get() is projected too.
    expect(collection.get('p1')).toEqual({
      id: 'p1',
      name: 'Widget',
      price: 9.99,
    });

    await collection.cleanup();
  });

  it('isolates reads per scope so a shared client never cross-serves backends', async () => {
    const client = createSmrtWebClient();
    const backendA = makeScriptedFetchers([{ id: 'p1', name: 'from-A' }]);
    const backendB = makeScriptedFetchers([{ id: 'p1', name: 'from-B' }]);

    // Same generated collection name, one shared client, different backends —
    // distinct scopes must keep their caches separate.
    const collA = createSmrtCollection(productDefinition('products'), {
      fetchers: backendA.fetchers,
      client,
      scope: 'tenant-a',
      staleTimeMs: 60_000,
    });
    const collB = createSmrtCollection(productDefinition('products'), {
      fetchers: backendB.fetchers,
      client,
      scope: 'tenant-b',
      staleTimeMs: 60_000,
    });

    await Promise.all([collA.preload(), collB.preload()]);

    expect(collA.get('p1')?.name).toBe('from-A');
    expect(collB.get('p1')?.name).toBe('from-B');
    expect(backendA.calls.list).toBe(1);
    expect(backendB.calls.list).toBe(1);

    await Promise.all([collA.cleanup(), collB.cleanup()]);
  });

  it('rejects a client handle not produced by createSmrtWebClient', () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    expect(() =>
      createSmrtCollection(productDefinition('products-badclient'), {
        fetchers: scripted.fetchers,
        // Foreign object masquerading as a client handle.
        client: {} as ReturnType<typeof createSmrtWebClient>,
      }),
    ).toThrow(SmrtWebRequestError);
  });
});

describe('hydration seeding (#1761)', () => {
  it('serves server-seeded rows on the first read with no first-render fetch', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    // Rows a SvelteKit +page.server.ts load fetched and serialized into the
    // page; the client hands them to the collection as initialData.
    const ssrRows = [
      { id: 'p1', name: 'from-ssr', price: 9.99 },
      { id: 'p2', name: 'also-ssr', price: 4.5 },
    ];
    const collection = createSmrtCollection(
      productDefinition('products-seed'),
      {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        initialData: ssrRows,
      },
    );

    // The engine collection is lazy: it populates its local store from the
    // seeded cache on first read (preload), NOT before. What the seed
    // guarantees is that this first read is served from the seed WITHOUT a
    // network request — the "no duplicate first-render fetch" acceptance
    // criterion. (The smrt-svelte `liveCollection` binding preloads on init, so
    // this completes before the first component render.)
    await collection.preload();
    expect(scripted.calls.list).toBe(0);

    // The rows served are exactly the SSR rows (not the divergent server rows
    // the fetcher would return), so the pre- and post-hydration renders match.
    expect(collection.toArray).toMatchObject(ssrRows);
    expect(collection.toArray.map((row) => row.name).sort()).toEqual([
      'also-ssr',
      'from-ssr',
    ]);

    await collection.cleanup();
  });

  it('revalidates once the seed is stale, replacing it with server rows', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    // staleTimeMs 0: the seed is served on the first read but is stale at once,
    // so the collection revalidates against the fetcher. This is the SWR half of
    // hydration seeding — hydrate instantly, then reconcile with fresh rows.
    const collection = createSmrtCollection(
      productDefinition('products-seed-stale'),
      {
        fetchers: scripted.fetchers,
        staleTimeMs: 0,
        initialData: [{ id: 'p1', name: 'from-ssr' }],
      },
    );

    // preload() resolves once the read has DATA — that is the seed, served with
    // one background revalidation already dispatched (list called once), not yet
    // reconciled into the local store.
    await collection.preload();
    expect(collection.get('p1')?.name).toBe('from-ssr');
    expect(scripted.calls.list).toBe(1);

    // Await the background revalidation landing (change-driven, no arbitrary
    // sleep): the freshly fetched server row supersedes the stale seed.
    if (collection.get('p1')?.name !== 'from-server') {
      await new Promise<void>((resolve) => {
        const sub = collection.subscribeChanges(() => {
          if (collection.get('p1')?.name === 'from-server') {
            sub.unsubscribe();
            resolve();
          }
        });
      });
    }
    expect(collection.get('p1')?.name).toBe('from-server');
    // Still just the one revalidation — no extra fetch was triggered.
    expect(scripted.calls.list).toBe(1);

    await collection.cleanup();
  });

  it('honors an explicit empty seed as a valid fresh state that suppresses the first fetch', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    // The server load returned zero rows: an empty seed is still a fresh cache
    // entry, so the first read serves it (empty) without a network request.
    const collection = createSmrtCollection(
      productDefinition('products-seed-empty'),
      {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        initialData: [],
      },
    );

    await collection.preload();
    expect(collection.size).toBe(0);
    expect(scripted.calls.list).toBe(0);

    await collection.cleanup();
  });

  it('does not clobber an already-populated shared cache with a later stale seed', async () => {
    const client = createSmrtWebClient();
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);

    // First materialization seeds fresh SSR rows into the shared cache.
    const first = createSmrtCollection(
      productDefinition('products-seed-shared'),
      {
        fetchers: scripted.fetchers,
        client,
        staleTimeMs: 60_000,
        initialData: [{ id: 'p1', name: 'seeded-first' }],
      },
    );
    await first.preload();
    expect(first.get('p1')?.name).toBe('seeded-first');
    expect(scripted.calls.list).toBe(0);

    // A second materialization over the SAME client with a DIFFERENT seed must
    // not overwrite the already-cached rows (which may be newer than this late
    // SSR payload). The existing cache entry wins; still no fetch.
    const second = createSmrtCollection(
      productDefinition('products-seed-shared'),
      {
        fetchers: scripted.fetchers,
        client,
        staleTimeMs: 60_000,
        initialData: [{ id: 'p1', name: 'seeded-second' }],
      },
    );
    await second.preload();
    expect(second.get('p1')?.name).toBe('seeded-first');
    expect(scripted.calls.list).toBe(0);

    await first.cleanup();
    await second.cleanup();
  });
});

describe('getEngineCollection (internal binding bridge)', () => {
  it('returns the engine collection for a real handle and rejects foreign handles', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(
      productDefinition('products-bridge'),
      { fetchers: scripted.fetchers, staleTimeMs: 60_000 },
    );

    const engine = getEngineCollection(collection);
    expect(engine).toBeDefined();
    // The bridge yields the live engine collection (has its own preload()).
    expect(typeof (engine as { preload?: unknown }).preload).toBe('function');

    expect(() =>
      getEngineCollection({} as unknown as typeof collection),
    ).toThrow(SmrtWebRequestError);

    await collection.cleanup();
  });
});

describe('definition-derived fetchers', () => {
  it('serves reads and rolls back failed creates using only the generated definition and a base path', async () => {
    const serverRows = [{ id: 'p1', name: 'Widget' }];
    const requests: Array<{ url: string; method: string }> = [];

    // Mock ONLY the network boundary: a fetch stand-in for the generated REST
    // routes (bare array list, `{ error }` + status on failure).
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (method === 'GET') {
        return new Response(JSON.stringify(serverRows), { status: 200 });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name?: string };
        if (body.name?.startsWith('FAIL')) {
          return new Response(JSON.stringify({ error: 'rejected by server' }), {
            status: 500,
          });
        }
        const created = { ...body, id: `server-${serverRows.length + 1}` };
        serverRows.push(created as (typeof serverRows)[number]);
        return new Response(JSON.stringify(created), { status: 201 });
      }
      return new Response(null, { status: 405 });
    }) as typeof fetch;

    const collection = createSmrtCollection(
      productDefinition('products-deffetch'),
      { basePath: '/api/v1', fetchFn, staleTimeMs: 60_000 },
    );

    await collection.preload();
    expect(requests[0]).toEqual({
      url: '/api/v1/products-deffetch',
      method: 'GET',
    });
    expect(collection.size).toBe(1);

    // Failed create: HTTP 500 rejects and rolls back the optimistic row.
    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'FAIL thing' });
    expect(collection.has(localId)).toBe(true);
    await expect(tx.isPersisted.promise).rejects.toThrow('rejected by server');
    expect(collection.has(localId)).toBe(false);
    expect(collection.size).toBe(1);

    // Successful create persists and reconciles to the server id.
    const okTx = collection.insert({ id: newLocalId(), name: 'Gadget' });
    await okTx.isPersisted.promise;
    expect(collection.size).toBe(2);
    expect(collection.toArray.find((row) => row.name === 'Gadget')?.id).toBe(
      'server-2',
    );

    await collection.cleanup();
  });
});

describe('payload normalization', () => {
  it('passes bare arrays through (generated REST list shape)', () => {
    expect(unwrapListResult([{ id: '1' }], 'products')).toEqual([{ id: '1' }]);
  });

  it('tolerates ApiResponse envelopes ({ data: [...] })', () => {
    expect(unwrapListResult({ data: [{ id: '1' }] }, 'products')).toEqual([
      { id: '1' },
    ]);
  });

  it('turns { error } list payloads into SmrtWebRequestError', () => {
    expect(() => unwrapListResult({ error: 'nope' }, 'products')).toThrow(
      SmrtWebRequestError,
    );
  });

  it('unwraps item payloads and rejects { error } bodies', () => {
    expect(unwrapItemResult({ id: '1' }, 'create(products)')).toEqual({
      id: '1',
    });
    expect(unwrapItemResult({ data: { id: '1' } }, 'create(products)')).toEqual(
      { id: '1' },
    );
    expect(() =>
      unwrapItemResult({ error: 'denied' }, 'create(products)'),
    ).toThrow(SmrtWebRequestError);
    expect(() => unwrapItemResult(null, 'create(products)')).toThrow(
      SmrtWebRequestError,
    );
  });
});

describe('newLocalId', () => {
  it('generates unique ids', () => {
    expect(newLocalId()).not.toEqual(newLocalId());
  });
});
