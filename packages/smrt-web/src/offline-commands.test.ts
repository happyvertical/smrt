/**
 * Consumer-declared replay transports for the offline outbox (#3021).
 *
 * `offlineOutbox({ transport })` and `offlineCommandQueue()` replay queued
 * writes through a server operation the consumer owns instead of the generated
 * `sync/apply`. Real fake-indexeddb backs the durable queue; the transport and
 * `fetch` are the scripted boundaries.
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SmrtWebCapabilityContext } from './capability.js';
import {
  classifySmrtWebDataSurfaceActionResult,
  dataSurfaceActionCommandTransport,
  type SmrtWebDataSurfaceActionRequest,
  type SmrtWebDataSurfaceActionTransport,
} from './data-surface-actions.js';
import {
  type DurableStoreKey,
  durableStoreNamespace,
  wipeDurableStore,
} from './durable-store.js';
import { OutboxEngine } from './offline/engine.js';
import {
  getOutboxHandle,
  type OfflineCommandQueue,
  type OutboxCommand,
  type OutboxCommandResult,
  type OutboxConflict,
  offlineCommandQueue,
  offlineOutbox,
  type SyncStateEvent,
} from './offline.js';

let nsCounter = 0;
function uniqueKey(): DurableStoreKey {
  nsCounter += 1;
  return {
    apiBase: '/api/v1',
    manifestHash: `cmd-${nsCounter}-${Math.random().toString(36).slice(2)}`,
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
      actions: [],
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

/** A fetch that records every sync-apply POST and applies every item. */
function recordingFetch(urls: string[], ids: string[][]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      items: Array<{ itemId: string; id: string }>;
    };
    urls.push(url);
    ids.push(body.items.map((item) => item.id));
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

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0)) await dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});

function queue(
  config: Parameters<typeof offlineCommandQueue>[0],
): OfflineCommandQueue {
  const q = offlineCommandQueue(config);
  disposers.push(() => q.dispose());
  return q;
}

describe('offlineOutbox({ transport }) — collection writes through a declared operation', () => {
  it('replays through the transport with the durable idempotency key and never calls sync/apply', async () => {
    const key = uniqueKey();
    const commands: OutboxCommand[] = [];
    const fetchFn = vi.fn();
    const states: SyncStateEvent[] = [];
    const cap = offlineOutbox({
      object: { name: 'time_punches' },
      namespace: key,
      fetchFn: fetchFn as unknown as typeof fetch,
      transport: async (command) => {
        commands.push(command);
        return { status: 'applied' };
      },
      onSyncStateChange: (e) => states.push(e),
    });
    const ctx = fakeCtx('time_punches');
    cap.onAttach?.(ctx);
    disposers.push(async () => {
      await cap.teardown?.(ctx);
    });

    const rowId = '31313131-3131-4131-8131-313131313131';
    const outcome = await cap.wrapMutation?.(
      { kind: 'insert', key: rowId, data: { id: rowId, kind: 'in' } },
      ctx,
    );
    expect(outcome).toEqual({
      handled: true,
      result: { id: rowId, kind: 'in' },
    });

    await waitFor(() => states.some((s) => s.state === 'synced'));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command).toMatchObject({
      name: 'time_punches',
      op: 'create',
      rowId,
      payload: { id: rowId, kind: 'in' },
      attempt: 1,
    });
    expect(command.idempotencyKey).toBe(states[0].itemId);
    expect(states.map((s) => s.state)).toEqual([
      'pending',
      'uploading',
      'synced',
    ]);
  });
});

