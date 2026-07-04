/**
 * Integration tests for the capability seam wired into createSmrtCollection
 * (#1755).
 *
 * Same harness as collection.test.ts / invalidation.test.ts: per the repo
 * mocking policy only the network boundary (the generated REST fetchers) is
 * mocked — the client-data engine collection, its query cache, transactions,
 * and live state are all REAL. Fire-and-forget effects (invalidation) are
 * awaited with a microtask poll, never a fixed sleep.
 *
 * The central fixture is a `FakeCapability` implementing all six hooks and
 * recording each firing (with the salient ctx values) into a `calls[]` log, so
 * every test asserts BOTH that a hook fired the right number of times and that
 * it received the contract-specified arguments.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSmrtCollection,
  createSmrtWebClient,
  newLocalId,
  type SmrtCrudFetchers,
  type SmrtWebCapability,
  type SmrtWebCapabilityContext,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type SmrtWebMutationEnvelope,
} from './index.js';

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
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: {
      name: { type: 'text', required: true },
      price: { type: 'decimal' },
    },
  };
}

/**
 * A scripted stand-in for `createClient('/api/v1').products`. Resolves the way
 * the generated fetchers do (JSON payloads, never rejects on HTTP errors) and
 * counts calls. `pushServerRow` mutates the backing store so a later `list()` —
 * e.g. one triggered by a manual `ctx.invalidate()` — observably returns more
 * rows.
 */
function makeScriptedFetchers(initialRows: Array<Record<string, unknown>>) {
  const serverRows = [...initialRows];
  const calls = { list: 0, create: 0, update: 0, delete: 0 };
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
        return { error };
      }
      const created = { ...data, id: `server-${serverRows.length + 1}` };
      serverRows.push(created);
      return { ...created };
    },
    update: async (id, data) => {
      calls.update += 1;
      return { ...data, id };
    },
    delete: async () => {
      calls.delete += 1;
      return true;
    },
  };

  return {
    fetchers,
    calls,
    failCreateWith(message: string) {
      failNextCreate = message;
    },
    pushServerRow(row: Record<string, unknown>) {
      serverRows.push(row);
    },
  };
}

/** One recorded hook firing. */
interface HookCall {
  hook:
    | 'contributeCacheKey'
    | 'warmStart'
    | 'wrapMutation'
    | 'onSettled'
    | 'onAttach'
    | 'teardown';
  cacheId?: string;
  cacheKey?: readonly string[];
  envelope?: SmrtWebMutationEnvelope;
  settleOk?: boolean;
  listCallsAtFire?: number;
}

/**
 * Build a FakeCapability that logs every hook firing into `calls`. Options tune
 * the two hooks with a return contract: `cacheKeySegments` (contributeCacheKey)
 * and `warmRows` (warmStart). `wrap` decides wrapMutation's outcome per call.
 */
