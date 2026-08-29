import {
  createSmrtCollection,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type SmrtWebDataQueryRequest,
  type SmrtWebQueryTransport,
} from '@happyvertical/smrt-web';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteQueryBinding } from '../remote-query.svelte.js';
import Harness from './remote-query-harness.svelte';

interface Row {
  id?: string;
  name: string;
}

const definition: SmrtWebCollectionDefinition<Row> = {
  name: 'remote-query-svelte-products',
  className: 'Product',
  endpoint: '/products',
  idField: 'id',
  actions: ['list'],
  fields: { name: { type: 'text' } },
};
const request: SmrtWebDataQueryRequest = {
  version: 1,
  requestId: 'svelte-request',
  mode: 'rows',
  page: { kind: 'offset', offset: 0, limit: 10 },
};

function envelope(received: SmrtWebDataQueryRequest, name: string) {
  return {
    version: 1,
    requestId: received.requestId,
    queryFingerprint: 'dq1_svelte_products',
    identityField: 'id',
    rows: [{ id: name, name }],
    page: { kind: 'offset', offset: 0, limit: 10, hasMore: false },
    total: { kind: 'exact', value: 1 },
    freshness: { state: 'fresh' },
    warnings: [],
    truncated: false,
  };
}

function mountView(
  collection: SmrtWebCollection<Row>,
  transport: SmrtWebQueryTransport,
): {
  target: HTMLDivElement;
  view: RemoteQueryBinding<Row>;
  teardown: () => void;
} {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let view = undefined as unknown as RemoteQueryBinding<Row>;
  const component = mount(Harness, {
    target,
    props: {
      collection: collection as unknown as SmrtWebCollection<
        Record<string, unknown>
      >,
      transport,
      onReady: (next: RemoteQueryBinding<Record<string, unknown>>) => {
        view = next as unknown as RemoteQueryBinding<Row>;
      },
    },
  });
  return {
    target,
    view,
    teardown: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('remoteQuery', () => {
  it('renders request and rows reactively through the Svelte binding', async () => {
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const mounted = mountView(collection, {
      query: async (received) => envelope(received, 'Ada'),
    });

    await mounted.view.execute(request);
    flushSync();

    expect(mounted.target.textContent).toContain('svelte-request:Ada');
    expect(mounted.view.result?.rows).toEqual([{ id: 'Ada', name: 'Ada' }]);
    mounted.teardown();
    await collection.cleanup();
  });

  it('disposes an in-flight refresh and live subscription when unmounted', async () => {
    let calls = 0;
    let unsubscribed = false;
    const collection = createSmrtCollection(definition, {
      fetchers: { list: async () => [], create: async () => ({}) },
    });
    const mounted = mountView(collection, {
      query: async (received, options) => {
        calls += 1;
        if (calls === 1) return envelope(received, 'initial');
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
      subscribe: () => ({
        unsubscribe: () => {
          unsubscribed = true;
        },
      }),
    });

    await mounted.view.execute(request);
    mounted.view.subscribeLive();
    const refresh = mounted.view.refresh();
    await vi.waitFor(() => expect(calls).toBe(2));
    mounted.teardown();

    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribed).toBe(true);
    await collection.cleanup();
  });
});