describe('offlineCommandQueue — writes with no generated collection', () => {
  it('rejects a missing name or transport', () => {
    expect(() =>
      offlineCommandQueue({
        name: '',
        namespace: uniqueKey(),
        transport: async () => ({ status: 'applied' }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      offlineCommandQueue({
        name: 'punch',
        namespace: uniqueKey(),
        transport: undefined as unknown as () => Promise<OutboxCommandResult>,
      }),
    ).toThrow(TypeError);
  });

  it('resends the SAME idempotency key after an ambiguous failure, with backoff and attempt count', async () => {
    const key = uniqueKey();
    const commands: OutboxCommand[] = [];
    const states: SyncStateEvent[] = [];
    const q = queue({
      name: 'clock_in',
      namespace: key,
      backoff: { initialDelayMs: 100_000, maxDelayMs: 100_000 },
      random: () => 1,
      transport: async (command) => {
        commands.push(command);
        if (commands.length === 1) throw new Error('response lost');
        return { status: 'applied' };
      },
      onSyncStateChange: (e) => states.push(e),
    });

    const itemId = await q.enqueue({ payload: { employee: 'self' } });
    expect(itemId).toBeTypeOf('string');
    await waitFor(() => states.some((s) => s.state === 'pending' && s.error));
    const [held] = await q.snapshot();
    expect(held).toMatchObject({
      itemId,
      rowId: itemId,
      transport: 'clock_in',
      state: 'pending',
      attempts: 1,
      lastError: 'network error during command replay',
    });
    expect(held.nextAttemptAt).toBeGreaterThan(Date.now() + 50_000);

    await q.retry(itemId as string);
    await waitFor(() => states.some((s) => s.state === 'synced'));
    expect(commands.map((c) => [c.idempotencyKey, c.attempt])).toEqual([
      [itemId, 1],
      [itemId, 2],
    ]);
    expect(await q.snapshot()).toEqual([]);
  });

  it('maps outcomes onto the shared state machine', async () => {
    const outcomes: OutboxCommandResult[] = [
      { status: 'conflict', reason: 'create_conflict', updatedAt: 'T1' },
      { status: 'rejected', reason: 'clock_locked' },
      { status: 'rejected', reason: 'write_failed' },
    ];
    const states: SyncStateEvent[] = [];
    const conflicts: OutboxConflict[] = [];
    const q = queue({
      name: 'punch',
      namespace: uniqueKey(),
      backoff: { initialDelayMs: 100_000, maxDelayMs: 100_000 },
      random: () => 1,
      transport: async () => outcomes.shift() ?? { status: 'applied' },
      onSyncStateChange: (e) => states.push(e),
      onConflict: (c) => conflicts.push(c),
    });

    const conflicted = await q.enqueue({ rowId: 'r-1', op: 'update' });
    await waitFor(() =>
      states.some((s) => s.itemId === conflicted && s.state === 'synced'),
    );
    expect(conflicts).toEqual([
      {
        itemId: conflicted,
        object: 'punch',
        rowId: 'r-1',
        reason: 'create_conflict',
        serverUpdatedAt: 'T1',
      },
    ]);

    const terminal = await q.enqueue({ rowId: 'r-2' });
    await waitFor(() =>
      states.some((s) => s.itemId === terminal && s.state === 'failed'),
    );
    expect(
      states.find((s) => s.itemId === terminal && s.state === 'failed')?.error,
    ).toBe('sync clock_locked');

    const retryable = await q.enqueue({ rowId: 'r-3' });
    await waitFor(() =>
      states.some(
        (s) => s.itemId === retryable && s.state === 'pending' && s.error,
      ),
    );
    expect(await q.snapshot()).toMatchObject([
      { itemId: retryable, attempts: 1, lastError: 'sync write_failed' },
    ]);
  });

  it('pauses the whole loop on auth_required until retry', async () => {
    let authed = false;
    const sent: string[] = [];
    const states: SyncStateEvent[] = [];
    const q = queue({
      name: 'punch',
      namespace: uniqueKey(),
      transport: async (command) => {
        sent.push(command.rowId);
        return authed
          ? { status: 'applied' }
          : { status: 'rejected', reason: 'auth_required' };
      },
      onSyncStateChange: (e) => states.push(e),
    });
    const first = await q.enqueue({ rowId: 'a' });
    await waitFor(() => states.some((s) => s.error === 'sync auth_required'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['a']);

    authed = true;
    await q.retry(first as string);
    await waitFor(() => states.some((s) => s.state === 'synced'));
    expect(sent).toEqual(['a', 'a']);
  });

  it('keeps FIFO per route across transport and sync-apply rows, and a command queue never pins the sync-apply base path', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const key = uniqueKey();
    const order: string[] = [];
    const q = queue({
      name: 'punch',
      namespace: key,
      transport: async (command) => {
        order.push(`command:${command.rowId}`);
        return { status: 'applied' };
      },
    });
    // The command queue created the engine first; the collection's base path
    // must still be the one sync-apply rows POST to.
    const urls: string[] = [];
    const posted: string[][] = [];
    const recording = recordingFetch(urls, posted);
    const cap = offlineOutbox({
      object: { name: 'notes' },
      namespace: key,
      syncApplyBasePath: '/api',
      fetchFn: (async (url: string, init?: RequestInit) => {
        const response = await recording(url, init);
        order.push(`sync:${posted.at(-1)?.join(',')}`);
        return response;
      }) as unknown as typeof fetch,
    });
    const ctx = fakeCtx('notes');
    cap.onAttach?.(ctx);
    disposers.push(async () => {
      await cap.teardown?.(ctx);
    });

    const note = (id: string) =>
      cap.wrapMutation?.({ kind: 'insert', key: id, data: { id } }, ctx);
    await note('n-1');
    const commandId = await q.enqueue({ rowId: 'c-1' });
    await note('n-2');

    vi.stubGlobal('navigator', { onLine: true });
    await q.retry(commandId as string);
    await waitFor(() => posted.length === 1 && order.includes('command:c-1'));

    // FIFO is per route: sync-apply rows keep their order (one batch here) and
    // the command replays through its own route.
    expect(urls).toEqual(['/api/sync/apply']);
    expect(order.filter((o) => o.startsWith('sync:'))).toEqual([
      'sync:n-1,n-2',
    ]);
    expect(order).toContain('command:c-1');
    expect(await q.snapshot()).toEqual([]);
  });

  it('holds a reloaded transport row until its queue re-attaches, never re-routing it to sync/apply', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const key = uniqueKey();
    const first = offlineCommandQueue({
      name: 'flha_submit',
      namespace: key,
      transport: async () => ({ status: 'applied' }),
    });
    const itemId = await first.enqueue({ payload: { answers: [1, 2] } });
    await first.dispose();

    // "Reload": only a sync-apply collection attaches at first.
    vi.stubGlobal('navigator', { onLine: true });
    const urls: string[] = [];
    const posted: string[][] = [];
    const cap = offlineOutbox({
      object: { name: 'notes' },
      namespace: key,
      fetchFn: recordingFetch(urls, posted),
    });
    const ctx = fakeCtx('notes');
    cap.onAttach?.(ctx);
    disposers.push(async () => {
      await cap.teardown?.(ctx);
    });
    const handle = getOutboxHandle(durableStoreNamespace(key));
    await handle?.retry(itemId as string);
    await new Promise((r) => setTimeout(r, 30));
    expect(posted).toEqual([]);
    expect(await handle?.snapshot()).toMatchObject([
      { itemId, transport: 'flha_submit', state: 'pending', attempts: 0 },
    ]);

    // The queue re-attaches: the held row replays through it.
    const replayed: OutboxCommand[] = [];
    queue({
      name: 'flha_submit',
      namespace: key,
      transport: async (command) => {
        replayed.push(command);
        return { status: 'applied' };
      },
    });
    await waitFor(() => replayed.length === 1);
    expect(replayed[0]).toMatchObject({
      idempotencyKey: itemId,
      payload: { answers: [1, 2] },
    });
    expect(posted).toEqual([]);
  });

  it('wipeDurableStore clears queued commands', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const key = uniqueKey();
    const transport = vi.fn(
      async (): Promise<OutboxCommandResult> => ({ status: 'applied' }),
    );
    const q = queue({ name: 'punch', namespace: key, transport });
    await q.enqueue({ rowId: 'x' });
    expect(await q.snapshot()).toHaveLength(1);
    await wipeDurableStore(durableStoreNamespace(key));
    expect(await q.snapshot()).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns undefined instead of acknowledging when IndexedDB is unavailable, and after dispose', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const q = offlineCommandQueue({
      name: 'punch',
      namespace: uniqueKey(),
      transport: async () => ({ status: 'applied' }),
    });
    expect(await q.enqueue({ rowId: 'x' })).toBeUndefined();
    await q.dispose();
    expect(await q.enqueue({ rowId: 'y' })).toBeUndefined();
  });
});