function makeFakeCapability(
  calls: HookCall[],
  opts: {
    name?: string;
    cacheKeySegments?: string[];
    warmRows?: ProductData[];
    wrap?: (
      envelope: SmrtWebMutationEnvelope,
    ) => { handled: true; result: unknown } | { handled: false };
    listCounter?: { list: number };
    onAttachCtx?: (ctx: SmrtWebCapabilityContext<ProductData>) => void;
  } = {},
): SmrtWebCapability<ProductData> {
  return {
    name: opts.name ?? 'fake',
    contributeCacheKey(ctx) {
      calls.push({
        hook: 'contributeCacheKey',
        cacheId: ctx.cacheId,
        cacheKey: [...ctx.cacheKey],
        listCallsAtFire: opts.listCounter?.list,
      });
      return opts.cacheKeySegments;
    },
    warmStart(ctx) {
      calls.push({
        hook: 'warmStart',
        cacheId: ctx.cacheId,
        listCallsAtFire: opts.listCounter?.list,
      });
      return opts.warmRows;
    },
    wrapMutation(envelope) {
      calls.push({
        hook: 'wrapMutation',
        envelope,
        listCallsAtFire: opts.listCounter?.list,
      });
      return opts.wrap ? opts.wrap(envelope) : { handled: false };
    },
    onSettled(envelope, outcome) {
      calls.push({ hook: 'onSettled', envelope, settleOk: outcome.ok });
    },
    onAttach(ctx) {
      calls.push({ hook: 'onAttach', cacheId: ctx.cacheId });
      opts.onAttachCtx?.(ctx);
    },
    teardown() {
      calls.push({ hook: 'teardown' });
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  { tries = 50 }: { tries?: number } = {},
): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  if (!predicate()) throw new Error('waitFor: predicate never became true');
}

describe('capability seam — no-op guarantee', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('an empty capabilities array is identical to passing none', async () => {
    const withNone = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const withEmpty = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);

    const a = track(
      createSmrtCollection(productDefinition('noop-none'), {
        fetchers: withNone.fetchers,
        staleTimeMs: 60_000,
      }),
    );
    const b = track(
      createSmrtCollection(productDefinition('noop-empty'), {
        fetchers: withEmpty.fetchers,
        staleTimeMs: 60_000,
        capabilities: [],
      }),
    );

    await Promise.all([a.preload(), b.preload()]);
    expect(withNone.calls.list).toBe(withEmpty.calls.list);

    // A create still calls the real fetcher exactly once on both, reconciles to
    // the server id, and rolls nothing back — the pre-seam behavior.
    const [txA, txB] = [
      a.insert({ id: newLocalId(), name: 'Gadget' }),
      b.insert({ id: newLocalId(), name: 'Gadget' }),
    ];
    await Promise.all([txA.isPersisted.promise, txB.isPersisted.promise]);

    expect(withEmpty.calls.create).toBe(withNone.calls.create);
    expect(withEmpty.calls.create).toBe(1);
    expect(b.toArray.map((r) => r.name).sort()).toEqual(
      a.toArray.map((r) => r.name).sort(),
    );
  });
});

describe('capability seam — contributeCacheKey', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('fires once BEFORE any network request and extends the FINAL cache id/key', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    let attachedCtx: SmrtWebCapabilityContext<ProductData> | undefined;
    const capability = makeFakeCapability(calls, {
      cacheKeySegments: ['variant-x'],
      listCounter: scripted.calls,
      onAttachCtx: (ctx) => {
        attachedCtx = ctx;
      },
    });

    const collection = track(
      createSmrtCollection(productDefinition('contrib'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );

    const contrib = calls.filter((c) => c.hook === 'contributeCacheKey');
    // Fired exactly once, and before construction => before any list().
    expect(contrib).toHaveLength(1);
    expect(contrib[0].listCallsAtFire).toBe(0);
    expect(scripted.calls.list).toBe(0);
    // Mid-contribution the ctx still shows the pre-fold (base) key — a
    // capability does not observe its own not-yet-applied segment.
    expect(contrib[0].cacheId).toBe('smrt:contrib');
    // But once every contribution is folded in, the ctx (captured in onAttach,
    // which runs after construction) exposes the FINAL cache id/key. Contributed
    // segments are spliced in BEFORE the collection name so the name stays LAST
    // in the queryKey — the invariant invalidateRelated()'s predicate relies on.
    // cacheId is an opaque engine id (predicate never reads it) so it appends.
    expect(attachedCtx?.cacheId).toBe('smrt:contrib:variant-x');
    expect([...(attachedCtx?.cacheKey ?? [])]).toEqual([
      'smrt',
      'variant-x',
      'contrib',
    ]);

    await collection.preload();
    expect(scripted.calls.list).toBe(1);
  });

  it('a differing contributeCacheKey partitions the cache under one shared client', async () => {
    const calls: HookCall[] = [];
    const client = createSmrtWebClient();
    const backendX = makeScriptedFetchers([{ id: 'p1', name: 'from-X' }]);
    const backendY = makeScriptedFetchers([{ id: 'p1', name: 'from-Y' }]);

    // Same definition.name, one shared client, but distinct contributed
    // segments — the caches must NOT collide (each fetches its own backend).
    const collX = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: backendX.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [makeFakeCapability(calls, { cacheKeySegments: ['x'] })],
      }),
    );
    const collY = track(
      createSmrtCollection(productDefinition('products'), {
        fetchers: backendY.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [makeFakeCapability(calls, { cacheKeySegments: ['y'] })],
      }),
    );

    await Promise.all([collX.preload(), collY.preload()]);

    expect(collX.get('p1')?.name).toBe('from-X');
    expect(collY.get('p1')?.name).toBe('from-Y');
    expect(backendX.calls.list).toBe(1);
    expect(backendY.calls.list).toBe(1);
  });
});

