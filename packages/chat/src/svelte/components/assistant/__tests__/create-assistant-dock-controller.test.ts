// @vitest-environment jsdom

import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
  type DataSurfaceRegistry,
} from '@happyvertical/smrt-ui/data-surface';
import { describe, expect, it, vi } from 'vitest';
import {
  type AssistantMessage,
  type AssistantThreadSummary,
  type AssistantTransport,
  createInMemoryAssistantTransport,
} from '../assistant-transport.js';
import { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

// A hand-rolled transport (not the stock in-memory one) for the finding-A
// poll-resolution tests: gives full control over exactly what loadMessages()
// returns on each poll, independent of when/whether sendMessage() resolves.
function scriptedTransport(seed: Record<string, AssistantMessage[]> = {}) {
  const store = new Map<string, AssistantMessage[]>(
    Object.entries(seed).map(([threadId, msgs]) => [threadId, [...msgs]]),
  );
  const threads = new Map<string, AssistantThreadSummary>();
  for (const threadId of store.keys()) {
    threads.set(threadId, {
      id: threadId,
      title: threadId,
      isResolved: false,
      messageCount: store.get(threadId)?.length ?? 0,
    });
  }
  let counter = 0;
  const transport: AssistantTransport = {
    async listThreads() {
      return Array.from(threads.values());
    },
    async createThread(title: string) {
      const id = `thread-${++counter}`;
      const thread: AssistantThreadSummary = {
        id,
        title,
        isResolved: false,
        messageCount: 0,
      };
      threads.set(id, thread);
      store.set(id, []);
      return thread;
    },
    async loadMessages(threadId: string) {
      return [...(store.get(threadId) ?? [])];
    },
    async sendMessage(input) {
      const list = store.get(input.threadId) ?? [];
      const userMessage: AssistantMessage = {
        id: `msg-${++counter}`,
        threadId: input.threadId,
        content: input.content,
        role: 'user',
        createdAt: new Date(),
        clientRequestId: input.clientRequestId,
      };
      list.push(userMessage);
      store.set(input.threadId, list);
      // Always reports inProgress: the test drives resolution purely
      // through what a later loadMessages() poll returns, by pushing an
      // assistant reply onto `store` directly.
      return { inProgress: true, userMessage };
    },
    async uploadAttachment(file: File) {
      return { id: `att-${++counter}`, name: file.name };
    },
  };
  return { transport, store };
}

function pushAssistantReply(
  store: Map<string, AssistantMessage[]>,
  threadId: string,
  content: string,
) {
  const list = store.get(threadId) ?? [];
  list.push({
    id: `reply-${list.length}`,
    threadId,
    content,
    role: 'assistant',
    createdAt: new Date(),
  });
  store.set(threadId, list);
}

// A real registry (not the static fakeRegistry below) so 'unregistered'
// events actually fire, for the F2 invalidation test.
function realRegistryWithSurface(
  surfaceId: string,
  subject: { type: string; id: string } = { type: 'tenant', id: 'tenant-a' },
) {
  const identity: DataSurfaceIdentity = {
    surfaceId,
    kind: 'table',
    subject,
  };
  const descriptor: DataSurfaceDescriptor = {
    version: 1,
    identity,
    schemaVersion: 1,
    label: surfaceId,
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id'],
      searchableColumnIds: [],
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    actions: [],
    controls: [],
    limits: { maxQueryRows: 10, maxQueryBytes: 10_000, maxSelectionSize: 10 },
  };
  const registry = createDataSurfaceRegistry();
  const unregister = registry.register({
    descriptor,
    getSnapshot: () => ({ revision: 1, state: {} }),
  });
  return { registry, identity, unregister };
}

function fakeRegistry(
  descriptors: { surfaceId: string; kind: 'table' }[] = [],
): DataSurfaceRegistry {
  const listeners = new Set<(event: unknown) => void>();
  return {
    register: vi.fn(() => () => {}),
    unregister: vi.fn(),
    list: () =>
      descriptors.map((d) => ({
        version: 1 as const,
        identity: {
          surfaceId: d.surfaceId,
          kind: d.kind,
          subject: { type: 'tenant', id: 'tenant-a' },
        },
        kind: d.kind,
        title: d.surfaceId,
        columns: [],
        actions: [],
        limits: {
          maxQueryRows: 100,
          maxQueryBytes: 100_000,
          maxSelectionSize: 100,
        },
      })) as ReturnType<DataSurfaceRegistry['list']>,
    inspect: () => undefined,
    execute: vi.fn(),
    validateQuery: vi.fn(),
    validateAction: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener as (event: unknown) => void);
      return () => listeners.delete(listener as (event: unknown) => void);
    },
  } as unknown as DataSurfaceRegistry;
}

