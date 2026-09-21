// @vitest-environment jsdom
/**
 * #2990: an apply that reached no server decision ("unknown outcome") is kept
 * apart from a refusal, keeps its idempotency key, and can only be retried
 * with that same key — never discarded or re-proposed under a fresh one.
 *
 * `idempotentServer` models the server adapter's contract: the first apply
 * for a key commits and records its result; any later apply with the same
 * key replays that result without committing again, and a different key is
 * a new mutation. `commits` is the double-apply oracle.
 */
import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';
import {
  ASSISTANT_ACTION_UNKNOWN_OUTCOME_REASONS,
  type AssistantActionClient,
  type AssistantDockController,
  createAssistantDockController,
} from '../create-assistant-dock-controller.svelte.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'orders',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

function registryWithSurface() {
  const registry = createDataSurfaceRegistry();
  const descriptor: DataSurfaceDescriptor = {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Orders',
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
  registry.register({
    descriptor,
    getSnapshot: () => ({ revision: 1, state: {} }),
  });
  return registry;
}

const REQUEST_ID = 'req-ship';

function proposal(): DataSurfaceActionRequest {
  return {
    version: 1,
    requestId: REQUEST_ID,
    identity,
    actionId: 'ship',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['order-1'] },
  };
}

function result(
  request: DataSurfaceActionRequest,
  phase: 'preview' | 'apply',
  ok: boolean,
  reason?: string,
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase,
    ok,
    ...(reason ? { reason } : {}),
  };
}

type Mode = 'commit' | 'commit-then-lose-response' | 'in-progress';

function idempotentServer() {
  const byKey = new Map<string, DataSurfaceActionResult>();
  const server = {
    commits: 0,
    applyCalls: 0,
    keys: [] as string[],
    mode: 'commit' as Mode,
    gate: undefined as Promise<void> | undefined,
    preview: vi.fn(async (request: DataSurfaceActionRequest) =>
      result(request, 'preview', true),
    ),
    client: undefined as unknown as AssistantActionClient,
  };
  server.client = {
    preview: server.preview,
    apply: async (request, key) => {
      server.applyCalls += 1;
      server.keys.push(key);
      if (server.gate) await server.gate;
      const replay = byKey.get(key);
      if (replay) return replay;
      if (server.mode === 'in-progress') {
        return result(request, 'apply', false, 'idempotency_in_progress');
      }
      server.commits += 1;
      const applied = result(request, 'apply', true);
      byKey.set(key, applied);
      if (server.mode === 'commit-then-lose-response') {
        throw new Error('network: response lost');
      }
      return applied;
    },
  };
  return server;
}

function setup(server = idempotentServer()) {
  const onActionApplied = vi.fn();
  const controller = createAssistantDockController({
    transport: createInMemoryAssistantTransport(),
    registry: registryWithSurface(),
    actionClient: server.client,
    onActionApplied,
  });
  return { controller, server, onActionApplied };
}

async function previewed(controller: AssistantDockController) {
  await controller.previewAction(proposal());
  expect(controller.actions.get(REQUEST_ID)?.status).toBe('previewed');
  return controller.actions.get(REQUEST_ID)?.idempotencyKey as string;
}

describe('unknown apply outcome vs refusal (#2990)', () => {
  it('marks a rejected apply (transport failure) as an unknown outcome and keeps its key', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);

    const state = controller.actions.get(REQUEST_ID);
    expect(state?.status).toBe('failed');
    expect(state?.outcomeUnknown).toBe(true);
    expect(state?.retryable).toBe(true);
    expect(state?.idempotencyKey).toBe(key);
    controller.dispose();
  });

  it.each(
    ASSISTANT_ACTION_UNKNOWN_OUTCOME_REASONS,
  )('treats ok:false with reason %s as an unknown outcome', async (reason) => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: {
        preview: async (request) => result(request, 'preview', true),
        apply: async (request) => result(request, 'apply', false, reason),
      },
    });
    await previewed(controller);
    await controller.applyAction(REQUEST_ID);
    expect(controller.actions.get(REQUEST_ID)?.outcomeUnknown).toBe(true);
    controller.dispose();
  });

  it.each([
    'denied',
    'not_found',
    'idempotency_conflict',
    'stale_revision',
    'confirmation_required',
    'confirmation_mismatch',
  ])('treats ok:false with reason %s as a refusal', async (reason) => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: {
        preview: async (request) => result(request, 'preview', true),
        apply: async (request) => result(request, 'apply', false, reason),
      },
    });
    await previewed(controller);
    await controller.applyAction(REQUEST_ID);
    const state = controller.actions.get(REQUEST_ID);
    expect(state?.status).toBe('failed');
    expect(state?.outcomeUnknown).toBe(false);
    // A refusal is terminal, so discarding it is allowed.
    controller.rejectAction(REQUEST_ID);
    expect(controller.actions.has(REQUEST_ID)).toBe(false);
    controller.dispose();
  });
});