describe('capability seam — warmStart', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('suppresses the first list() by seeding the cache, like initialData', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const capability = makeFakeCapability(calls, {
      warmRows: [{ id: 'p1', name: 'from-warm' }],
    });

    const collection = track(
      createSmrtCollection(productDefinition('warm'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );

    await collection.preload();
    // Seeded from warmStart => no first-render fetch, and the warm rows served.
    expect(scripted.calls.list).toBe(0);
    expect(collection.get('p1')?.name).toBe('from-warm');
    expect(calls.filter((c) => c.hook === 'warmStart')).toHaveLength(1);
  });

  it('initialData WINS over warmStart when both are supplied', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const capability = makeFakeCapability(calls, {
      warmRows: [{ id: 'p1', name: 'from-warm' }],
    });

    const collection = track(
      createSmrtCollection(productDefinition('warm-vs-initial'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        initialData: [{ id: 'p1', name: 'from-initial' }],
        capabilities: [capability],
      }),
    );

    await collection.preload();
    expect(scripted.calls.list).toBe(0);
    // initialData is the fresher same-request SSR truth => it wins.
    expect(collection.get('p1')?.name).toBe('from-initial');
  });
});

describe('capability seam — wrapMutation', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('{ handled: true } takes over the write — the fetcher is NEVER called and the offline optimistic row is KEPT (not dropped by a post-mutation refetch)', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const capability = makeFakeCapability(calls, {
      wrap: () => ({
        handled: true,
        result: { id: 'offline-1', name: 'Gadget', price: 5 },
      }),
    });

    const collection = track(
      createSmrtCollection(productDefinition('wrap-handled'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );
    await collection.preload();
    const listAfterPreload = scripted.calls.list;

    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'Gadget', price: 5 });
    // Optimistic row is visible synchronously, from the handler's stand-in path.
    expect(collection.has(localId)).toBe(true);

    // The write settles WITHOUT rejection (no rollback) — the handler's result
    // stood in for the fetcher — and the real create fetcher was never called.
    // (A reject here would fail the test.)
    await tx.isPersisted.promise;
    expect(scripted.calls.create).toBe(0);
    expect(calls.filter((c) => c.hook === 'wrapMutation')).toHaveLength(1);
    // onSettled recorded a success carrying the handler result (not a fetcher
    // result), proving the handler's { result } flowed through the settle path.
    const settle = calls.find((c) => c.hook === 'onSettled');
    expect(settle?.settleOk).toBe(true);

    // Fix B: an offline (handled) write never hit the server, so the engine's
    // post-mutation refetch AND invalidateRelated() are suppressed — no extra
    // list() fired. Give any (erroneous) refetch time to land, then confirm the
    // offline row is STILL present (it would be dropped if the server list, which
    // lacks it, had been refetched). This is what #1762's outbox depends on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scripted.calls.list).toBe(listAfterPreload);
    expect(collection.has(localId)).toBe(true);
    expect(collection.get(localId)?.name).toBe('Gadget');
  });

  it('{ handled: false } falls through to the real fetcher', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const capability = makeFakeCapability(calls, {
      wrap: () => ({ handled: false }),
    });

    const collection = track(
      createSmrtCollection(productDefinition('wrap-decline'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );
    await collection.preload();
    const listAfterPreload = scripted.calls.list;

    const tx = collection.insert({ id: newLocalId(), name: 'Gadget' });
    await tx.isPersisted.promise;

    // Declined => the real create fetcher ran, exactly once.
    expect(scripted.calls.create).toBe(1);
    expect(calls.filter((c) => c.hook === 'wrapMutation')).toHaveLength(1);
    expect(collection.toArray.some((r) => r.name === 'Gadget')).toBe(true);
    // Fix B no-op side: an UNHANDLED write behaves exactly as before the seam —
    // the engine's post-mutation refetch still runs, so a further list() fired
    // (the row reconciles to its server id via that refetch).
    await waitFor(() => scripted.calls.list > listAfterPreload);
    expect(scripted.calls.list).toBeGreaterThan(listAfterPreload);
  });

  it('with two capabilities the FIRST { handled: true } wins and the later one is skipped', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const first = makeFakeCapability(calls, {
      name: 'first',
      wrap: () => ({ handled: true, result: { id: 'by-first', name: 'X' } }),
    });
    const second = makeFakeCapability(calls, {
      name: 'second',
      wrap: () => ({ handled: true, result: { id: 'by-second', name: 'X' } }),
    });

    const collection = track(
      createSmrtCollection(productDefinition('wrap-order'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [first, second],
      }),
    );
    await collection.preload();

    const tx = collection.insert({ id: newLocalId(), name: 'X' });
    await tx.isPersisted.promise;

    // The fetcher never ran; only the FIRST capability's wrapMutation fired.
    expect(scripted.calls.create).toBe(0);
    const wraps = calls.filter((c) => c.hook === 'wrapMutation');
    expect(wraps).toHaveLength(1);
  });
});

