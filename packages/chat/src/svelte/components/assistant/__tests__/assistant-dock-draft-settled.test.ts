// @vitest-environment jsdom
/**
 * #2991: a host can seed the composer draft (`initialDraft`,
 * `controller.setDraft`) without sending it, and pass a composer
 * `placeholder` through the dock. Also the `onActionSettled` /
 * `onactionsettled` outcome callback for applied, rejected, and unknown
 * action outcomes.
 */
import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistantComposer from '../AssistantComposer.svelte';
import AssistantDock from '../AssistantDock.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';
import {
  type AssistantActionClient,
  type AssistantActionOutcome,
  type AssistantDockController,
  createAssistantDockController,
} from '../create-assistant-dock-controller.svelte.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'assets',
  kind: 'table',
  subject: { type: 'tenant', id: 'tenant-a' },
};

function registryWithSurface() {
  const registry = createDataSurfaceRegistry();
  const descriptor: DataSurfaceDescriptor = {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Assets',
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

function proposal(requestId = 'req-1'): DataSurfaceActionRequest {
  return {
    version: 1,
    requestId,
    identity,
    actionId: 'approve',
    phase: 'preview',
    selection: { scope: 'explicit-ids', rowIds: ['row-1'] },
  };
}

function result(
  request: DataSurfaceActionRequest,
  phase: 'preview' | 'apply',
  ok: boolean,
  extra: Partial<DataSurfaceActionResult> = {},
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase,
    ok,
    ...extra,
  };
}

function client(apply: AssistantActionClient['apply']): AssistantActionClient {
  return {
    preview: async (request) =>
      result(request, 'preview', true, { confirmationToken: 'tok' }),
    apply,
  };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Message') as HTMLTextAreaElement;
}

describe('AssistantComposer value (#2991)', () => {
  it('renders a seeded value without sending it', () => {
    const onsend = vi.fn();
    render(AssistantComposer, {
      props: { onsend, onupload: vi.fn(), value: 'Remove the background' },
    });
    expect(textarea()).toHaveValue('Remove the background');
    expect(onsend).not.toHaveBeenCalled();
  });

  it('sends the edited seed only when the user sends', async () => {
    const onsend = vi.fn().mockResolvedValue(undefined);
    render(AssistantComposer, {
      props: { onsend, onupload: vi.fn(), value: 'Remove the background' },
    });
    await userEvent.type(textarea(), ' please');
    expect(onsend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onsend).toHaveBeenCalledWith('Remove the background please', []);
    expect(textarea()).toHaveValue('');
  });
});

describe('controller draft (#2991)', () => {
  it('starts from initialDraft and setDraft replaces it without sending', async () => {
    const transport = createInMemoryAssistantTransport();
    const sendMessage = vi.spyOn(transport, 'sendMessage');
    const controller = createAssistantDockController({
      transport,
      registry: registryWithSurface(),
      initialDraft: 'first',
    });
    expect(controller.draft).toBe('first');
    controller.setDraft('second');
    expect(controller.draft).toBe('second');
    expect(sendMessage).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps the draft across a registry or transport swap', () => {
    let registry = registryWithSurface();
    let transport = createInMemoryAssistantTransport();
    const controller = createAssistantDockController({
      get transport() {
        return transport;
      },
      get registry() {
        return registry;
      },
      initialDraft: 'unsent text',
    });
    registry = registryWithSurface();
    controller.syncRegistry();
    expect(controller.draft).toBe('unsent text');
    transport = createInMemoryAssistantTransport();
    controller.syncTransport();
    expect(controller.draft).toBe('unsent text');
    controller.dispose();
  });

  it('defaults to an empty draft', () => {
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
    });
    expect(controller.draft).toBe('');
    controller.dispose();
  });
});

