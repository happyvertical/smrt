/**
 * Behavior tests for the Svelte 5 live-query binding over `@happyvertical/smrt-web`
 * (#1761, slice A).
 *
 * Per repo policy only the network boundary is mocked: the generated REST
 * client fetchers passed to `createSmrtCollection`. Everything else — the
 * client-data engine collection, the real `useLiveQuery` live view, its
 * transactions, and the runes reactivity — is real. The binding is exercised
 * through a thin host component (`harness.svelte`) so `useLiveQuery`'s internal
 * `$effect` has a genuine component-init scope, matching this package's other
 * runes-composable tests.
 */

import {
  createSmrtCollection,
  type SmrtCrudFetchers,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
} from '@happyvertical/smrt-web';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveCollection } from '../live-collection.svelte.js';
import Harness from './harness.svelte';

interface ProductData {
  id?: string;
  name: string;
  price?: number;
}

function productDefinition(
  name: string,
): SmrtWebCollectionDefinition<ProductData> {
  return {
    name,
    className: 'Product',
    endpoint: `/${name}`,
    idField: 'id',
    actions: ['create', 'get', 'list', 'update'],
    fields: {
      name: { type: 'text', required: true },
      price: { type: 'decimal' },
    },
  };
}

/**
 * Scripted stand-in for `createClient('/api/v1').products`: resolves like the
 * generated fetchers (JSON payloads, `{ error }` bodies on failure, never
 * rejects on HTTP status) so the engine's optimistic/rollback path is real.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  let failNextCreate: string | null = null;

  const fetchers: SmrtCrudFetchers = {
    list: async () => serverRows.map((row) => ({ ...row })),
    create: async (data) => {
      if (failNextCreate) {
        const error = failNextCreate;
        failNextCreate = null;
        return { error };
      }
      const created = { ...data, id: `server-${serverRows.length + 1}` };
      serverRows.push(created);
      return { ...created };
    },
  };

  return {
    fetchers,
    failCreateWith(message: string) {
      failNextCreate = message;
    },
  };
}

function mountView(handle: SmrtWebCollection<ProductData>): {
  view: LiveCollection<ProductData>;
  teardown: () => void;
} {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let exposed = undefined as unknown as LiveCollection<ProductData>;
  const component = mount(Harness, {
    target,
    props: {
      // The harness is typed against the base object shape; ProductData is a
      // structural subtype, so this cross-cast is purely nominal.
      handle: handle as unknown as SmrtWebCollection<Record<string, unknown>>,
      onReady: (view: LiveCollection<Record<string, unknown>>) => {
        exposed = view as unknown as LiveCollection<ProductData>;
      },
    },
  });
  return {
    view: exposed,
    teardown: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('liveCollection', () => {
  const cleanup: Array<() => void> = [];

  afterEach(async () => {
    for (const fn of cleanup.splice(0)) fn();
  });

  function track(mounted: {
    view: LiveCollection<ProductData>;
    teardown: () => void;
  }): LiveCollection<ProductData> {
    cleanup.push(mounted.teardown);
    return mounted.view;
  }

  it('exposes live rows that reflect the collection as plain DTOs (no $-prefixed keys)', async () => {
    const scripted = makeScriptedFetchers([
      { id: 'p1', name: 'Widget', price: 9.99 },
    ]);
    const collection = createSmrtCollection(productDefinition('live-dto'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });

    const view = track(mountView(collection));
    await collection.preload();
    flushSync();

    expect(view.isReady).toBe(true);
    expect(view.status).toBe('ready');
    expect(view.rows).toHaveLength(1);

    const [row] = view.rows;
    // Exact equality (not toMatchObject): must be a plain DTO — no
    // $synced/$origin/$key/$collectionId leaking through the engine live view.
    expect(row).toEqual({ id: 'p1', name: 'Widget', price: 9.99 });
    expect(Object.keys(row).some((key) => key.startsWith('$'))).toBe(false);
    expect(JSON.stringify(row)).not.toContain('$');
  });

  it('reports loading before the first read resolves', () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(productDefinition('live-loading'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
      // Do not eagerly preload — observe the initial loading status.
    });

    const view = track(mountView(collection));
    flushSync();

    expect(view.isLoading).toBe(true);
    expect(view.status).toBe('loading');
    expect(view.error).toBeNull();
  });

  it('reflects an optimistic insert reactively and settles its pending state', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(productDefinition('live-insert'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
    });

    const view = track(mountView(collection));
    await collection.preload();
    flushSync();
    expect(view.rows).toHaveLength(1);

    const mutation = view.insert({
      id: 'local-1',
      name: 'Gadget',
      price: 19.99,
    });
    flushSync();

    // Optimistic row is visible in the live rows synchronously, and pending.
    expect(view.rows.map((row) => row.name).sort()).toEqual([
      'Gadget',
      'Widget',
    ]);
    expect(mutation.pending).toBe(true);
    expect(mutation.settled).toBe(false);

    await mutation.done;
    flushSync();

    // Persisted: pending cleared, no error, and the server-assigned row is in.
    expect(mutation.pending).toBe(false);
    expect(mutation.settled).toBe(true);
    expect(mutation.error).toBeNull();
    const gadget = view.rows.find((row) => row.name === 'Gadget');
    expect(gadget?.id).toBe('server-2');
    // Still plain DTOs after the mutation reconciles.
    expect(Object.keys(gadget ?? {}).some((key) => key.startsWith('$'))).toBe(
      false,
    );
  });

  it('rolls the optimistic row back and surfaces the error when the create fails', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = createSmrtCollection(
      productDefinition('live-rollback'),
      {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
      },
    );

    const view = track(mountView(collection));
    await collection.preload();
    flushSync();

    scripted.failCreateWith('Validation failed: name is reserved');
    const mutation = view.insert({ id: 'local-2', name: 'FAIL Gadget' });
    flushSync();
    expect(view.rows.some((row) => row.name === 'FAIL Gadget')).toBe(true);

    // `done` resolves (never rejects) on settle — the failure is surfaced only
    // reactively via `error`, so a reactive-only consumer risks no unhandled
    // rejection.
    await expect(mutation.done).resolves.toBeUndefined();
    flushSync();

    // Optimistic state rolled back reactively; the mutation carries the error.
    expect(view.rows.some((row) => row.name === 'FAIL Gadget')).toBe(false);
    expect(view.rows).toHaveLength(1);
    expect(mutation.pending).toBe(false);
    expect(mutation.settled).toBe(true);
    expect(String((mutation.error as Error)?.message)).toContain(
      'Validation failed: name is reserved',
    );
  });
});