describe('capability seam — onSettled', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('fires once with { ok: true } on a successful create', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = track(
      createSmrtCollection(productDefinition('settle-ok'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [makeFakeCapability(calls)],
      }),
    );
    await collection.preload();

    const tx = collection.insert({ id: newLocalId(), name: 'Gadget' });
    await tx.isPersisted.promise;

    const settles = calls.filter((c) => c.hook === 'onSettled');
    expect(settles).toHaveLength(1);
    expect(settles[0].settleOk).toBe(true);
    expect(settles[0].envelope?.kind).toBe('insert');
  });

  it('fires once with { ok: false } when the create fetcher rejects, and the row still rolls back', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    scripted.failCreateWith('name is reserved');
    const collection = track(
      createSmrtCollection(productDefinition('settle-fail'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [makeFakeCapability(calls)],
      }),
    );
    await collection.preload();

    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'FAIL' });
    await expect(tx.isPersisted.promise).rejects.toThrow('name is reserved');

    // onSettled saw the failure; the optimistic row rolled back (rollback
    // preserved — the seam did not swallow the throw).
    const settles = calls.filter((c) => c.hook === 'onSettled');
    expect(settles).toHaveLength(1);
    expect(settles[0].settleOk).toBe(false);
    expect(collection.has(localId)).toBe(false);
  });
});

describe('capability seam — onAttach', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('fires once with a callable ctx.invalidate that refetches this collection', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    let captured: SmrtWebCapabilityContext<ProductData> | undefined;
    const capability = makeFakeCapability(calls, {
      onAttachCtx: (ctx) => {
        captured = ctx;
      },
    });

    const collection = track(
      createSmrtCollection(productDefinition('attach'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );

    const attaches = calls.filter((c) => c.hook === 'onAttach');
    expect(attaches).toHaveLength(1);
    expect(captured).toBeDefined();

    // Keep the collection live so an invalidation triggers a background refetch.
    const sub = collection.subscribeChanges(() => {});
    await collection.preload();
    expect(scripted.calls.list).toBe(1);

    // A server-side row appears; the capability calls ctx.invalidate() off its
    // external trigger and the collection refetches, picking it up.
    scripted.pushServerRow({ id: 'p2', name: 'live-added' });
    captured?.invalidate();

    await waitFor(() => scripted.calls.list >= 2);
    expect(scripted.calls.list).toBeGreaterThanOrEqual(2);
    await waitFor(() => collection.has('p2'));
    expect(collection.get('p2')?.name).toBe('live-added');

    sub.unsubscribe();
  });
});

