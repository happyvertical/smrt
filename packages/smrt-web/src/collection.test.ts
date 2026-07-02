/**
 * Behavior tests for the smrt-web collection factory (spike #1756).
 *
 * Per the repo mocking policy only the external boundary is mocked: the
 * generated REST client fetchers (thin fetch wrappers). Everything else —
 * TanStack DB collection, transactions, live state — is real.
 */

import { describe, expect, it } from 'vitest';
import {
  type SmrtCollectionDefinition,
  type SmrtCrudFetchers,
  SmrtWebRequestError,
  createSmrtCollection,
  newLocalId,
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
): SmrtCollectionDefinition<ProductData> {
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
 * A scripted stand-in for `createClient('/api/v1').products`: resolves like
 * the generated fetchers do (JSON payloads, never rejects on HTTP errors)
 * and counts calls so caching behavior is observable.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0 };
  let failNextCreate: string | null = null;

  const fetchers: SmrtCrudFetchers = {
    list: async () => {
      calls.list += 1;
      return serverRows.map((row) => ({ ...row }));
    },
    create: async (data) => {
      calls.create += 1;
      if (failNextCreate) {
        const error = failNextCreate;
        failNextCreate = null;
        // Generated REST routes return `{ error }` bodies on failure and the
        // generated client resolves them (fetch only rejects on network
        // errors) — this is exactly the shape smrt-web must translate into
        // a rollback.
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
  };
}

describe('createSmrtCollection', () => {
  it('loads rows through the generated fetchers and serves repeat reads from cache within the staleness window', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    const collection = createSmrtCollection(
      productDefinition('products-swr'),
      { fetchers: scripted.fetchers, staleTimeMs: 60_000 },
    );

    await collection.preload();
    // Note: TanStack DB 0.6 decorates rows with virtual props ($key,
    // $origin, ...), so assertions match the DTO subset rather than deep
    // equality.
    expect(collection.toArray).toMatchObject([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    expect(scripted.calls.list).toBe(1);

    // Simulate leaving and re-entering a page: drop the subscriber, then
    // read again within the staleness window — no extra network call.
    const subscription = collection.subscribeChanges(() => {});
    subscription.unsubscribe();
    const again = collection.subscribeChanges(() => {});
    expect(collection.toArray).toHaveLength(1);
    again.unsubscribe();
    expect(scripted.calls.list).toBe(1);

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

    // The create persisted through the generated client (temp id stripped),
    // and the post-persist refetch swapped in the server-assigned row.
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