describe('dataSurfaceActionCommandTransport', () => {
  const identity = { surfaceId: 'my-punches', kind: 'list' as const };

  function actionTransport(
    reply: (
      request: SmrtWebDataSurfaceActionRequest,
    ) => Partial<{ ok: boolean; reason: string; confirmationToken: string }>,
    requests: SmrtWebDataSurfaceActionRequest[],
  ): SmrtWebDataSurfaceActionTransport {
    return {
      async action(request) {
        requests.push(request);
        return {
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: request.phase,
          ok: true,
          ...reply(request),
        };
      },
    };
  }

  const command: OutboxCommand = {
    idempotencyKey: 'key-1',
    name: 'punch',
    op: 'create',
    rowId: 'key-1',
    payload: { kind: 'in' },
    attempt: 2,
  };

  it('applies with the outbox idempotency key and a request built at replay time', async () => {
    const requests: SmrtWebDataSurfaceActionRequest[] = [];
    const transport = dataSurfaceActionCommandTransport({
      transport: actionTransport(() => ({}), requests),
      request: (c) => ({
        identity,
        actionId: 'clock-in',
        expectedRevision: 7,
        selection: { scope: 'current-page' },
        payload: c.payload as { kind: string },
      }),
    });
    await expect(transport(command)).resolves.toEqual({ status: 'applied' });
    expect(requests).toEqual([
      {
        version: 1,
        phase: 'apply',
        requestId: 'key-1:2:apply',
        idempotencyKey: 'key-1',
        identity,
        actionId: 'clock-in',
        expectedRevision: 7,
        selection: { scope: 'current-page' },
        payload: { kind: 'in' },
      },
    ]);
  });

  it('previews first and applies with the confirmation token when asked', async () => {
    const requests: SmrtWebDataSurfaceActionRequest[] = [];
    const transport = dataSurfaceActionCommandTransport({
      preview: true,
      transport: actionTransport(
        (r) => (r.phase === 'preview' ? { confirmationToken: 'tok' } : {}),
        requests,
      ),
      request: () => ({
        identity,
        actionId: 'clock-out',
        expectedRevision: 1,
        selection: { scope: 'explicit-ids', rowIds: ['p1'] },
      }),
    });
    await expect(transport(command)).resolves.toEqual({ status: 'applied' });
    expect(requests.map((r) => [r.phase, r.confirmationToken])).toEqual([
      ['preview', undefined],
      ['apply', 'tok'],
    ]);
    expect(requests[0].idempotencyKey).toBeUndefined();
  });

  it('classifies a failed preview without applying', async () => {
    const requests: SmrtWebDataSurfaceActionRequest[] = [];
    const transport = dataSurfaceActionCommandTransport({
      preview: true,
      transport: actionTransport(
        () => ({ ok: false, reason: 'denied' }),
        requests,
      ),
      request: () => ({
        identity,
        actionId: 'clock-out',
        expectedRevision: 1,
        selection: { scope: 'current-page' },
      }),
    });
    await expect(transport(command)).resolves.toEqual({
      status: 'rejected',
      reason: 'denied',
    });
    expect(requests).toHaveLength(1);
  });

  it('throws (retryable) on a reply that does not match its request', async () => {
    const transport = dataSurfaceActionCommandTransport({
      transport: {
        async action(request) {
          return {
            version: 1,
            requestId: 'other',
            identity: request.identity,
            actionId: request.actionId,
            phase: request.phase,
            ok: true,
          };
        },
      },
      request: () => ({
        identity,
        actionId: 'clock-in',
        expectedRevision: 1,
        selection: { scope: 'current-page' },
      }),
    });
    await expect(transport(command)).rejects.toThrow(TypeError);
  });

  it('default classification', () => {
    const r = (ok: boolean, reason?: string) =>
      classifySmrtWebDataSurfaceActionResult({
        version: 1,
        requestId: 'r',
        identity,
        actionId: 'a',
        phase: 'apply',
        ok,
        ...(reason ? { reason } : {}),
      });
    expect(r(true)).toEqual({ status: 'applied' });
    expect(r(false, 'idempotency_in_progress')).toEqual({
      status: 'rejected',
      reason: 'write_failed',
    });
    expect(r(false, 'execution_failed')).toEqual({
      status: 'rejected',
      reason: 'write_failed',
    });
    expect(r(false, 'unauthenticated')).toEqual({
      status: 'rejected',
      reason: 'auth_required',
    });
    expect(r(false, 'stale_revision')).toEqual({
      status: 'conflict',
      reason: 'stale_write',
    });
    expect(r(false, 'denied')).toEqual({
      status: 'rejected',
      reason: 'denied',
    });
    expect(r(false)).toEqual({ status: 'rejected', reason: 'rejected' });
  });
});