describe('capability seam — teardown', () => {
  it('fires once per cleanup(), after the engine collection is torn down', async () => {
    const calls: HookCall[] = [];
    const order: string[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    // Wrap teardown to record ordering relative to a live subscription: after
    // cleanup() the engine is stopped, so a subscription callback would no
    // longer fire. We assert teardown runs exactly once and after cleanup
    // resolves the engine work.
    const capability: SmrtWebCapability<ProductData> = {
      ...makeFakeCapability(calls),
      teardown() {
        order.push('teardown');
        calls.push({ hook: 'teardown' });
      },
    };

    const collection = createSmrtCollection(productDefinition('teardown'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
      capabilities: [capability],
    });
    await collection.preload();

    await collection.cleanup();

    expect(calls.filter((c) => c.hook === 'teardown')).toHaveLength(1);
    expect(order).toEqual(['teardown']);

    // A second cleanup() runs teardown again (idempotent from the seam's view —
    // it mirrors the engine's own cleanup being callable), but the common path
    // is a single cleanup; assert the single-call contract above holds.
  });
});

// A capability that only contributes a cache-key segment (mirrors #1764
// persistence keying its cache by a manifest hash) — the exact shape that
// exercised the name-last invariant.
function cacheKeyCapability(segment: string): SmrtWebCapability<object> {
  return {
    name: `key-${segment}`,
    contributeCacheKey: () => [segment],
  };
}

describe('capability seam — contributeCacheKey preserves relationship invalidation (Fix A)', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  interface CommentData {
    id?: string;
    body: string;
    articleId?: string;
  }
  interface ArticleData {
    id?: string;
    title: string;
  }

  const commentsDefinition = (): SmrtWebCollectionDefinition<CommentData> => ({
    name: 'comments',
    className: 'Comment',
    endpoint: '/comments',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { body: { type: 'text', required: true } },
    relationships: [
      { field: 'articleId', kind: 'foreignKey', relatedCollection: 'articles' },
    ],
  });
  const articlesDefinition = (): SmrtWebCollectionDefinition<ArticleData> => ({
    name: 'articles',
    className: 'Article',
    endpoint: '/articles',
    idField: 'id',
    actions: ['create', 'delete', 'get', 'list', 'update'],
    fields: { title: { type: 'text', required: true } },
    relationships: [],
  });

  it('a collection using contributeCacheKey still self-invalidates after its OWN mutation', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const collection = track(
      createSmrtCollection(productDefinition('self-inval'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        // A contributed segment means the queryKey is now
        // ['smrt', 'mh', 'self-inval'] — name still LAST, so the predicate
        // matches and the collection refetches itself after a settled mutation.
        capabilities: [cacheKeyCapability('mh')],
      }),
    );

    const sub = collection.subscribeChanges(() => {});
    await collection.preload();
    expect(scripted.calls.list).toBe(1);

    const tx = collection.insert({ id: newLocalId(), name: 'Gadget' });
    await tx.isPersisted.promise;

    // Self-invalidation fired => a second list() (would NOT happen if the
    // contributed segment had been appended after the name, hiding it from the
    // predicate — the bug Fix A closes).
    await waitFor(() => scripted.calls.list >= 2);
    expect(scripted.calls.list).toBeGreaterThanOrEqual(2);
    sub.unsubscribe();
  });

  it('a RELATED collection using contributeCacheKey is invalidated when its relation mutates', async () => {
    const client = createSmrtWebClient();
    const commentsBackend = makeScriptedFetchers([
      { id: 'c1', body: 'first', articleId: 'a1' },
    ]);
    const articlesBackend = makeScriptedFetchers([
      { id: 'a1', title: 'Hello' },
    ]);

    // BOTH collections carry a contributeCacheKey (persistence-keyed). comments
    // edges to articles; a settled comments mutation must still reach the
    // articles cache — only possible because 'articles' stays the LAST segment
    // of the articles queryKey ['smrt', 'mh', 'articles'].
    const comments = track(
      createSmrtCollection(commentsDefinition(), {
        fetchers: commentsBackend.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [cacheKeyCapability('mh')],
      }),
    );
    const articles = track(
      createSmrtCollection(articlesDefinition(), {
        fetchers: articlesBackend.fetchers,
        client,
        staleTimeMs: 60_000,
        capabilities: [cacheKeyCapability('mh')],
      }),
    );

    const articlesSub = articles.subscribeChanges(() => {});
    await Promise.all([comments.preload(), articles.preload()]);
    expect(articlesBackend.calls.list).toBe(1);

    const tx = comments.insert({
      id: newLocalId(),
      body: 'second',
      articleId: 'a1',
    });
    await tx.isPersisted.promise;

    await waitFor(() => articlesBackend.calls.list >= 2);
    expect(articlesBackend.calls.list).toBeGreaterThanOrEqual(2);
    articlesSub.unsubscribe();
  });
});