describe('AssistantDock draft seeding and placeholder (#2991)', () => {
  it('renders initialDraft in the composer and never sends it', async () => {
    const transport = createInMemoryAssistantTransport();
    const sendMessage = vi.spyOn(transport, 'sendMessage');
    render(AssistantDock, {
      props: {
        transport,
        registry: registryWithSurface(),
        initialDraft: 'Remove the background from this photo',
      },
    });
    expect(textarea()).toHaveValue('Remove the background from this photo');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the host seed the draft through controller.setDraft', async () => {
    let hostController: AssistantDockController | undefined;
    const transport = createInMemoryAssistantTransport();
    const sendMessage = vi.spyOn(transport, 'sendMessage');
    render(AssistantDock, {
      props: {
        transport,
        registry: registryWithSurface(),
        oncontroller: (c: AssistantDockController) => {
          hostController = c;
        },
      },
    });
    expect(textarea()).toHaveValue('');
    hostController?.setDraft('Describe the edit');
    flushSync();
    expect(textarea()).toHaveValue('Describe the edit');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reflects typed text back into controller.draft', async () => {
    let hostController: AssistantDockController | undefined;
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
        initialDraft: 'seed',
        oncontroller: (c: AssistantDockController) => {
          hostController = c;
        },
      },
    });
    // The composer is disabled until a thread is open; open one first.
    const thread = await hostController?.createThread('t');
    if (thread) await hostController?.openThread(thread.id);
    flushSync();
    await userEvent.type(textarea(), ' more');
    expect(hostController?.draft).toBe('seed more');
  });

  it('forwards composerPlaceholder to the composer', () => {
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
        composerPlaceholder: 'Describe the image edit to generate…',
      },
    });
    expect(textarea()).toHaveAttribute(
      'placeholder',
      'Describe the image edit to generate…',
    );
  });

  it('keeps the composer default placeholder when none is passed', () => {
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
      },
    });
    expect(textarea()).toHaveAttribute('placeholder', 'Ask the assistant…');
  });
});