describe('createAssistantDockController', () => {
  it('fails closed with an empty registry: no mounted surfaces', async () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([]),
    });
    expect(controller.surfaces).toEqual([]);
  });

  it('exposes mounted surfaces from the registry', () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([{ surfaceId: 'orders', kind: 'table' }]),
    });
    expect(controller.surfaces).toHaveLength(1);
    expect(controller.surfaces[0].surfaceId).toBe('orders');
  });

  it('rejects an action preview client-side when the target surface is not mounted', async () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([]),
    });
    await controller.previewAction({
      version: 1,
      requestId: 'req-1',
      identity: {
        surfaceId: 'orders',
        kind: 'table',
        subject: { type: 'tenant', id: 'tenant-a' },
      },
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    const state = controller.actions.get('req-1');
    expect(state?.status).toBe('failed');
    expect(state?.error).toMatch(/not mounted/);
  });

  it('reuses the same clientRequestId across two send() calls for the same draft while it is still unresolved (F5)', async () => {
    const seenIds: string[] = [];
    const transport = createInMemoryAssistantTransport({
      // Every send for this thread reports inProgress — the draft must stay
      // "unresolved" from doSend's point of view across both calls.
      simulateInProgressOnce: false,
    });
    // simulateInProgressOnce only covers the FIRST send per thread in the
    // stock in-memory transport; force every call to report inProgress so
    // this test exercises the truly-unresolved window F5 is about.
    const originalSend = transport.sendMessage.bind(transport);
    transport.sendMessage = async (input) => {
      seenIds.push(input.clientRequestId);
      return { inProgress: true, userMessage: undefined };
    };
    void originalSend;
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id);

    await controller.send('hello');
    expect(controller.pendingSends[0]?.status).toBe('processing');
    // A second send() for the identical (threadId, content) draft while the
    // first is still unresolved (inProgress) must observe the SAME
    // clientRequestId at the transport — this is what
    // docs/assistant-dock.md claims mirrors PortalChatTool.svelte:304-322.
    // Before the F5 fix, doSend cleared draftIds even on the inProgress
    // branch, so this second call minted a brand-new id.
    await controller.send('hello');

    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).toBe(seenIds[1]);
  });

  it('marks a pending send stale after the timeout and offers retry via the same clientRequestId', async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const transport = createInMemoryAssistantTransport({
        simulateInProgressOnce: true,
        now: () => clock,
      });
      const controller = createAssistantDockController({
        transport,
        registry: fakeRegistry([]),
        now: () => clock,
        staleAfterMs: 1_000,
        activePollIntervalMs: 500,
        idlePollIntervalMs: 500,
      });
      const thread = await controller.createThread('t1');
      await controller.openThread(thread.id);

      await controller.send('hi');
      expect(controller.pendingSends[0]?.status).toBe('processing');
      const clientRequestId = controller.pendingSends[0].clientRequestId;

      clock += 2_000;
      await vi.advanceTimersByTimeAsync(500);

      expect(controller.pendingSends[0]?.status).toBe('stale');

      await controller.retry(clientRequestId);
      // The retry reuses the identical clientRequestId — the in-memory
      // transport's dedup cache (assistant-transport.ts `seenClientRequestIds`)
      // returns the SAME cached "still processing" result rather than posting
      // a second user message, mirroring PortalChatTool.svelte:304-322.
      expect(controller.pendingSends[0]?.clientRequestId).toBe(clientRequestId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startPolling/stopPolling toggle the interval without throwing', () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([]),
    });
    controller.startPolling();
    controller.startPolling(); // idempotent
    controller.stopPolling();
    controller.stopPolling(); // idempotent
    controller.dispose();
  });

  it('has no models when the transport does not provide listModels', async () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([]),
    });
    await controller.loadModels();
    expect(controller.models).toEqual([]);
    expect(controller.selectedModel).toBeUndefined();
  });

  it('the selected model reaches the transport on send', async () => {
    const seenModels: (string | undefined)[] = [];
    const transport = createInMemoryAssistantTransport({
      models: [
        { id: 'model-a', label: 'Model A' },
        { id: 'model-b', label: 'Model B' },
      ],
    });
    const originalSend = transport.sendMessage.bind(transport);
    transport.sendMessage = async (input) => {
      seenModels.push(input.model);
      return originalSend(input);
    };
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    await controller.loadModels();
    expect(controller.models).toHaveLength(2);
    // loadModels defaults selectedModel to the first entry.
    expect(controller.selectedModel).toBe('model-a');

    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id);
    await controller.send('hello');
    expect(seenModels).toEqual(['model-a']);

    controller.setSelectedModel('model-b');
    await controller.send('hello again');
    expect(seenModels).toEqual(['model-a', 'model-b']);
  });

  it('reuses the idempotencyKey minted at preview across a retried apply', async () => {
    const seenKeys: string[] = [];
    let attempt = 0;
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: fakeRegistry([{ surfaceId: 'orders', kind: 'table' }]),
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
          confirmationToken: 'token-1',
        }),
        apply: async (request, idempotencyKey) => {
          seenKeys.push(idempotencyKey);
          attempt += 1;
          // First attempt fails client-side (e.g. simulated timeout); the
          // second (retried) apply must reuse the SAME idempotencyKey.
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply',
            ok: attempt > 1,
            reason: attempt > 1 ? undefined : 'timeout',
          };
        },
      },
    });

    const requestId = 'req-idem-1';
    await controller.previewAction({
      version: 1,
      requestId,
      identity: {
        surfaceId: 'orders',
        kind: 'table',
        subject: { type: 'tenant', id: 'tenant-a' },
      },
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    await controller.applyAction(requestId);
    expect(controller.actions.get(requestId)?.status).toBe('failed');
    await controller.applyAction(requestId);
    expect(controller.actions.get(requestId)?.status).toBe('applied');

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
  });

  // F2 (#2904 review): applyAction must re-check mount status, not only
  // previewAction.
  it('fails an apply closed if the surface was unmounted after preview', async () => {
    const { registry, identity, unregister } =
      realRegistryWithSurface('orders');
    const applySpy = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => {
          applySpy();
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply',
            ok: true,
          };
        },
      },
    });

    const requestId = 'req-unmounted-apply';
    await controller.previewAction({
      version: 1,
      requestId,
      identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    unregister();
    await controller.applyAction(requestId);

    expect(applySpy).not.toHaveBeenCalled();
    expect(controller.actions.get(requestId)?.status).toBe('failed');
    expect(controller.actions.get(requestId)?.error).toMatch(/not mounted/);
  });

  it('invalidates an outstanding previewed action when its surface unregisters', async () => {
    const { registry, identity, unregister } =
      realRegistryWithSurface('orders');
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'apply',
          ok: true,
        }),
      },
    });

    const requestId = 'req-invalidate-on-unregister';
    await controller.previewAction({
      version: 1,
      requestId,
      identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    unregister();

    expect(controller.actions.get(requestId)?.status).toBe('failed');
    expect(controller.actions.get(requestId)?.error).toMatch(/unmounted/);
  });

  // F6 (#2904 review): surfaceKey() must key by subject too, not just
  // kind + surfaceId — otherwise a request for the same surfaceId/kind but a
  // DIFFERENT subject (another tenant, site, or project instance) passes the
  // mount gate.
  it('rejects preview and apply for the same kind/surfaceId mounted under a different subject', async () => {
    const { registry, identity: mountedIdentity } = realRegistryWithSurface(
      'orders',
      { type: 'tenant', id: 'tenant-a' },
    );
    const otherSubjectIdentity: DataSurfaceIdentity = {
      ...mountedIdentity,
      subject: { type: 'tenant', id: 'tenant-b' },
    };
    const applySpy = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => {
          applySpy();
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply',
            ok: true,
          };
        },
      },
    });

    const requestId = 'req-other-subject';
    await controller.previewAction({
      version: 1,
      requestId,
      identity: otherSubjectIdentity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('failed');
    expect(controller.actions.get(requestId)?.error).toMatch(/not mounted/);

    // Force the action into a previewed state directly (bypassing the
    // preview-time gate) to isolate applyAction's OWN re-check from
    // previewAction's — F2's apply-time gate must independently reject the
    // subject-swapped identity too.
    controller.actions.set(requestId, {
      request: {
        version: 1,
        requestId,
        identity: otherSubjectIdentity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      },
      status: 'previewed',
      idempotencyKey: 'idem-other-subject',
    });
    await controller.applyAction(requestId);
    expect(applySpy).not.toHaveBeenCalled();
    expect(controller.actions.get(requestId)?.status).toBe('failed');
    expect(controller.actions.get(requestId)?.error).toMatch(/not mounted/);
  });

  it("does not invalidate a sibling subject's outstanding preview when a different subject unregisters", async () => {
    const tenantA = realRegistryWithSurface('orders', {
      type: 'tenant',
      id: 'tenant-a',
    });
    // Mount a SECOND surface for tenant-b, same kind/surfaceId, on the SAME
    // registry instance the controller watches.
    const tenantBIdentity: DataSurfaceIdentity = {
      surfaceId: 'orders',
      kind: 'table',
      subject: { type: 'tenant', id: 'tenant-b' },
    };
    const unregisterTenantB = tenantA.registry.register({
      descriptor: {
        version: 1,
        identity: tenantBIdentity,
        schemaVersion: 1,
        label: 'orders',
        rowKey: 'id',
        columns: [
          { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
        ],
        query: {
          modes: ['rows'],
          projectableColumnIds: ['id'],
          searchableColumnIds: [],
          filterableColumnIds: [],
          sortableColumnIds: [],
        },
        actions: [],
        controls: [],
        limits: {
          maxQueryRows: 10,
          maxQueryBytes: 10_000,
          maxSelectionSize: 10,
        },
      },
      getSnapshot: () => ({ revision: 1, state: {} }),
    });

    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: tenantA.registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'apply',
          ok: true,
        }),
      },
    });

    const requestId = 'req-tenant-a-survives';
    await controller.previewAction({
      version: 1,
      requestId,
      identity: tenantA.identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    // Unregister tenant-b's surface — same kind/surfaceId as tenant-a's,
    // different subject. tenant-a's outstanding preview must be untouched.
    unregisterTenantB();

    expect(controller.actions.get(requestId)?.status).toBe('previewed');
  });

  // F3 (#2904 review): dispose() during an in-flight loadMessages must not
  // re-arm the poll interval.
  it('startPolling() after dispose() is a no-op (F3 disposed guard)', async () => {
    const transport = createInMemoryAssistantTransport();
    const loadMessagesSpy = vi.spyOn(transport, 'loadMessages');
    const controller = createAssistantDockController({
      transport,
      registry: realRegistryWithSurface('orders').registry,
      activePollIntervalMs: 5,
      idlePollIntervalMs: 5,
    });
    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id);
    loadMessagesSpy.mockClear();

    controller.dispose();
    // Before the F3 fix, resetPollInterval unconditionally armed a timer
    // whenever called, including via a stray startPolling() after dispose.
    controller.startPolling();

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(loadMessagesSpy).not.toHaveBeenCalled();
  });

  it('does not re-arm the poll interval when dispose() races an in-flight pollTick', async () => {
    const transport = createInMemoryAssistantTransport();
    const controller = createAssistantDockController({
      transport,
      registry: realRegistryWithSurface('orders').registry,
      // Long enough that no second natural tick fires during the test —
      // the only pollTick in play is the one the real interval fires once.
      activePollIntervalMs: 30,
      idlePollIntervalMs: 30,
    });
    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id); // consumes its own loadMessages call, unrelated to the gate below

    // Gate ONLY loadMessages calls made from here on — i.e. the poll's own
    // call, not openThread's.
    let resolveGatedLoadMessages: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGatedLoadMessages = resolve;
    });
    let callCount = 0;
    const originalLoadMessages = transport.loadMessages.bind(transport);
    transport.loadMessages = async (threadId: string) => {
      callCount += 1;
      if (callCount === 1) await gate;
      return originalLoadMessages(threadId);
    };

    controller.startPolling();
    // Wait for the interval to fire once and land inside the gated await.
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(callCount).toBe(1);

    // dispose() runs WHILE that pollTick is still awaiting loadMessages.
    controller.dispose();
    resolveGatedLoadMessages?.();
    // Give pollTick's continuation, and any (incorrect) re-armed interval,
    // several multiples of the poll interval to fire again.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The bug: pollTick's post-await code unconditionally called
    // resetPollInterval(...), re-arming a timer after dispose(). The fix
    // must leave the call count at exactly 1 — the single tick that was
    // already in flight when dispose() ran, and nothing after.
    expect(callCount).toBe(1);
  }, 10_000);

  // Finding A (#2904 review, third final pass): pollTick's pending-send
  // resolution must not match an earlier, already-answered occurrence of the
  // same content, and must not cross threads.
  it('does not resolve a new in-flight repeat of an already-answered message until ITS OWN reply follows', async () => {
    const { transport, store } = scriptedTransport({
      t1: [
        {
          id: 'old-user',
          threadId: 't1',
          content: 'yes',
          role: 'user',
          createdAt: new Date(0),
        },
        {
          id: 'old-reply',
          threadId: 't1',
          content: 'Understood.',
          role: 'assistant',
          createdAt: new Date(1),
        },
      ],
    });
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
      activePollIntervalMs: 15,
      idlePollIntervalMs: 15,
    });
    await controller.openThread('t1');
    expect(controller.messages).toHaveLength(2);

    await controller.send('yes'); // repeats the earlier, already-answered text
    expect(controller.pendingSends).toHaveLength(1);
    expect(controller.pendingSends[0]?.status).toBe('processing');

    controller.startPolling();
    // Several poll ticks elapse with NO new assistant reply in the store —
    // before the fix, the OLD "yes" → "Understood." pair (an earlier index
    // match) would have resolved this immediately.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.pendingSends).toHaveLength(1);
    expect(controller.pendingSends[0]?.status).toBe('processing');

    // Now the reply to THIS send arrives.
    pushAssistantReply(store, 't1', 'Confirmed, again.');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.pendingSends).toHaveLength(0);

    controller.dispose();
  });

  it("does not resolve a pending send for thread A using thread B's messages", async () => {
    const { transport, store } = scriptedTransport({ a: [], b: [] });
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
      activePollIntervalMs: 15,
      idlePollIntervalMs: 15,
    });

    await controller.openThread('a');
    await controller.send('hello');
    expect(controller.pendingSends).toHaveLength(1);
    const pendingForA = controller.pendingSends[0];
    expect(pendingForA?.threadId).toBe('a');

    // Switch to thread B, which happens to contain the SAME text followed by
    // a reply — this must never be read as resolving thread A's pending send.
    store.set('b', [
      {
        id: 'b-user',
        threadId: 'b',
        content: 'hello',
        role: 'user',
        createdAt: new Date(),
      },
      {
        id: 'b-reply',
        threadId: 'b',
        content: 'hi there',
        role: 'assistant',
        createdAt: new Date(),
      },
    ]);
    await controller.openThread('b');
    controller.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(controller.pendingSends).toHaveLength(1);
    expect(controller.pendingSends[0]?.clientRequestId).toBe(
      pendingForA?.clientRequestId,
    );
    expect(controller.pendingSends[0]?.status).toBe('processing');

    controller.dispose();
  });

  // Finding B (#2904 review, third final pass): the registry subscription
  // must follow a getter-based `options.registry` when the host reassigns
  // it, not stay bound to whatever instance was current at construction.
  // This is the direct controller-level test of syncRegistry(); the
  // corresponding component-level test in AssistantDock.test.ts drives the
  // same swap through a real `<AssistantDock>` prop reassignment and
  // asserts the DOM-visible surfaces-empty notice reacts to it.
  it('syncRegistry() re-subscribes, resyncs surfaces, and invalidates outstanding previews on a registry swap', async () => {
    const r1 = realRegistryWithSurface('orders');
    let currentRegistry = r1.registry;
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      get registry() {
        return currentRegistry;
      },
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'apply',
          ok: true,
        }),
      },
    });

    expect(controller.surfaces).toHaveLength(1);

    const outstandingRequestId = 'req-outstanding-on-r1';
    await controller.previewAction({
      version: 1,
      requestId: outstandingRequestId,
      identity: r1.identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(outstandingRequestId)?.status).toBe(
      'previewed',
    );

    // Swap to an empty registry (R2) — mirrors a host switching
    // tenant/workspace context.
    const r2 = createDataSurfaceRegistry();
    currentRegistry = r2;
    controller.syncRegistry();

    expect(controller.surfaces).toHaveLength(0);
    // The preview taken under R1 must not survive the swap to R2.
    expect(controller.actions.get(outstandingRequestId)?.status).toBe('failed');

    // A preview against R1's surface must now be rejected — R1 is no longer
    // the registry this controller is watching.
    const rejectedRequestId = 'req-r1-after-swap';
    await controller.previewAction({
      version: 1,
      requestId: rejectedRequestId,
      identity: r1.identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(rejectedRequestId)?.status).toBe('failed');
    expect(controller.actions.get(rejectedRequestId)?.error).toMatch(
      /not mounted/,
    );

    // Registering a surface on R2 must be discovered (the subscription
    // really did move to R2, not just resync once).
    const r2Identity: DataSurfaceIdentity = {
      surfaceId: 'products',
      kind: 'table',
      subject: { type: 'tenant', id: 'tenant-a' },
    };
    r2.register({
      descriptor: {
        version: 1,
        identity: r2Identity,
        schemaVersion: 1,
        label: 'products',
        rowKey: 'id',
        columns: [
          { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
        ],
        query: {
          modes: ['rows'],
          projectableColumnIds: ['id'],
          searchableColumnIds: [],
          filterableColumnIds: [],
          sortableColumnIds: [],
        },
        actions: [],
        controls: [],
        limits: {
          maxQueryRows: 10,
          maxQueryBytes: 10_000,
          maxSelectionSize: 10,
        },
      },
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    expect(controller.surfaces).toHaveLength(1);
    expect(controller.surfaces[0]?.surfaceId).toBe('products');

    controller.dispose();
  });

  it('syncRegistry() is a no-op when the registry has not changed', () => {
    const { registry } = realRegistryWithSurface('orders');
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
    });
    expect(controller.surfaces).toHaveLength(1);
    controller.syncRegistry();
    controller.syncRegistry();
    expect(controller.surfaces).toHaveLength(1);
    controller.dispose();
  });

  // Finding 1 (#2904 review, fresh cycle): the "gate" half of the `surfaces`
  // override — a request against a surface NOT in the override is rejected
  // even if it's genuinely registered on the live registry, and a request
  // against a surface IN the override is accepted even if the registry
  // knows nothing about it. Complements AssistantDock.test.ts's DOM-level
  // discovery assertions for the same override, wired through the
  // component's exact `get surfaces() { return surfaces; }` pattern.
  it('the `surfaces` override gates previewAction/applyAction independently of registry contents', async () => {
    const { registry, identity: ordersIdentity } =
      realRegistryWithSurface('orders'); // registered, but NOT in the override
    const overrideOnlyIdentity: DataSurfaceIdentity = {
      surfaceId: 'products',
      kind: 'table',
      subject: { type: 'tenant', id: 'tenant-a' },
    }; // in the override, but NOT registered anywhere
    const applySpy = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      surfaces: [overrideOnlyIdentity],
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => {
          applySpy();
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply',
            ok: true,
          };
        },
      },
    });

    expect(controller.surfaces).toEqual([overrideOnlyIdentity]);

    // Registered on the live registry, but NOT in the override: rejected.
    await controller.previewAction({
      version: 1,
      requestId: 'req-registered-not-in-override',
      identity: ordersIdentity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(
      controller.actions.get('req-registered-not-in-override')?.status,
    ).toBe('failed');
    expect(
      controller.actions.get('req-registered-not-in-override')?.error,
    ).toMatch(/not mounted/);

    // In the override, though never registered on the live registry: accepted.
    await controller.previewAction({
      version: 1,
      requestId: 'req-override-only',
      identity: overrideOnlyIdentity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get('req-override-only')?.status).toBe(
      'previewed',
    );
    await controller.applyAction('req-override-only');
    expect(applySpy).toHaveBeenCalledOnce();
    expect(controller.actions.get('req-override-only')?.status).toBe('applied');

    controller.dispose();
  });

  // Finding 2 (#2904 review, fresh cycle): a rejecting/throwing actionClient
  // must always reach a terminal 'failed' status, never leave the entry
  // stuck at 'previewing'/'applying' or escape as an unhandled rejection.
  it('previewAction reaches a terminal failed status when actionClient.preview rejects', async () => {
    const { registry, identity } = realRegistryWithSurface('orders');
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async () => {
          throw new Error('network error');
        },
        apply: async () => {
          throw new Error('unreachable');
        },
      },
    });

    // await never rejects at the call site — the rejection is caught inside.
    await expect(
      controller.previewAction({
        version: 1,
        requestId: 'req-preview-rejects',
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      }),
    ).resolves.toBeUndefined();

    const state = controller.actions.get('req-preview-rejects');
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('network error');
    controller.dispose();
  });

  it('applyAction reaches a terminal failed status when actionClient.apply rejects', async () => {
    const { registry, identity } = realRegistryWithSurface('orders');
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async () => {
          throw new Error('server 500');
        },
      },
    });

    const requestId = 'req-apply-rejects';
    await controller.previewAction({
      version: 1,
      requestId,
      identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    await expect(controller.applyAction(requestId)).resolves.toBeUndefined();

    const state = controller.actions.get(requestId);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('server 500');
    controller.dispose();
  });

  // Finding 3 (#2904 review, fresh cycle): a Reject during an in-flight
  // apply must not be silently overridden by that apply landing afterward.
  it('a slow apply does not resurrect a rejected action as applied', async () => {
    const { registry, identity } = realRegistryWithSurface('orders');
    let resolveApply: ((ok: boolean) => void) | undefined;
    const applyGate = new Promise<boolean>((resolve) => {
      resolveApply = resolve;
    });
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      actionClient: {
        preview: async (request) => ({
          version: 1,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview',
          ok: true,
        }),
        apply: async (request) => {
          const ok = await applyGate;
          return {
            version: 1,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply',
            ok,
          };
        },
      },
    });
    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id);

    const requestId = 'req-reject-during-apply';
    await controller.previewAction({
      version: 1,
      requestId,
      identity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(controller.actions.get(requestId)?.status).toBe('previewed');

    const applyPromise = controller.applyAction(requestId);
    // A second concurrent call is refused outright — it must not disturb
    // the first one's in-flight apply.
    await controller.applyAction(requestId);
    expect(controller.actions.get(requestId)?.status).toBe('applying');

    // The user rejects WHILE the apply above is still in flight.
    controller.rejectAction(requestId);
    expect(controller.actions.has(requestId)).toBe(false);

    // The server mutation "lands" (resolves ok:true) after the rejection.
    resolveApply?.(true);
    await applyPromise;

    // The entry must NOT be resurrected as 'applied' — it stays gone.
    expect(controller.actions.has(requestId)).toBe(false);
    // The server mutation genuinely happened despite the rejection — the
    // controller surfaces that as a message rather than hiding it.
    expect(
      controller.messages.some((m) =>
        m.content.includes('already applied by the server'),
      ),
    ).toBe(true);

    controller.dispose();
  });

  // Finding 4 (#2904 review, fresh cycle): a failed listThreads must be
  // visible on controller.error, not swallowed as an empty thread list.
  it('loadThreads() records a transport rejection on controller.error', async () => {
    const transport = createInMemoryAssistantTransport();
    transport.listThreads = async () => {
      throw new Error('offline');
    };
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    expect(controller.error).toBeNull();

    await controller.loadThreads();

    expect(controller.error).toBe('offline');
    expect(controller.threads).toEqual([]);
    controller.dispose();
  });

  it('a successful loadThreads() clears a previously-recorded error', async () => {
    const transport = createInMemoryAssistantTransport();
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    controller.setError('stale error from something else');
    await controller.loadThreads();
    expect(controller.error).toBeNull();
    controller.dispose();
  });
});