describe('an unknown outcome cannot be discarded or re-keyed (#2990)', () => {
  it('refuses rejectAction and keeps the entry and key', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);

    controller.rejectAction(REQUEST_ID);
    expect(controller.actions.get(REQUEST_ID)?.idempotencyKey).toBe(key);
    expect(controller.actions.get(REQUEST_ID)?.outcomeUnknown).toBe(true);
    expect(controller.error).toMatch(/rejectAction refused/);
    controller.dispose();
  });

  it('refuses a new previewAction for the same request id', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);
    server.preview.mockClear();

    await controller.previewAction(proposal());
    expect(server.preview).not.toHaveBeenCalled();
    expect(controller.actions.get(REQUEST_ID)?.idempotencyKey).toBe(key);
    expect(controller.actions.get(REQUEST_ID)?.outcomeUnknown).toBe(true);
    expect(controller.error).toMatch(/previewAction refused/);
    controller.dispose();
  });

  it('refuses a new previewAction while an apply is in flight', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applying = controller.applyAction(REQUEST_ID);
    await controller.previewAction(proposal());
    expect(controller.actions.get(REQUEST_ID)?.status).toBe('applying');
    expect(controller.actions.get(REQUEST_ID)?.idempotencyKey).toBe(key);
    release();
    await applying;
    expect(controller.actions.get(REQUEST_ID)?.status).toBe('applied');
    expect(server.commits).toBe(1);
    controller.dispose();
  });
});

describe('same-key retry after an unknown outcome (#2990)', () => {
  it('replays with the same key, applies exactly once, and clears the flag', async () => {
    const { controller, server, onActionApplied } = setup();
    const key = await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);
    expect(server.commits).toBe(1);

    // The operator tries every discard/re-propose path, then retries.
    controller.rejectAction(REQUEST_ID);
    await controller.previewAction(proposal());
    server.mode = 'commit';
    await controller.applyAction(REQUEST_ID);

    const state = controller.actions.get(REQUEST_ID);
    expect(state?.status).toBe('applied');
    expect(state?.outcomeUnknown).toBe(false);
    expect(server.keys).toEqual([key, key]);
    expect(server.commits).toBe(1);
    expect(onActionApplied).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('keeps the key through idempotency_in_progress until the first attempt settles', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    server.mode = 'in-progress';
    await controller.applyAction(REQUEST_ID);
    await controller.applyAction(REQUEST_ID);
    expect(controller.actions.get(REQUEST_ID)?.outcomeUnknown).toBe(true);
    server.mode = 'commit';
    await controller.applyAction(REQUEST_ID);
    expect(controller.actions.get(REQUEST_ID)?.status).toBe('applied');
    expect(new Set(server.keys)).toEqual(new Set([key]));
    expect(server.commits).toBe(1);
    controller.dispose();
  });

  it('coalesces concurrent duplicate retries into one in-flight apply', async () => {
    const { controller, server } = setup();
    const key = await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);
    server.mode = 'commit';
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callsBefore = server.applyCalls;

    const retries = [
      controller.applyAction(REQUEST_ID),
      controller.applyAction(REQUEST_ID),
      controller.applyAction(REQUEST_ID),
    ];
    controller.rejectAction(REQUEST_ID);
    release();
    await Promise.all(retries);

    expect(server.applyCalls - callsBefore).toBe(1);
    expect(server.keys.every((k) => k === key)).toBe(true);
    expect(server.commits).toBe(1);
    expect(controller.actions.get(REQUEST_ID)?.status).toBe('applied');
    controller.dispose();
  });

  it('refuses a duplicate retry once the action is applied', async () => {
    const { controller, server } = setup();
    await previewed(controller);
    server.mode = 'commit-then-lose-response';
    await controller.applyAction(REQUEST_ID);
    server.mode = 'commit';
    await controller.applyAction(REQUEST_ID);
    const calls = server.applyCalls;
    await controller.applyAction(REQUEST_ID);
    expect(server.applyCalls).toBe(calls);
    expect(server.commits).toBe(1);
    controller.dispose();
  });
});

describe('AssistantDock unknown-outcome affordance (#2990)', () => {
  it('withdraws Reject and offers a same-key Check again', async () => {
    const server = idempotentServer();
    let dock: AssistantDockController | undefined;
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
        actionClient: server.client,
        oncontroller: (c: AssistantDockController) => {
          dock = c;
        },
      },
    });
    await dock?.previewAction(proposal());
    server.mode = 'commit-then-lose-response';
    await userEvent.click(
      await screen.findByRole('button', { name: 'Confirm' }),
    );

    const check = await screen.findByRole('button', { name: 'Check again' });
    expect(screen.getByRole('status')).toHaveTextContent(
      /couldn't confirm whether this change was applied/,
    );
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();

    server.mode = 'commit';
    await userEvent.click(check);
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull(),
    );
    expect(dock?.actions.get(REQUEST_ID)?.status).toBe('applied');
    expect(server.commits).toBe(1);
  });
});