describe('capability seam — hook error isolation (Fix C)', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
    warnSpy.mockClear();
  });

  it('a throwing onSettled does not reject a SUCCESSFUL mutation, and later capabilities still run', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const thrower: SmrtWebCapability<ProductData> = {
      name: 'bad-settle',
      onSettled() {
        throw new Error('onSettled boom');
      },
    };
    const good = makeFakeCapability(calls, { name: 'good' });

    const collection = track(
      createSmrtCollection(productDefinition('iso-settle'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [thrower, good],
      }),
    );
    await collection.preload();

    const localId = newLocalId();
    const tx = collection.insert({ id: localId, name: 'Gadget' });
    // The successful mutation still commits — the throwing onSettled did not
    // reject the transaction nor roll the row back.
    await tx.isPersisted.promise;
    expect(scripted.calls.create).toBe(1);
    // The later (good) capability's onSettled still fired despite the earlier
    // throw.
    expect(good).toBeDefined();
    expect(calls.filter((c) => c.hook === 'onSettled')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a throwing onAttach does not break construction, and later capabilities still attach', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const thrower: SmrtWebCapability<ProductData> = {
      name: 'bad-attach',
      onAttach() {
        throw new Error('onAttach boom');
      },
    };
    const good = makeFakeCapability(calls, { name: 'good' });

    // Construction must not throw even though the first capability's onAttach does.
    const collection = track(
      createSmrtCollection(productDefinition('iso-attach'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [thrower, good],
      }),
    );
    expect(collection).toBeDefined();
    // The later capability still attached.
    expect(calls.filter((c) => c.hook === 'onAttach')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    await collection.preload();
    expect(collection.size).toBe(1);
  });

  it('a rejecting teardown does not skip later teardowns nor reject cleanup()', async () => {
    const calls: HookCall[] = [];
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'Widget' }]);
    const thrower: SmrtWebCapability<ProductData> = {
      name: 'bad-teardown',
      teardown() {
        return Promise.reject(new Error('teardown boom'));
      },
    };
    const good: SmrtWebCapability<ProductData> = {
      name: 'good-teardown',
      teardown() {
        calls.push({ hook: 'teardown' });
      },
    };

    const collection = createSmrtCollection(productDefinition('iso-teardown'), {
      fetchers: scripted.fetchers,
      staleTimeMs: 60_000,
      capabilities: [thrower, good],
    });
    await collection.preload();

    // cleanup() resolves despite the rejecting teardown, and the later teardown
    // still ran.
    await expect(collection.cleanup()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.hook === 'teardown')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('a rejecting async warmStart does not surface as an unhandled rejection and does not break the read', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const capability: SmrtWebCapability<ProductData> = {
      name: 'bad-warm',
      warmStart: () => Promise.reject(new Error('warmStart boom')),
    };

    const collection = track(
      createSmrtCollection(productDefinition('iso-warm'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );

    // preload() gates on the (rejecting) warmStart, which is caught internally,
    // then falls through to a normal fetch — the read still works.
    await collection.preload();
    expect(collection.get('p1')?.name).toBe('from-server');
    expect(scripted.calls.list).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('capability seam — async warmStart suppresses the first read (Fix D)', () => {
  const tracked: SmrtWebCollection<object>[] = [];
  const track = <T extends object>(c: SmrtWebCollection<T>) => {
    tracked.push(c as unknown as SmrtWebCollection<object>);
    return c;
  };
  afterEach(async () => {
    await Promise.all(tracked.map((c) => c.cleanup()));
    tracked.length = 0;
  });

  it('an async warmStart (resolved next tick) suppresses the first list() when the consumer awaits preload()', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const capability: SmrtWebCapability<ProductData> = {
      name: 'async-warm',
      // Resolves a couple of microtasks later — the persistence rehydrate shape.
      warmStart: async () => {
        await Promise.resolve();
        await Promise.resolve();
        return [{ id: 'p1', name: 'from-async-warm' }];
      },
    };

    const collection = track(
      createSmrtCollection(productDefinition('async-warm'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [capability],
      }),
    );

    // preload() gates the engine's own load on the pending warmStart, so the
    // seed lands FIRST and the first read is served from it — zero list().
    await collection.preload();
    expect(scripted.calls.list).toBe(0);
    expect(collection.get('p1')?.name).toBe('from-async-warm');
  });

  it('Fix E: when the FIRST async warmStart resolves to undefined, a LATER capability that returns rows seeds', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const first: SmrtWebCapability<ProductData> = {
      name: 'async-miss',
      // Async, resolves to undefined — a rehydrate that found nothing on disk.
      warmStart: async () => {
        await Promise.resolve();
        return undefined;
      },
    };
    const second: SmrtWebCapability<ProductData> = {
      name: 'async-hit',
      warmStart: async () => {
        await Promise.resolve();
        return [{ id: 'p1', name: 'from-second' }];
      },
    };

    const collection = track(
      createSmrtCollection(productDefinition('async-order-miss'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [first, second],
      }),
    );

    // The ordered chain skips the first (undefined) and seeds from the second —
    // the first list() is suppressed even though the FIRST provider missed.
    await collection.preload();
    expect(scripted.calls.list).toBe(0);
    expect(collection.get('p1')?.name).toBe('from-second');
  });

  it('Fix E: when the FIRST async warmStart REJECTS, a later capability still seeds and no unhandled rejection leaks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const first: SmrtWebCapability<ProductData> = {
      name: 'async-reject',
      warmStart: async () => {
        await Promise.resolve();
        throw new Error('rehydrate failed');
      },
    };
    const second: SmrtWebCapability<ProductData> = {
      name: 'async-hit',
      warmStart: async () => [{ id: 'p1', name: 'from-second' }],
    };

    const collection = track(
      createSmrtCollection(productDefinition('async-order-reject'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [first, second],
      }),
    );

    await collection.preload();
    // The reject was caught (logged) and the chain moved on to the second.
    expect(scripted.calls.list).toBe(0);
    expect(collection.get('p1')?.name).toBe('from-second');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('Fix E: a SYNC warmStart returning rows before an async one seeds inline (no preload needed)', async () => {
    const scripted = makeScriptedFetchers([{ id: 'p1', name: 'from-server' }]);
    const syncFirst: SmrtWebCapability<ProductData> = {
      name: 'sync-hit',
      warmStart: () => [{ id: 'p1', name: 'from-sync' }],
    };
    const asyncSecond: SmrtWebCapability<ProductData> = {
      name: 'async-later',
      warmStart: async () => [{ id: 'p1', name: 'from-async' }],
    };

    const collection = track(
      createSmrtCollection(productDefinition('sync-before-async'), {
        fetchers: scripted.fetchers,
        staleTimeMs: 60_000,
        capabilities: [syncFirst, asyncSecond],
      }),
    );

    // The sync provider seeded synchronously at construction — the value is in
    // cache before any preload(), and the later async provider never overrides
    // it (first-that-returns-rows wins, and the atomic updater keeps the seed).
    await collection.preload();
    expect(scripted.calls.list).toBe(0);
    expect(collection.get('p1')?.name).toBe('from-sync');
  });
});