describe('controller onActionSettled', () => {
  function settledController(
    apply: AssistantActionClient['apply'],
    onActionSettled: (
      request: DataSurfaceActionRequest,
      outcome: AssistantActionOutcome,
    ) => void,
  ) {
    return createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: client(apply),
      onActionSettled,
    });
  }

  it('reports an accepted apply as applied with the server result', async () => {
    const onActionSettled = vi.fn();
    const controller = settledController(
      async (request) =>
        result(request, 'apply', true, { details: { assetId: 'srv-1' } }),
      onActionSettled,
    );
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    expect(onActionSettled).toHaveBeenCalledTimes(1);
    const [request, outcome] = onActionSettled.mock.calls[0];
    expect(request.phase).toBe('apply');
    expect(outcome.status).toBe('applied');
    expect(outcome.result.details).toEqual({ assetId: 'srv-1' });
    controller.dispose();
  });

  it('reports a server refusal as rejected by the server', async () => {
    const onActionSettled = vi.fn();
    const controller = settledController(
      async (request) =>
        result(request, 'apply', false, { reason: 'stale_revision' }),
      onActionSettled,
    );
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    expect(onActionSettled).toHaveBeenCalledTimes(1);
    const outcome = onActionSettled.mock.calls[0][1];
    expect(outcome).toMatchObject({ status: 'rejected', by: 'server' });
    expect(outcome.result.reason).toBe('stale_revision');
    controller.dispose();
  });

  it('reports a user reject as rejected by the user', async () => {
    const onActionSettled = vi.fn();
    const controller = settledController(
      async (request) => result(request, 'apply', true),
      onActionSettled,
    );
    await controller.previewAction(proposal());
    controller.rejectAction('req-1');
    expect(controller.actions.has('req-1')).toBe(false);
    expect(onActionSettled).toHaveBeenCalledTimes(1);
    const [request, outcome] = onActionSettled.mock.calls[0];
    expect(request.requestId).toBe('req-1');
    expect(outcome).toEqual({ status: 'rejected', by: 'user' });
    controller.dispose();
  });

  it('reports a thrown apply as unknown, then the later decision', async () => {
    const onActionSettled = vi.fn();
    let mode: 'throw' | 'ok' = 'throw';
    const controller = settledController(async (request) => {
      if (mode === 'throw') throw new Error('network down');
      return result(request, 'apply', true);
    }, onActionSettled);
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    expect(onActionSettled).toHaveBeenCalledTimes(1);
    expect(onActionSettled.mock.calls[0][1]).toEqual({
      status: 'unknown',
      error: 'network down',
    });
    mode = 'ok';
    await controller.applyAction('req-1');
    expect(onActionSettled).toHaveBeenCalledTimes(2);
    expect(onActionSettled.mock.calls[1][1].status).toBe('applied');
    controller.dispose();
  });

  it('reports an unknown-outcome reason as unknown with the result', async () => {
    const onActionSettled = vi.fn();
    const controller = settledController(
      async (request) =>
        result(request, 'apply', false, { reason: 'idempotency_in_progress' }),
      onActionSettled,
    );
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    const outcome = onActionSettled.mock.calls[0][1];
    expect(outcome.status).toBe('unknown');
    expect(outcome.result.reason).toBe('idempotency_in_progress');
    controller.dispose();
  });

  it('does not report a refused reject while the outcome is unknown', async () => {
    const onActionSettled = vi.fn();
    const controller = settledController(async () => {
      throw new Error('timeout');
    }, onActionSettled);
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    onActionSettled.mockClear();
    controller.rejectAction('req-1');
    expect(controller.actions.has('req-1')).toBe(true);
    expect(onActionSettled).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('does not report an apply that lands after a context swap', async () => {
    const onActionSettled = vi.fn();
    let release!: () => void;
    let registry = registryWithSurface();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      get registry() {
        return registry;
      },
      actionClient: client(async (request) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result(request, 'apply', true);
      }),
      onActionSettled,
    });
    await controller.previewAction(proposal());
    const applying = controller.applyAction('req-1');
    registry = registryWithSurface();
    controller.syncRegistry();
    release();
    await applying;
    expect(onActionSettled).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('keeps action state when the host callback throws', async () => {
    const onActionSettled = vi.fn(() => {
      throw new Error('host bug');
    });
    const controller = settledController(
      async (request) => result(request, 'apply', true),
      onActionSettled,
    );
    await controller.previewAction(proposal());
    await expect(controller.applyAction('req-1')).resolves.toBeUndefined();
    expect(controller.actions.get('req-1')?.status).toBe('applied');
    await controller.previewAction(proposal('req-2'));
    expect(() => controller.rejectAction('req-2')).not.toThrow();
    expect(controller.actions.has('req-2')).toBe(false);
    controller.dispose();
  });

  it('still calls onActionApplied alongside onActionSettled', async () => {
    const onActionApplied = vi.fn();
    const onActionSettled = vi.fn();
    const controller = createAssistantDockController({
      transport: createInMemoryAssistantTransport(),
      registry: registryWithSurface(),
      actionClient: client(async (request) => result(request, 'apply', true)),
      onActionApplied,
      onActionSettled,
    });
    await controller.previewAction(proposal());
    await controller.applyAction('req-1');
    expect(onActionApplied).toHaveBeenCalledTimes(1);
    expect(onActionSettled).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('AssistantDock onactionsettled', () => {
  it('reports a Reject click to the host', async () => {
    let hostController: AssistantDockController | undefined;
    const onactionsettled = vi.fn();
    render(AssistantDock, {
      props: {
        transport: createInMemoryAssistantTransport(),
        registry: registryWithSurface(),
        actionClient: client(async (request) => result(request, 'apply', true)),
        oncontroller: (c: AssistantDockController) => {
          hostController = c;
        },
        onactionsettled,
      },
    });
    await hostController?.previewAction(proposal());
    await userEvent.click(
      await screen.findByRole('button', { name: 'Reject' }),
    );
    await vi.waitFor(() => expect(onactionsettled).toHaveBeenCalledTimes(1));
    expect(onactionsettled.mock.calls[0][1]).toEqual({
      status: 'rejected',
      by: 'user',
    });
  });
});
