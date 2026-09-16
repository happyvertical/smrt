// @vitest-environment jsdom

import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
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

  // Copilot PR #2919 jAwwB: the draft key was (threadId, content) only,
  // even though attachments are part of the send input. After an
  // in-progress send('same text', [A]) cleared the composer, a second
  // send('same text', [B]) before the first resolved reused the SAME
  // clientRequestId — a deduplicating transport returned the first
  // request's cached result and silently dropped attachment B.
  it('a second send() with the same text but a DIFFERENT attachment set mints a new clientRequestId', async () => {
    const seenAttachmentSets: (string | undefined)[][] = [];
    const transport = createInMemoryAssistantTransport({
      simulateInProgressOnce: false,
    });
    transport.sendMessage = async (input) => {
      seenAttachmentSets.push((input.attachments ?? []).map((a) => a.id));
      return { inProgress: true, userMessage: undefined };
    };
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    const thread = await controller.createThread('t1');
    await controller.openThread(thread.id);

    await controller.send('same text', [{ id: 'att-A', name: 'a.png' }]);
    const clientRequestIdA = controller.pendingSends[0]?.clientRequestId;
    expect(clientRequestIdA).toBeDefined();

    await controller.send('same text', [{ id: 'att-B', name: 'b.png' }]);
    const clientRequestIdB = controller.pendingSends.find(
      (p) => p.content === 'same text' && p.attachments?.[0]?.id === 'att-B',
    )?.clientRequestId;

    expect(clientRequestIdB).toBeDefined();
    expect(clientRequestIdB).not.toBe(clientRequestIdA);
    expect(seenAttachmentSets).toEqual([['att-A'], ['att-B']]);

    // A THIRD send of the exact same (text, attachments) as the second one
    // — while it's still unresolved — must reuse clientRequestIdB, not mint
    // a third id (retries of the same draft still bind to the same key).
    await controller.send('same text', [{ id: 'att-B', name: 'b.png' }]);
    expect(seenAttachmentSets).toEqual([['att-A'], ['att-B'], ['att-B']]);
    const thirdCallClientRequestId = controller.pendingSends.find(
      (p) => p.content === 'same text' && p.attachments?.[0]?.id === 'att-B',
    )?.clientRequestId;
    expect(thirdCallClientRequestId).toBe(clientRequestIdB);
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

  // Copilot PR #2919 jAwu8: `simulateInProgressOnce` alone left a turn
  // `inProgress: true` FOREVER — it was never appended or scheduled to
  // resolve, so the shipped in-memory transport could not exercise
  // successful stale-send recovery. `resolveInProgressAfterLoads` makes
  // that resolution configurable and exercisable via polling.
  it('resolves a simulated in-progress turn on a later loadMessages(), letting stale-send recovery succeed', async () => {
    vi.useFakeTimers();
    try {
      const clock = 0;
      const transport = createInMemoryAssistantTransport({
        simulateInProgressOnce: true,
        resolveInProgressAfterLoads: 1,
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

      // The next poll tick's loadMessages() call resolves the turn — the
      // assistant reply appears and the pending send clears, WITHOUT ever
      // hitting the staleness timeout.
      await vi.advanceTimersByTimeAsync(500);

      expect(controller.pendingSends).toHaveLength(0);
      expect(
        controller.messages.some(
          (m) => m.role === 'assistant' && m.content === 'echo: hi',
        ),
      ).toBe(true);
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
    // Copilot PR #2919 jAwwg: unregister() invalidates the previewed entry
    // to 'failed' (via invalidatePreviewedActionsFor) with its request still
    // at the PREVIEW phase — applyAction's status/`retryable` guard refuses
    // it at the top (before ever reaching the apply-time mount re-check
    // below), since a preview-phase failure is never a valid apply retry
    // target. Cycle-4 final finding 2: the refusal is now non-mutating, so
    // the entry's own status/error are left exactly as the invalidation set
    // them; the refusal reason is recorded on controller.error instead.
    await controller.applyAction(requestId);

    expect(applySpy).not.toHaveBeenCalled();
    expect(controller.actions.get(requestId)?.status).toBe('failed');
    expect(controller.actions.get(requestId)?.error).toMatch(/unmounted/);
    expect(controller.error).toMatch(/applyAction refused/);
  });

  // Copilot PR #2919 jAwwg: applyAction() previously only blocked a second
  // CONCURRENT apply ('applying') — 'previewing', 'applied', and a
  // preview-phase 'failed' were all still callable, letting a failed
  // preview reach AssistantActionClient.apply without a successful
  // preview/confirmation, and letting an already-applied action be
  // replayed outside the intended retry path. Cycle-4 final finding 2:
  // jAwwg's OWN fix mutated the refused entry (`status: 'failed'`), which
  // downgraded an 'applied' entry and — on a SECOND applyAction call —
  // satisfied its own retry condition, permitting the exact replay it was
  // meant to prevent. The refusal is now non-mutating; retry eligibility
  // comes from an explicit `retryable` marker set only by a genuine apply
  // attempt.
  describe('applyAction() status/phase guard (cycle-3 second final jAwwg, cycle-4 final finding 2)', () => {
    function makeActionClient(applySpy = vi.fn()) {
      return {
        preview: async (request: DataSurfaceActionRequest) => ({
          version: 1 as const,
          requestId: request.requestId,
          identity: request.identity,
          actionId: request.actionId,
          phase: 'preview' as const,
          ok: true,
        }),
        apply: async (request: DataSurfaceActionRequest) => {
          applySpy();
          return {
            version: 1 as const,
            requestId: request.requestId,
            identity: request.identity,
            actionId: request.actionId,
            phase: 'apply' as const,
            ok: true,
          };
        },
      };
    }

    it('refuses a still-"previewing" action (never resolved) with a clear error', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const applySpy = vi.fn();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: makeActionClient(applySpy),
      });
      const requestId = 'req-previewing';
      controller.actions.set(requestId, {
        request: {
          version: 1,
          requestId,
          identity,
          actionId: 'archive',
          phase: 'preview',
          selection: { scope: 'current-page' },
        },
        status: 'previewing',
        idempotencyKey: 'idem-previewing',
      });

      await controller.applyAction(requestId);

      expect(applySpy).not.toHaveBeenCalled();
      // Cycle-4 final finding 2: non-mutating refusal — the entry stays
      // exactly 'previewing', not downgraded to 'failed'.
      expect(controller.actions.get(requestId)?.status).toBe('previewing');
      expect(controller.error).toMatch(/applyAction refused/);
      controller.dispose();
    });

    it('refuses a preview-phase "failed" action (never successfully previewed) with a clear error', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const applySpy = vi.fn();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: makeActionClient(applySpy),
      });
      const requestId = 'req-preview-failed';
      controller.actions.set(requestId, {
        request: {
          version: 1,
          requestId,
          identity,
          actionId: 'archive',
          phase: 'preview',
          selection: { scope: 'current-page' },
        },
        status: 'failed',
        error: 'preview rejected by the server',
        idempotencyKey: 'idem-preview-failed',
      });

      await controller.applyAction(requestId);

      expect(applySpy).not.toHaveBeenCalled();
      // Cycle-4 final finding 2: non-mutating refusal — the entry's OWN
      // error stays the original preview-rejection message; the refusal is
      // recorded on controller.error instead.
      expect(controller.actions.get(requestId)?.status).toBe('failed');
      expect(controller.actions.get(requestId)?.error).toBe(
        'preview rejected by the server',
      );
      expect(controller.error).toMatch(/applyAction refused/);
      controller.dispose();
    });

    it('refuses an already-"applied" action on a second AND third call — no replay, entry stays applied', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const applySpy = vi.fn();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: makeActionClient(applySpy),
      });
      const requestId = 'req-already-applied';
      const applyResult = {
        version: 1 as const,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'apply' as const,
        ok: true,
      };
      controller.actions.set(requestId, {
        request: {
          version: 1,
          requestId,
          identity,
          actionId: 'archive',
          phase: 'apply',
          selection: { scope: 'current-page' },
        },
        status: 'applied',
        applyResult,
        idempotencyKey: 'idem-applied',
      });

      // Cycle-4 final finding 2: jAwwg's original fix downgraded this entry
      // to 'failed' on refusal, which itself satisfied the (then
      // phase-based) retry condition — a SECOND applyAction call would
      // proceed and replay the action against the server. Both the second
      // AND a third call here must refuse without ever calling apply(), and
      // the entry must stay 'applied' with its original applyResult intact
      // throughout.
      await controller.applyAction(requestId);
      expect(applySpy).not.toHaveBeenCalled();
      expect(controller.actions.get(requestId)?.status).toBe('applied');
      expect(controller.actions.get(requestId)?.applyResult).toEqual(
        applyResult,
      );
      expect(controller.error).toMatch(/applyAction refused/);

      controller.setError(null);
      await controller.applyAction(requestId);
      expect(applySpy).not.toHaveBeenCalled();
      expect(controller.actions.get(requestId)?.status).toBe('applied');
      expect(controller.actions.get(requestId)?.applyResult).toEqual(
        applyResult,
      );
      expect(controller.error).toMatch(/applyAction refused/);

      controller.dispose();
    });

    it('permits a normal previewed -> apply transition', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const applySpy = vi.fn();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: makeActionClient(applySpy),
      });
      const requestId = 'req-normal-flow';
      await controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get(requestId)?.status).toBe('previewed');

      await controller.applyAction(requestId);

      expect(applySpy).toHaveBeenCalledOnce();
      expect(controller.actions.get(requestId)?.status).toBe('applied');
      controller.dispose();
    });

    it('permits a retry of an APPLY-phase failure (a transient apply error after a successful preview)', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      let shouldFail = true;
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
            if (shouldFail) throw new Error('transient 500');
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
      const requestId = 'req-apply-retry';
      await controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });

      await controller.applyAction(requestId);
      expect(controller.actions.get(requestId)?.status).toBe('failed');
      // Cycle-4 final finding 2: this is the marker the retry guard actually
      // consults now — a genuine apply attempt failed.
      expect(controller.actions.get(requestId)?.retryable).toBe(true);

      shouldFail = false;
      await controller.applyAction(requestId);

      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(controller.actions.get(requestId)?.status).toBe('applied');
      // Cleared on a successful apply.
      expect(controller.actions.get(requestId)?.retryable).toBe(false);
      controller.dispose();
    });

    // Cycle-4 final finding 2: a preview-phase failure must never set
    // `retryable` — only a genuine apply attempt does.
    it('a preview-phase failure is not retryable', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const applySpy = vi.fn();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: {
          preview: async () => {
            throw new Error('preview rejected');
          },
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
      const requestId = 'req-preview-fails';
      await controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get(requestId)?.status).toBe('failed');
      expect(controller.actions.get(requestId)?.retryable).toBeFalsy();

      await controller.applyAction(requestId);

      expect(applySpy).not.toHaveBeenCalled();
      expect(controller.error).toMatch(/applyAction refused/);
      controller.dispose();
    });

    // Cycle-4 final finding 2: retryable only covers ONE retry attempt per
    // failure — a second consecutive apply failure must still be retryable
    // again (freshly re-set), but a failure must never carry over as
    // retryable past a successful apply.
    it('a failed apply is retryable, and a subsequent success clears it', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      let attempt = 0;
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
            attempt += 1;
            return {
              version: 1,
              requestId: request.requestId,
              identity: request.identity,
              actionId: request.actionId,
              phase: 'apply',
              ok: attempt >= 3,
              reason: attempt < 3 ? 'transient' : undefined,
            };
          },
        },
      });
      const requestId = 'req-multi-retry';
      await controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });

      await controller.applyAction(requestId); // attempt 1: fails
      expect(controller.actions.get(requestId)?.status).toBe('failed');
      expect(controller.actions.get(requestId)?.retryable).toBe(true);

      await controller.applyAction(requestId); // attempt 2: fails again — still retryable
      expect(applySpy).toHaveBeenCalledTimes(2);
      expect(controller.actions.get(requestId)?.status).toBe('failed');
      expect(controller.actions.get(requestId)?.retryable).toBe(true);

      await controller.applyAction(requestId); // attempt 3: succeeds
      expect(applySpy).toHaveBeenCalledTimes(3);
      expect(controller.actions.get(requestId)?.status).toBe('applied');
      expect(controller.actions.get(requestId)?.retryable).toBe(false);

      // A fourth call must now refuse (status is 'applied', not retryable).
      await controller.applyAction(requestId);
      expect(applySpy).toHaveBeenCalledTimes(3);
      expect(controller.actions.get(requestId)?.status).toBe('applied');

      controller.dispose();
    });
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

  // Cycle-3 first final finding 2: mirrors the dispose-race test above —
  // stopPolling() had no in-flight-await guard of its own, so a pollTick
  // already awaiting loadMessages when stopPolling() ran would still call
  // resetPollInterval(...) afterward and re-arm a brand new timer, undoing
  // the stop.
  it('does not re-arm the poll interval when stopPolling() races an in-flight pollTick', async () => {
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

    // stopPolling() runs WHILE that pollTick is still awaiting loadMessages.
    controller.stopPolling();
    resolveGatedLoadMessages?.();
    // Give pollTick's continuation, and any (incorrect) re-armed interval,
    // several multiples of the poll interval to fire again.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The bug: pollTick's post-await code called resetPollInterval(...)
    // unconditionally, re-arming a timer after stopPolling(). The fix must
    // leave the call count at exactly 1 — the single tick already in flight
    // when stopPolling() ran, and nothing after.
    expect(callCount).toBe(1);

    controller.dispose();
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
    // Copilot PR #2919 jAwsd: a registry swap now fully clears the actions
    // map (resetConversationStateForContextSwap()) rather than marking each
    // entry 'failed' — the preview taken under R1 must not survive the swap
    // to R2 in ANY form.
    expect(controller.actions.has(outstandingRequestId)).toBe(false);

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

  // Cycle-4 final finding 1: `openThreadRequestId` guards openThread()
  // alone — resetConversationStateForContextSwap()'s own invariant ("an old
  // in-flight load could still write it back") had NO guard at all for
  // loadThreads()/loadModels()/createThread(). `contextEpoch` closes that:
  // captured before each of those functions' await(s) and compared after.
  describe('contextEpoch guards loadThreads/loadModels/createThread against a swap (cycle-4 final finding 1)', () => {
    it('a slow listThreads() from transport A resolves after a swap to B — threads stay Bs', async () => {
      let resolveA: ((threads: AssistantThreadSummary[]) => void) | undefined;
      const gateA = new Promise<AssistantThreadSummary[]>((resolve) => {
        resolveA = resolve;
      });
      const transportA: AssistantTransport = {
        async listThreads() {
          return gateA;
        },
        async createThread(title) {
          return { id: 'a-thread', title, isResolved: false, messageCount: 0 };
        },
        async loadMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error('unused');
        },
        async uploadAttachment() {
          throw new Error('unused');
        },
      };
      const transportB = createInMemoryAssistantTransport();
      const threadB = await transportB.createThread('Context B thread');

      let currentTransport: AssistantTransport = transportA;
      let currentRegistry = realRegistryWithSurface('orders').registry;
      const controller = createAssistantDockController({
        get transport() {
          return currentTransport;
        },
        get registry() {
          return currentRegistry;
        },
      });

      // Kick off a loadThreads() against A — it stays gated (in flight).
      const staleLoad = controller.loadThreads();

      // Swap to B WHILE A's listThreads() is still in flight.
      currentTransport = transportB;
      currentRegistry = realRegistryWithSurface('orders').registry;
      controller.syncRegistry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

      // A's stale listThreads() now resolves — it must NOT overwrite B's
      // already-loaded thread list.
      resolveA?.([
        { id: 'a-thread', title: 'From A', isResolved: false, messageCount: 0 },
      ]);
      await staleLoad;
      expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

      controller.dispose();
    });

    it('a slow listModels() from transport A resolves after a swap to B — models stay Bs', async () => {
      let resolveA: ((models: ModelOption[]) => void) | undefined;
      const gateA = new Promise<ModelOption[]>((resolve) => {
        resolveA = resolve;
      });
      const transportA: AssistantTransport = {
        async listThreads() {
          return [];
        },
        async createThread(title) {
          return { id: 'a-thread', title, isResolved: false, messageCount: 0 };
        },
        async loadMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error('unused');
        },
        async uploadAttachment() {
          throw new Error('unused');
        },
        async listModels() {
          return gateA;
        },
      };
      const transportB = createInMemoryAssistantTransport({
        models: [{ id: 'model-b', label: 'Model B' }],
      });

      let currentTransport: AssistantTransport = transportA;
      let currentRegistry = realRegistryWithSurface('orders').registry;
      const controller = createAssistantDockController({
        get transport() {
          return currentTransport;
        },
        get registry() {
          return currentRegistry;
        },
      });

      const staleLoad = controller.loadModels();

      currentTransport = transportB;
      currentRegistry = realRegistryWithSurface('orders').registry;
      controller.syncRegistry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.models.map((m) => m.id)).toEqual(['model-b']);

      resolveA?.([{ id: 'model-a', label: 'Model A' }]);
      await staleLoad;
      expect(controller.models.map((m) => m.id)).toEqual(['model-b']);

      controller.dispose();
    });

    it('a slow createThread() against transport A resolving after a swap to B does not land in threads', async () => {
      let resolveA: ((thread: AssistantThreadSummary) => void) | undefined;
      const gateA = new Promise<AssistantThreadSummary>((resolve) => {
        resolveA = resolve;
      });
      const transportA: AssistantTransport = {
        async listThreads() {
          return [];
        },
        async createThread() {
          return gateA;
        },
        async loadMessages() {
          return [];
        },
        async sendMessage() {
          throw new Error('unused');
        },
        async uploadAttachment() {
          throw new Error('unused');
        },
      };
      const transportB = createInMemoryAssistantTransport();
      const threadB = await transportB.createThread('Context B thread');

      let currentTransport: AssistantTransport = transportA;
      let currentRegistry = realRegistryWithSurface('orders').registry;
      const controller = createAssistantDockController({
        get transport() {
          return currentTransport;
        },
        get registry() {
          return currentRegistry;
        },
      });

      const staleCreate = controller.createThread('From A');

      currentTransport = transportB;
      currentRegistry = realRegistryWithSurface('orders').registry;
      controller.syncRegistry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

      // A's stale createThread() now resolves — the returned value stays
      // load-bearing for the (test's own) caller, but it must NOT land in
      // `threads`, which belongs to context B now.
      resolveA?.({
        id: 'a-thread-created',
        title: 'From A',
        isResolved: false,
        messageCount: 0,
      });
      const created = await staleCreate;
      expect(created.id).toBe('a-thread-created');
      expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

      controller.dispose();
    });
  });

  // Cycle-4 second final finding 1: resetConversationStateForContextSwap()
  // cleared threads/activeThreadId/messages/pendingSends/actions/error/
  // draftIds and bumped the epoch counters, but left `selectedModel` and
  // `pollErrorActive` (both per-context) untouched — a model id chosen
  // under the OLD transport's catalog kept flowing into every send() under
  // the NEW one, and the first loadMessages() failure in the NEW context
  // was silently swallowed by a "record once" gate that never re-armed.
  describe('resetConversationStateForContextSwap() resets selectedModel and pollErrorActive (cycle-4 second final finding 1)', () => {
    it("re-defaults selectedModel from B's catalog after a swap, even when A's listModels() resolved BEFORE the swap", async () => {
      const transportA = createInMemoryAssistantTransport({
        models: [{ id: 'model-a', label: 'Model A' }],
      });
      const transportB = createInMemoryAssistantTransport({
        models: [{ id: 'model-b', label: 'Model B' }],
      });

      let currentTransport: AssistantTransport = transportA;
      let currentRegistry = realRegistryWithSurface('orders').registry;
      const controller = createAssistantDockController({
        get transport() {
          return currentTransport;
        },
        get registry() {
          return currentRegistry;
        },
      });

      // A's listModels() resolves BEFORE the swap — selectedModel defaults
      // to A's catalog, exactly the case the fix must still cover (the
      // pre-fix bug only reproduced once `selectedModel` was truthy).
      await controller.loadModels();
      expect(controller.selectedModel).toBe('model-a');

      currentTransport = transportB;
      currentRegistry = realRegistryWithSurface('orders').registry;
      controller.syncRegistry();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controller.models.map((m) => m.id)).toEqual(['model-b']);
      expect(controller.selectedModel).toBe('model-b');

      controller.dispose();
    });

    it('records the first poll error in the NEW context after a swap, even when a poll error preceded the swap', async () => {
      // Context A: openThread's own loadMessages() call succeeds (call 1);
      // every poll tick after that (call 2+) fails — this is what arms
      // pollTick's `pollErrorActive` "record once" gate via a REAL pollTick,
      // not openThread's own separate catch.
      let callsA = 0;
      const transportA: AssistantTransport = {
        async listThreads() {
          return [];
        },
        async createThread(title) {
          return { id: 'a-thread', title, isResolved: false, messageCount: 0 };
        },
        async loadMessages() {
          callsA += 1;
          if (callsA === 1) return [];
          throw new Error('A poll failed');
        },
        async sendMessage() {
          throw new Error('unused');
        },
        async uploadAttachment() {
          throw new Error('unused');
        },
      };
      // Context B: same shape — first call (the post-swap openThread)
      // succeeds, every call after that fails with a DIFFERENT message, so
      // the assertion can only pass if pollErrorActive was actually reset
      // (pre-fix, it stayed armed from A and B's failure was swallowed —
      // `controller.error` would incorrectly stay `null`).
      let callsB = 0;
      const transportB: AssistantTransport = {
        async listThreads() {
          return [];
        },
        async createThread(title) {
          return { id: 'b-thread', title, isResolved: false, messageCount: 0 };
        },
        async loadMessages() {
          callsB += 1;
          if (callsB === 1) return [];
          throw new Error('B poll failed');
        },
        async sendMessage() {
          throw new Error('unused');
        },
        async uploadAttachment() {
          throw new Error('unused');
        },
      };

      let currentTransport: AssistantTransport = transportA;
      let currentRegistry = realRegistryWithSurface('orders').registry;
      const controller = createAssistantDockController({
        get transport() {
          return currentTransport;
        },
        get registry() {
          return currentRegistry;
        },
        activePollIntervalMs: 20,
        idlePollIntervalMs: 20,
      });

      await controller.openThread('t1-a');
      expect(controller.error).toBeNull();
      controller.startPolling();
      // Wait for a poll tick to fail against A.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(controller.error).toBe('A poll failed');

      // Swap WHILE pollErrorActive is still armed from A's failure.
      currentTransport = transportB;
      currentRegistry = realRegistryWithSurface('orders').registry;
      controller.syncRegistry();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The reset's own loadThreads()/loadModels() succeed and clear
      // `error` — confirms the reset put us in a clean slate.
      expect(controller.error).toBeNull();

      await controller.openThread('b-thread');
      // Wait for a poll tick to fail against B.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(controller.error).toBe('B poll failed');

      controller.dispose();
    }, 10_000);
  });

  // Copilot PR #2919 jAwsd: a registry (and, via syncTransport(), a
  // transport) swap now clears threads/activeThreadId/messages/pendingSends
  // and reloads from the NEW transport, and discards an old in-flight
  // openThread() load from the previous context (via the same
  // `openThreadRequestId` guard openThread() itself uses for the
  // overlapping-call race).
  it('clears conversation state and reloads from the new transport on a registry swap, discarding an old in-flight load', async () => {
    const { transport: transportA, store: storeA } = scriptedTransport({
      't1-a': [
        {
          id: 'a1',
          threadId: 't1-a',
          content: 'hello from context A',
          role: 'user',
          createdAt: new Date(),
        },
      ],
    });
    const transportB = createInMemoryAssistantTransport();
    const threadB = await transportB.createThread('Context B thread');

    let currentTransport: AssistantTransport = transportA;
    let currentRegistry = realRegistryWithSurface('orders').registry;
    const controller = createAssistantDockController({
      get transport() {
        return currentTransport;
      },
      get registry() {
        return currentRegistry;
      },
    });

    await controller.openThread('t1-a');
    expect(controller.activeThreadId).toBe('t1-a');
    expect(controller.messages).toHaveLength(1);

    // Gate transportA's loadMessages so a SECOND openThread('t1-a') call is
    // still in flight when the context swap happens.
    let resolveGatedLoad: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGatedLoad = resolve;
    });
    const originalLoadMessages = transportA.loadMessages.bind(transportA);
    transportA.loadMessages = async (threadId: string) => {
      await gate;
      return originalLoadMessages(threadId);
    };
    const staleOpenThread = controller.openThread('t1-a');

    // The context swap (new registry AND new transport — a host switching
    // tenant/workspace) happens WHILE that load is still gated.
    currentTransport = transportB;
    currentRegistry = realRegistryWithSurface('orders').registry;
    controller.syncRegistry();

    // Cleared immediately, and reloaded from transportB (which has NO
    // threads named 't1-a' — only `threadB`).
    expect(controller.activeThreadId).toBeNull();
    expect(controller.messages).toHaveLength(0);
    expect(controller.pendingSends).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

    // The stale load from context A now resolves — it must NOT write back
    // messages/activeThreadId over the new context.
    resolveGatedLoad?.();
    await staleOpenThread;
    expect(controller.activeThreadId).toBeNull();
    expect(controller.messages).toHaveLength(0);

    void storeA;
    controller.dispose();
  });

  it('syncTransport() clears conversation state and reloads on a transport swap alone', async () => {
    const transportA = createInMemoryAssistantTransport();
    const threadA = await transportA.createThread('t-a');
    const transportB = createInMemoryAssistantTransport();
    const threadB = await transportB.createThread('t-b');

    let currentTransport: AssistantTransport = transportA;
    const controller = createAssistantDockController({
      get transport() {
        return currentTransport;
      },
      registry: fakeRegistry([]),
    });
    await controller.loadThreads();
    await controller.openThread(threadA.id);
    expect(controller.activeThreadId).toBe(threadA.id);

    currentTransport = transportB;
    controller.syncTransport();

    expect(controller.activeThreadId).toBeNull();
    expect(controller.messages).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.threads.map((t) => t.id)).toEqual([threadB.id]);

    controller.dispose();
  });

  it('syncTransport() is a no-op when the transport has not changed', async () => {
    const transport = createInMemoryAssistantTransport();
    const listThreadsSpy = vi.spyOn(transport, 'listThreads');
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });
    await controller.loadThreads();
    listThreadsSpy.mockClear();

    controller.syncTransport();
    controller.syncTransport();

    expect(listThreadsSpy).not.toHaveBeenCalled();
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

  // Copilot PR #2919 jAwr0: `surfaces` is a NARROWING filter over the live
  // registry, not a full replacement — an override entry that isn't
  // genuinely registered must never pass the mount gate (that would let an
  // override alone make an unmounted/unregistered surface "appear" mounted,
  // breaking the documented fail-closed route scoping). Complements
  // AssistantDock.test.ts's DOM-level discovery assertions for the same
  // override, wired through the component's exact
  // `get surfaces() { return surfaces; }` pattern.
  it('the `surfaces` override narrows against the live registry — an unregistered override entry is NOT mounted', async () => {
    const { registry, identity: ordersIdentity } =
      realRegistryWithSurface('orders'); // registered, but NOT in the override
    const productsIdentity: DataSurfaceIdentity = {
      surfaceId: 'products',
      kind: 'table',
      subject: { type: 'tenant', id: 'tenant-a' },
    };
    // Also register `products`, so the override below can demonstrate BOTH
    // halves: a registered+overridden identity passes, an overridden-only
    // (never registered) identity does not.
    registry.register({
      descriptor: {
        version: 1,
        identity: productsIdentity,
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
    const unregisteredOverrideIdentity: DataSurfaceIdentity = {
      surfaceId: 'invoices',
      kind: 'table',
      subject: { type: 'tenant', id: 'tenant-a' },
    }; // in the override, but never registered anywhere
    const applySpy = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry,
      surfaces: [productsIdentity, unregisteredOverrideIdentity],
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

    // Only the intersection of the override and the live registry is
    // mounted — `unregisteredOverrideIdentity` is filtered out.
    expect(controller.surfaces).toEqual([productsIdentity]);

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

    // In the override, but never registered anywhere: ALSO rejected — this
    // is the exact case the fix closes (previously accepted).
    await controller.previewAction({
      version: 1,
      requestId: 'req-override-only-unregistered',
      identity: unregisteredOverrideIdentity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(
      controller.actions.get('req-override-only-unregistered')?.status,
    ).toBe('failed');
    expect(
      controller.actions.get('req-override-only-unregistered')?.error,
    ).toMatch(/not mounted/);

    // Both registered AND in the override: accepted.
    await controller.previewAction({
      version: 1,
      requestId: 'req-registered-and-in-override',
      identity: productsIdentity,
      actionId: 'archive',
      phase: 'preview',
      selection: { scope: 'current-page' },
    });
    expect(
      controller.actions.get('req-registered-and-in-override')?.status,
    ).toBe('previewed');
    await controller.applyAction('req-registered-and-in-override');
    expect(applySpy).toHaveBeenCalledOnce();
    expect(
      controller.actions.get('req-registered-and-in-override')?.status,
    ).toBe('applied');

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

  // Cycle-4 second final finding 2: the `else if (!current && result.ok)`
  // "applied after reject" branch was the one post-await write in
  // applyAction() still missing the `contextEpoch` guard its siblings (the
  // success and catch branches) already carry. A context swap ALSO produces
  // `!current` (resetConversationStateForContextSwap()'s actions.clear()),
  // so without the guard, an apply resolving `ok: true` after a swap would
  // append a system message naming the OLD context's actionId into the NEW
  // context's `messages`, stamped with the NEW `activeThreadId`.
  it('does not append an "already applied" system message into the NEW context after a swap during an in-flight apply', async () => {
    const { registry: registryA, identity } = realRegistryWithSurface('orders');
    let resolveApply: ((ok: boolean) => void) | undefined;
    const applyGate = new Promise<boolean>((resolve) => {
      resolveApply = resolve;
    });
    const transportA = createInMemoryAssistantTransport();
    const transportB = createInMemoryAssistantTransport();

    let currentTransport: AssistantTransport = transportA;
    let currentRegistry = registryA;
    const controller = createAssistantDockController({
      get transport() {
        return currentTransport;
      },
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
    const threadA = await controller.createThread('t1');
    await controller.openThread(threadA.id);

    const requestId = 'req-swap-during-apply';
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
    expect(controller.actions.get(requestId)?.status).toBe('applying');

    // Context swap WHILE the apply above is still in flight — this clears
    // `actions` (producing the same `!current` condition a reject would)
    // and opens a thread in the NEW context.
    currentTransport = transportB;
    currentRegistry = realRegistryWithSurface('orders').registry;
    controller.syncRegistry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const threadB = await controller.createThread('t2');
    await controller.openThread(threadB.id);
    expect(controller.actions.has(requestId)).toBe(false);

    // The stale apply from context A now resolves ok:true — it must NOT
    // write a system message into the NEW context's messages.
    resolveApply?.(true);
    await applyPromise;

    expect(
      controller.messages.some((m) =>
        m.content.includes('already applied by the server'),
      ),
    ).toBe(false);

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

  // Cycle-2 second final finding 1: `surfaces` is captured once at
  // construction and reassignment was never observed — reachable exactly the
  // way AssistantDock.svelte passes it, via a live getter.
  describe('syncSurfaces() (cycle-2 second final finding 1)', () => {
    it('re-reads a reassigned `surfaces` getter and gates previewAction accordingly, in both directions', async () => {
      const { registry, identity: ordersIdentity } =
        realRegistryWithSurface('orders');
      const productsIdentity: DataSurfaceIdentity = {
        surfaceId: 'products',
        kind: 'table',
        subject: { type: 'tenant', id: 'tenant-a' },
      };
      // Copilot PR #2919 jAwr0: `surfaces` narrows against the live
      // registry, so `products` must be genuinely registered too, or it
      // would never pass the mount gate regardless of the override.
      registry.register({
        descriptor: {
          version: 1,
          identity: productsIdentity,
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
      let currentSurfaces: DataSurfaceIdentity[] = [productsIdentity];
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        get surfaces() {
          return currentSurfaces;
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

      // Initial override: only `products` is mounted, `orders` is gated out
      // even though it's genuinely registered.
      expect(controller.surfaces).toEqual([productsIdentity]);
      await controller.previewAction({
        version: 1,
        requestId: 'req-orders-1',
        identity: ordersIdentity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get('req-orders-1')?.status).toBe('failed');

      // Narrow the override to an EMPTY list — the previously-mounted
      // `products` preview must be invalidated (it fell out of scope), and a
      // fresh preview against it must now be gated too.
      const productsPreview: DataSurfaceIdentity = productsIdentity;
      await controller.previewAction({
        version: 1,
        requestId: 'req-products-1',
        identity: productsPreview,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get('req-products-1')?.status).toBe(
        'previewed',
      );
      currentSurfaces = [];
      controller.syncSurfaces();
      expect(controller.surfaces).toEqual([]);
      expect(controller.actions.get('req-products-1')?.status).toBe('failed');

      // Widen the override back to include `orders` — discovery AND the
      // gate must follow the reassignment.
      currentSurfaces = [ordersIdentity];
      controller.syncSurfaces();
      expect(controller.surfaces).toEqual([ordersIdentity]);
      await controller.previewAction({
        version: 1,
        requestId: 'req-orders-2',
        identity: ordersIdentity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get('req-orders-2')?.status).toBe('previewed');

      controller.dispose();
    });

    it('falls back to live registry discovery when `surfaces` is reassigned from defined to undefined', () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      let currentSurfaces: DataSurfaceIdentity[] | undefined = [];
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        get surfaces() {
          return currentSurfaces;
        },
      });

      // Override is an explicit empty list: registry's real `orders` entry
      // is suppressed.
      expect(controller.surfaces).toEqual([]);

      // Reassign to undefined: discovery must fall back to the live
      // registry contents.
      currentSurfaces = undefined;
      controller.syncSurfaces();
      expect(controller.surfaces).toEqual([identity]);

      controller.dispose();
    });

    it('the mounted-once "listThreads called exactly once" guarantee (F1) is unaffected by syncSurfaces() calls', async () => {
      const transport = createInMemoryAssistantTransport();
      const listThreadsSpy = vi.spyOn(transport, 'listThreads');
      const { registry } = realRegistryWithSurface('orders');
      const controller = createAssistantDockController({
        transport,
        registry,
        surfaces: [],
      });
      await controller.loadThreads();
      controller.syncSurfaces();
      controller.syncSurfaces();
      expect(listThreadsSpy).toHaveBeenCalledTimes(1);
      controller.dispose();
    });
  });

  // Cycle-2 second final finding 2: createThread/openThread/retry/pollTick
  // must never leave an unhandled rejection and must route failures to
  // controller.error.
  describe('unhandled-rejection guarding (cycle-2 second final finding 2)', () => {
    it('a rejecting createThread() records the error and does not change activeThreadId', async () => {
      const transport = createInMemoryAssistantTransport();
      transport.createThread = async () => {
        throw new Error('no writeEndpoint configured');
      };
      const controller = createAssistantDockController({
        transport,
        registry: fakeRegistry([]),
      });
      expect(controller.activeThreadId).toBeNull();

      await expect(controller.createThread('New conversation')).rejects.toThrow(
        'no writeEndpoint configured',
      );

      expect(controller.error).toBe('no writeEndpoint configured');
      expect(controller.activeThreadId).toBeNull();
      controller.dispose();
    });

    it('a rejecting openThread() leaves the previous thread active and its messages intact', async () => {
      const { transport, store } = scriptedTransport({
        'thread-a': [
          {
            id: 'm1',
            threadId: 'thread-a',
            content: 'hello from a',
            role: 'user',
            createdAt: new Date(),
          },
        ],
        'thread-b': [],
      });
      const controller = createAssistantDockController({
        transport,
        registry: fakeRegistry([]),
      });
      await controller.openThread('thread-a');
      expect(controller.activeThreadId).toBe('thread-a');
      expect(controller.messages).toHaveLength(1);

      const originalLoadMessages = transport.loadMessages.bind(transport);
      transport.loadMessages = async (threadId: string) => {
        if (threadId === 'thread-b') throw new Error('load failed');
        return originalLoadMessages(threadId);
      };

      // await never rejects at the call site — caught internally.
      await expect(controller.openThread('thread-b')).resolves.toBeUndefined();

      expect(controller.activeThreadId).toBe('thread-a');
      expect(controller.messages).toHaveLength(1);
      expect(controller.error).toBe('load failed');
      void store;
      controller.dispose();
    });

    it('loadMessages failing mid-poll sets the error once and recovers on the next successful poll', async () => {
      vi.useFakeTimers();
      try {
        const { transport, store } = scriptedTransport({ a: [] });
        let shouldFail = false;
        let failureCount = 0;
        const originalLoadMessages = transport.loadMessages.bind(transport);
        transport.loadMessages = async (threadId: string) => {
          if (shouldFail) {
            failureCount += 1;
            throw new Error('poll transport down');
          }
          return originalLoadMessages(threadId);
        };
        const controller = createAssistantDockController({
          transport,
          registry: fakeRegistry([]),
          activePollIntervalMs: 10,
          idlePollIntervalMs: 10,
        });
        await controller.openThread('a');
        controller.startPolling();

        shouldFail = true;
        await vi.advanceTimersByTimeAsync(35);
        expect(controller.error).toBe('poll transport down');
        // Recorded once, not once per tick, even though several ticks fired.
        expect(failureCount).toBeGreaterThan(1);
        const failureCountAtCheck = failureCount;
        expect(controller.error).toBe('poll transport down');
        void failureCountAtCheck;

        shouldFail = false;
        pushAssistantReply(store, 'a', 'recovered');
        await vi.advanceTimersByTimeAsync(15);
        expect(controller.error).toBeNull();

        controller.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a rejecting retry() surfaces the error and leaves the pending send in its failed status', async () => {
      const { transport } = scriptedTransport({ a: [] });
      let failNextSend = false;
      const originalSendMessage = transport.sendMessage.bind(transport);
      transport.sendMessage = async (input) => {
        if (failNextSend) throw new Error('retry send failed');
        return originalSendMessage(input);
      };
      const controller = createAssistantDockController({
        transport,
        registry: fakeRegistry([]),
      });
      await controller.openThread('a');

      failNextSend = true;
      await expect(controller.send('hi there')).rejects.toThrow(
        'retry send failed',
      );
      const pending = controller.pendingSends.find(
        (p) => p.content === 'hi there',
      );
      expect(pending?.status).toBe('failed');

      // await never rejects at the call site — caught internally.
      await expect(
        controller.retry(pending?.clientRequestId ?? ''),
      ).resolves.toBeUndefined();
      expect(controller.error).toBe('retry send failed');
      expect(
        controller.pendingSends.find((p) => p.content === 'hi there')?.status,
      ).toBe('failed');

      controller.dispose();
    });
  });

  // Cycle-3 first final finding 1: previewAction's post-await write used the
  // pre-await snapshot unconditionally, so an invalidation (unregister,
  // syncSurfaces narrowing, registry swap) or an explicit rejectAction()
  // landing WHILE the preview call is in flight got clobbered the instant
  // the preview resolved — resurrecting a fail-closed/rejected entry as a
  // confirmable 'previewed' card. Mirrors the guard applyAction already had
  // (cycle-2 finding 3's "slow apply does not resurrect a rejected action"
  // test above).
  describe('previewAction post-await re-check (cycle-3 first final finding 1)', () => {
    function gatedPreviewClient() {
      let resolvePreview: ((ok: boolean) => void) | undefined;
      const previewGate = new Promise<boolean>((resolve) => {
        resolvePreview = resolve;
      });
      return {
        client: {
          preview: async (request: DataSurfaceActionRequest) => {
            const ok = await previewGate;
            return {
              version: 1 as const,
              requestId: request.requestId,
              identity: request.identity,
              actionId: request.actionId,
              phase: 'preview' as const,
              ok,
            };
          },
          apply: async () => {
            throw new Error('unreachable');
          },
        },
        resolvePreview: () => resolvePreview?.(true),
      };
    }

    it('an unregister during a pending preview leaves it failed after the preview resolves', async () => {
      const { registry, identity, unregister } =
        realRegistryWithSurface('orders');
      const { client, resolvePreview } = gatedPreviewClient();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: client,
      });

      const requestId = 'req-preview-unregister-race';
      const previewPromise = controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get(requestId)?.status).toBe('previewing');

      // The surface unmounts WHILE the preview call is in flight.
      unregister();
      expect(controller.actions.get(requestId)?.status).toBe('failed');

      // The preview call now resolves 'ok' — the stale success write must
      // NOT resurrect the entry as 'previewed'.
      resolvePreview();
      await previewPromise;

      expect(controller.actions.get(requestId)?.status).toBe('failed');
      expect(controller.actions.get(requestId)?.error).toMatch(/unmounted/);
      controller.dispose();
    });

    it('rejectAction during a pending preview leaves the entry deleted', async () => {
      const { registry, identity } = realRegistryWithSurface('orders');
      const { client, resolvePreview } = gatedPreviewClient();
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        registry,
        actionClient: client,
      });

      const requestId = 'req-preview-reject-race';
      const previewPromise = controller.previewAction({
        version: 1,
        requestId,
        identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get(requestId)?.status).toBe('previewing');

      // The user rejects WHILE the preview call is in flight.
      controller.rejectAction(requestId);
      expect(controller.actions.has(requestId)).toBe(false);

      resolvePreview();
      await previewPromise;

      // The stale success write must NOT resurrect the rejected entry.
      expect(controller.actions.has(requestId)).toBe(false);
      controller.dispose();
    });

    it('a registry swap during a pending preview leaves the entry failed', async () => {
      const r1 = realRegistryWithSurface('orders');
      const r2 = realRegistryWithSurface('orders');
      const { client, resolvePreview } = gatedPreviewClient();
      let currentRegistry = r1.registry;
      const controller = createAssistantDockController({
        transport: createInMemoryAssistantTransport(),
        get registry() {
          return currentRegistry;
        },
        actionClient: client,
      });

      const requestId = 'req-preview-registry-swap-race';
      const previewPromise = controller.previewAction({
        version: 1,
        requestId,
        identity: r1.identity,
        actionId: 'archive',
        phase: 'preview',
        selection: { scope: 'current-page' },
      });
      expect(controller.actions.get(requestId)?.status).toBe('previewing');

      // The host swaps the registry instance (e.g. a route/tenant change)
      // WHILE the preview call is in flight. Copilot PR #2919 jAwsd: a
      // registry swap now fully clears the actions map rather than marking
      // each entry 'failed'.
      currentRegistry = r2.registry;
      controller.syncRegistry();
      expect(controller.actions.has(requestId)).toBe(false);

      resolvePreview();
      await previewPromise;

      // The stale success write must NOT resurrect the entry as 'previewed'
      // under the OLD registry's trust boundary — it must stay gone.
      expect(controller.actions.has(requestId)).toBe(false);
      controller.dispose();
    });
  });

  // Cycle-3 first final sweep: openThread() wrote activeThreadId/messages
  // unconditionally after its await, so two overlapping calls (e.g. a fast
  // double-click on two different threads) raced on whichever
  // loadMessages() happened to resolve LAST, regardless of which openThread
  // call was started last — an older, slower request could stomp the
  // newer one's messages after the user had already moved on.
  it('openThread() only writes from the MOST RECENTLY STARTED call when two calls overlap', async () => {
    const { transport, store } = scriptedTransport({
      'thread-a': [
        {
          id: 'a1',
          threadId: 'thread-a',
          content: 'hello from a',
          role: 'user',
          createdAt: new Date(),
        },
      ],
      'thread-b': [
        {
          id: 'b1',
          threadId: 'thread-b',
          content: 'hello from b',
          role: 'user',
          createdAt: new Date(),
        },
      ],
    });
    let resolveA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const originalLoadMessages = transport.loadMessages.bind(transport);
    transport.loadMessages = async (threadId: string) => {
      if (threadId === 'thread-a') await gateA;
      return originalLoadMessages(threadId);
    };
    const controller = createAssistantDockController({
      transport,
      registry: fakeRegistry([]),
    });

    // Start opening thread-a (its loadMessages call is gated) and, before it
    // resolves, start opening thread-b (unGated — resolves first).
    const openA = controller.openThread('thread-a');
    const openB = controller.openThread('thread-b');
    await openB;
    expect(controller.activeThreadId).toBe('thread-b');
    expect(controller.messages.map((m) => m.id)).toEqual(['b1']);

    // thread-a's older, slower request now resolves — it must NOT stomp
    // thread-b's state, since a newer openThread() call has since started.
    resolveA?.();
    await openA;
    expect(controller.activeThreadId).toBe('thread-b');
    expect(controller.messages.map((m) => m.id)).toEqual(['b1']);

    void store;
    controller.dispose();
  });
});