/** A minimal exclusive Web Locks stub shared by simulated tabs. */
class StubLocks {
  private readonly held = new Set<string>();
  private readonly waiting = new Map<string, Array<() => void>>();
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const run = () => {
        this.held.add(name);
        void callback().then((value) => {
          this.held.delete(name);
          this.waiting.get(name)?.shift()?.();
          resolve(value);
        });
      };
      if (!this.held.has(name)) {
        queueMicrotask(run);
        return;
      }
      const queue = this.waiting.get(name) ?? [];
      queue.push(run);
      this.waiting.set(name, queue);
      options.signal?.addEventListener('abort', () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  }
}

describe('offline outbox — per-route cross-tab leadership', () => {
  it("a tab leading only sync-apply never strands another tab's command rows", async () => {
    vi.stubGlobal('navigator', { onLine: true, locks: new StubLocks() });
    const namespace = durableStoreNamespace(uniqueKey());
    const config = {
      namespace,
      backoff: { initialDelayMs: 100_000, multiplier: 2, maxDelayMs: 100_000 },
      registerResource: () => () => {},
    };
    const urls: string[] = [];
    const posted: string[][] = [];
    // Tab A: a sync-apply collection only — it takes the namespace's
    // sync-apply lock first.
    const tabA = new OutboxEngine(config);
    const recordA = tabA.registerCollection({
      object: 'notes',
      syncApply: { basePath: '/api', fetchFn: recordingFetch(urls, posted) },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Tab B: a command queue only, sharing the same durable queue.
    const sent: string[] = [];
    const tabB = new OutboxEngine(config);
    const recordB = tabB.registerCollection({
      object: 'punch',
      transport: async (command) => {
        sent.push(command.idempotencyKey);
        return { status: 'applied' };
      },
    });
    try {
      const commandId = await tabB.enqueue({
        kind: 'insert',
        object: 'punch',
        rowId: '',
        data: { at: 't' },
        transport: 'punch',
      });
      await tabA.enqueue({
        kind: 'insert',
        object: 'notes',
        rowId: 'n-1',
        data: { id: 'n-1' },
      });
      await waitFor(() => sent.length === 1 && posted.length === 1);
      expect(sent).toEqual([commandId]);
      expect(posted).toEqual([['n-1']]);
      expect(await tabA.snapshot()).toEqual([]);
    } finally {
      await tabB.unregisterCollection('punch', recordB);
      await tabA.unregisterCollection('notes', recordA);
    }
  });
});
